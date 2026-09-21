/**
 * The rules deciding whether a request may join the queue. Pure, so every
 * scenario is a literal — including the precedence between rules, which is
 * what decides whether a guest gets a useful message or a confusing one.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkoutProductName, type Settings } from '../src/config/settings.js';
import {
  priceFor,
  priceLabel,
  validateRequest,
  type RequestContext,
} from '../src/guest/validation.js';
import { RateLimiter, hashIp } from '../src/guest/session.js';
import type { Track } from '../src/spotify/types.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

function settings(over: Partial<Settings> = {}): Readonly<Settings> {
  return {
    price_cents: 0,
    currency: 'CAD',
    free_mode: true,
    fallback_playlist_uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M',
    device_name: 'Jukebox',
    volume_percent: 70,
    interrupt_current: false,
    push_lead_ms: 15_000,
    market: 'CA',
    accepting_requests: true,
    cooldown_seconds: 120,
    ip_requests_per_minute: 20,
    max_pending_per_guest: 2,
    max_queue_length: 25,
    block_duplicates: true,
    explicit_filter: false,
    max_track_duration_ms: 600_000,
    fundraiser_enabled: false,
    fundraiser_name: '',
    fundraiser_blurb: '',
    venue_name: 'The Back Room',
    venue_emoji: '',
    header_image_url: '',
    theme_accent: '#1db954',
    theme_background: '#0e0f13',
    theme_surface: '#181a21',
    theme_text: '#f2f3f7',
    queue_emoji: '',
    ...over,
  };
}

function track(over: Partial<Track> = {}): Track {
  return {
    id: 't1',
    uri: 'spotify:track:t1',
    name: 'Harvest Moon',
    artist: 'Neil Young',
    album: 'Harvest Moon',
    albumArtUrl: null,
    durationMs: 300_000,
    explicit: false,
    artistIds: ['a1'],
    ...over,
  };
}

const NOW = Date.parse('2026-09-19T22:00:00.000Z');

function ctx(over: Partial<RequestContext> = {}): RequestContext {
  return {
    track: track(),
    settings: settings(),
    pendingForGuest: 0,
    queueLength: 0,
    lastRequestAtMs: null,
    isDuplicate: false,
    ipLimited: false,
    blockedTrackIds: new Set(),
    blockedArtistIds: new Set(),
    now: NOW,
    ...over,
  };
}

describe('validateRequest', () => {
  it('accepts an ordinary request', () => {
    assert.deepEqual(validateRequest(ctx()), { ok: true });
  });

  describe('kill switch', () => {
    it('refuses everything when requests are switched off', () => {
      const result = validateRequest(ctx({ settings: settings({ accepting_requests: false }) }));
      assert.equal(result.ok, false);
      assert.equal(!result.ok && result.code, 'not_accepting');
    });

    it('takes precedence over every other rule', () => {
      // A blocked, explicit, over-long duplicate from a rate-limited guest
      // still gets told the room is closed — the simplest true answer.
      const result = validateRequest(
        ctx({
          settings: settings({ accepting_requests: false, explicit_filter: true }),
          track: track({ explicit: true, durationMs: 9_000_000 }),
          isDuplicate: true,
          ipLimited: true,
          blockedTrackIds: new Set(['t1']),
        }),
      );
      assert.equal(!result.ok && result.code, 'not_accepting');
    });
  });

  describe('blocklist', () => {
    it('refuses a blocked track', () => {
      const result = validateRequest(ctx({ blockedTrackIds: new Set(['t1']) }));
      assert.equal(!result.ok && result.code, 'blocked_track');
    });

    it('refuses any track by a blocked artist', () => {
      const result = validateRequest(
        ctx({ track: track({ artistIds: ['a1', 'a2'] }), blockedArtistIds: new Set(['a2']) }),
      );
      assert.equal(!result.ok && result.code, 'blocked_artist');
    });

    it('allows a track whose artist is not blocked', () => {
      const result = validateRequest(ctx({ blockedArtistIds: new Set(['someone-else']) }));
      assert.equal(result.ok, true);
    });

    it('never tells the guest that a blocklist exists', () => {
      const result = validateRequest(ctx({ blockedTrackIds: new Set(['t1']) }));
      assert.ok(!result.ok && !/block/i.test(result.message));
    });
  });

  describe('content rules', () => {
    it('refuses an explicit track when the filter is on', () => {
      const result = validateRequest(
        ctx({ settings: settings({ explicit_filter: true }), track: track({ explicit: true }) }),
      );
      assert.equal(!result.ok && result.code, 'explicit');
    });

    it('allows an explicit track when the filter is off', () => {
      assert.equal(validateRequest(ctx({ track: track({ explicit: true }) })).ok, true);
    });

    it('refuses a track over the length limit', () => {
      const result = validateRequest(ctx({ track: track({ durationMs: 900_000 }) }));
      assert.equal(!result.ok && result.code, 'too_long');
      assert.ok(!result.ok && /10 minutes/.test(result.message));
    });

    it('allows a track exactly at the limit', () => {
      assert.equal(validateRequest(ctx({ track: track({ durationMs: 600_000 }) })).ok, true);
    });
  });

  describe('duplicates', () => {
    it('refuses a track that is already coming up', () => {
      const result = validateRequest(ctx({ isDuplicate: true }));
      assert.equal(!result.ok && result.code, 'duplicate');
    });

    it('allows a duplicate when the operator has turned the rule off', () => {
      const result = validateRequest(
        ctx({ isDuplicate: true, settings: settings({ block_duplicates: false }) }),
      );
      assert.equal(result.ok, true);
    });
  });

  describe('capacity', () => {
    it('refuses when the queue is full', () => {
      const result = validateRequest(ctx({ queueLength: 25 }));
      assert.equal(!result.ok && result.code, 'queue_full');
    });

    it('accepts the request that exactly fills the queue', () => {
      assert.equal(validateRequest(ctx({ queueLength: 24 })).ok, true);
    });

    it('refuses a guest who already has their limit pending', () => {
      const result = validateRequest(ctx({ pendingForGuest: 2 }));
      assert.equal(!result.ok && result.code, 'too_many_pending');
    });

    it('phrases the one-request limit as a singular', () => {
      const result = validateRequest(
        ctx({ pendingForGuest: 1, settings: settings({ max_pending_per_guest: 1 }) }),
      );
      assert.ok(!result.ok && /already have a song/.test(result.message));
    });

    it('reports the queue being full before blaming the guest', () => {
      // Both are true; the guest can do nothing about a full queue, so that
      // is the more useful thing to say.
      const result = validateRequest(ctx({ queueLength: 25, pendingForGuest: 2 }));
      assert.equal(!result.ok && result.code, 'queue_full');
    });
  });

  describe('cooldown', () => {
    it('refuses a guest who just picked something', () => {
      const result = validateRequest(ctx({ lastRequestAtMs: NOW - 30_000 }));
      assert.equal(!result.ok && result.code, 'cooldown');
      assert.ok(!result.ok && /90 seconds/.test(result.message));
    });

    it('uses minutes once the wait is long', () => {
      const result = validateRequest(
        ctx({ lastRequestAtMs: NOW - 10_000, settings: settings({ cooldown_seconds: 600 }) }),
      );
      assert.ok(!result.ok && /10 minutes/.test(result.message));
    });

    it('allows a guest once the cooldown has elapsed', () => {
      assert.equal(validateRequest(ctx({ lastRequestAtMs: NOW - 120_001 })).ok, true);
    });

    it('is skipped entirely when set to zero', () => {
      const result = validateRequest(
        ctx({ lastRequestAtMs: NOW - 1_000, settings: settings({ cooldown_seconds: 0 }) }),
      );
      assert.equal(result.ok, true);
    });

    it('reports the pending limit ahead of the cooldown', () => {
      // "You already have two coming up" is more actionable than "wait 90s".
      const result = validateRequest(ctx({ pendingForGuest: 2, lastRequestAtMs: NOW - 30_000 }));
      assert.equal(!result.ok && result.code, 'too_many_pending');
    });

    it('reports how long is left, for the client to use', () => {
      const result = validateRequest(ctx({ lastRequestAtMs: NOW - 60_000 }));
      assert.equal(!result.ok && result.retryAfterMs, 60_000);
    });
  });

  describe('rate limiting', () => {
    it('refuses once the address has used its burst', () => {
      const result = validateRequest(ctx({ ipLimited: true }));
      assert.equal(!result.ok && result.code, 'rate_limited');
    });

    it('blames the room rather than the guest, since an IP is shared', () => {
      const result = validateRequest(ctx({ ipLimited: true }));
      assert.ok(!result.ok && !/you/i.test(result.message));
    });
  });

  describe('messages', () => {
    it('never mentions internals a guest cannot act on', () => {
      const cases: RequestContext[] = [
        ctx({ settings: settings({ accepting_requests: false }) }),
        ctx({ blockedTrackIds: new Set(['t1']) }),
        ctx({ isDuplicate: true }),
        ctx({ queueLength: 25 }),
        ctx({ pendingForGuest: 2 }),
        ctx({ ipLimited: true }),
        ctx({ lastRequestAtMs: NOW - 1_000 }),
      ];
      for (const scenario of cases) {
        const result = validateRequest(scenario);
        assert.equal(result.ok, false);
        const message = (result as { message: string }).message;
        assert.ok(!/spotify|sql|session|token|ip\b|hash/i.test(message), `leaky: ${message}`);
        assert.ok(message.length < 90, `too long for a phone: ${message}`);
      }
    });
  });
});

describe('pricing for a guest', () => {
  it('is free in free mode, whatever the price says', () => {
    const paidPrice = settings({ free_mode: true, price_cents: 200 });
    assert.equal(priceFor(paidPrice), 0);
    assert.equal(priceLabel(paidPrice), 'Free');
  });

  it('charges when free mode is off', () => {
    const paid = settings({ free_mode: false, price_cents: 200 });
    assert.equal(priceFor(paid), 200);
    assert.equal(priceLabel(paid), '$2.00');
  });

  it('is free when the price is zero, even with free mode off', () => {
    assert.equal(priceFor(settings({ free_mode: false, price_cents: 0 })), 0);
  });
});

describe('hashIp', () => {
  const secret = 's'.repeat(48);

  it('is stable for the same address', () => {
    assert.equal(hashIp('192.0.2.10', secret), hashIp('192.0.2.10', secret));
  });

  it('differs between addresses and between secrets', () => {
    assert.notEqual(hashIp('192.0.2.10', secret), hashIp('192.0.2.11', secret));
    assert.notEqual(hashIp('192.0.2.10', secret), hashIp('192.0.2.10', 'x'.repeat(48)));
  });

  it('does not contain the address it came from', () => {
    assert.ok(!hashIp('192.0.2.10', secret).includes('192'));
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit then refuses', () => {
    const limiter = new RateLimiter(60_000);
    for (let i = 0; i < 3; i++) {
      assert.equal(limiter.check('ip', 3, NOW).allowed, true, `attempt ${i + 1}`);
    }
    assert.equal(limiter.check('ip', 3, NOW).allowed, false);
  });

  it('lets the window slide', () => {
    const limiter = new RateLimiter(60_000);
    limiter.check('ip', 1, NOW);
    assert.equal(limiter.check('ip', 1, NOW + 30_000).allowed, false);
    assert.equal(limiter.check('ip', 1, NOW + 60_001).allowed, true);
  });

  it('says how long to wait', () => {
    const limiter = new RateLimiter(60_000);
    limiter.check('ip', 1, NOW);
    const result = limiter.check('ip', 1, NOW + 20_000);
    assert.equal(result.retryAfterMs, 40_000);
  });

  it('keeps addresses apart', () => {
    const limiter = new RateLimiter(60_000);
    limiter.check('ip-a', 1, NOW);
    assert.equal(limiter.check('ip-b', 1, NOW).allowed, true);
  });

  it('does not count a refused attempt against the window', () => {
    // Otherwise a client retrying in a loop would extend its own ban forever.
    const limiter = new RateLimiter(60_000);
    limiter.check('ip', 1, NOW);
    for (let i = 0; i < 5; i++) limiter.check('ip', 1, NOW + 1_000 * i);
    assert.equal(limiter.check('ip', 1, NOW + 60_001).allowed, true);
  });
});

describe('checkoutProductName', () => {
  it('is just the track when fundraising is off', () => {
    assert.equal(checkoutProductName(settings(), 'Harvest Moon'), 'Harvest Moon');
  });

  it('leads with the cause when fundraising is on', () => {
    const s = settings({ fundraiser_enabled: true, fundraiser_name: 'the Grade 8 trip' });
    assert.equal(
      checkoutProductName(s, 'Harvest Moon'),
      'DONATION to the Grade 8 trip: Harvest Moon',
    );
  });

  it('falls back to the track when no cause has been named', () => {
    // Otherwise the guest would see "DONATION to : Harvest Moon".
    const s = settings({ fundraiser_enabled: true, fundraiser_name: '   ' });
    assert.equal(checkoutProductName(s, 'Harvest Moon'), 'Harvest Moon');
  });

  it('trims a long cause rather than letting the track fall off the end', () => {
    const s = settings({ fundraiser_enabled: true, fundraiser_name: 'x'.repeat(200) });
    const name = checkoutProductName(s, 'Harvest Moon');
    assert.ok(name.endsWith('Harvest Moon'), 'the song must survive');
    assert.ok(name.length < 100);
  });

  it('ignores the cause when fundraising is switched off', () => {
    const s = settings({ fundraiser_enabled: false, fundraiser_name: 'the Grade 8 trip' });
    assert.equal(checkoutProductName(s, 'Harvest Moon'), 'Harvest Moon');
  });
});
