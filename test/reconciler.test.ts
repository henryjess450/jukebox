/**
 * The reconciler, exhaustively. It is a pure function, so every scenario the
 * engine can meet in a venue is expressible as a literal here — no Spotify, no
 * clock, no database.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PUSH_TIMEOUT_MS,
  findDeviceByName,
  reconcile,
  remainingTrackMs,
  type Action,
  type ReconcileInput,
} from '../src/engine/reconciler.js';
import type { RequestRow } from '../src/queue/repository.js';
import type { PlayerSnapshot } from '../src/spotify/client.js';
import type { SpotifyDevice, Track } from '../src/spotify/types.js';

const FALLBACK = 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M';
const NOW = Date.parse('2026-09-19T22:00:00.000Z');

const ourDevice: SpotifyDevice = {
  id: 'librespot-1',
  is_active: true,
  is_restricted: false,
  name: 'Jukebox',
  type: 'Speaker',
  volume_percent: 70,
};

const phone: SpotifyDevice = {
  id: 'phone-1',
  is_active: false,
  is_restricted: false,
  name: "Henry's iPhone",
  type: 'Smartphone',
  volume_percent: 50,
};

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

function playing(over: Partial<PlayerSnapshot> = {}): PlayerSnapshot {
  return {
    device: ourDevice,
    isPlaying: true,
    progressMs: 10_000,
    repeatState: 'context',
    contextUri: FALLBACK,
    track: track(),
    ...over,
  };
}

let nextId = 1;
function request(over: Partial<RequestRow> = {}): RequestRow {
  const id = over.id ?? nextId++;
  return {
    id,
    track_uri: `spotify:track:req${id}`,
    track_id: `req${id}`,
    track_name: `Request ${id}`,
    artist_name: 'Someone',
    album_name: 'An Album',
    album_art_url: null,
    duration_ms: 200_000,
    explicit: 0,
    session_id: 'sess-a',
    ip_hash: 'iphash',
    state: 'queued',
    position: id * 1000,
    amount_cents: 0,
    currency: 'CAD',
    stripe_session_id: null,
    stripe_payment_intent: null,
    refund_id: null,
    failure_reason: null,
    created_at: new Date(NOW - 60_000).toISOString(),
    paid_at: null,
    queued_at: new Date(NOW - 60_000).toISOString(),
    pushed_at: null,
    started_at: null,
    finished_at: null,
    ...over,
  };
}

function input(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    now: NOW,
    playback: playing(),
    devices: [ourDevice],
    queue: [],
    playing: null,
    settings: {
      deviceName: 'Jukebox',
      fallbackPlaylistUri: FALLBACK,
      pushLeadMs: 15_000,
      interruptCurrent: false,
    },
    ...over,
  };
}

const find = <T extends Action['type']>(actions: Action[], type: T) =>
  actions.find((a): a is Extract<Action, { type: T }> => a.type === type);

const types = (actions: Action[]) => actions.map((a) => a.type);

describe('findDeviceByName', () => {
  it('matches on name, ignoring case and whitespace', () => {
    assert.equal(findDeviceByName([phone, ourDevice], 'jukebox')?.id, 'librespot-1');
    assert.equal(findDeviceByName([phone, ourDevice], '  Jukebox  ')?.id, 'librespot-1');
  });

  it('returns null when absent', () => {
    assert.equal(findDeviceByName([phone], 'Jukebox'), null);
    assert.equal(findDeviceByName([], 'Jukebox'), null);
  });
});

describe('remainingTrackMs', () => {
  it('computes what is left', () => {
    assert.equal(remainingTrackMs(playing({ progressMs: 280_000 })), 20_000);
  });

  it('never goes negative when progress overshoots', () => {
    assert.equal(remainingTrackMs(playing({ progressMs: 310_000 })), 0);
  });

  it('is null when Spotify reports no progress', () => {
    assert.equal(remainingTrackMs(playing({ progressMs: null })), null);
  });
});

describe('device availability', () => {
  it('does nothing at all when our device is missing', () => {
    const actions = reconcile(input({ devices: [phone], queue: [request()] }));
    assert.deepEqual(types(actions), ['wait']);
    assert.match(find(actions, 'wait')!.reason, /librespot/);
  });

  it('does not act on a device whose id Spotify withholds', () => {
    const actions = reconcile(input({ devices: [{ ...ourDevice, id: null }] }));
    assert.deepEqual(types(actions), ['wait']);
  });

  it('retargets when our device exists but is not the active one', () => {
    const actions = reconcile(
      input({
        devices: [{ ...ourDevice, is_active: false }],
        playback: playing({ device: phone }),
      }),
    );
    assert.equal(find(actions, 'retarget_device')?.deviceId, 'librespot-1');
  });
});

describe('dead air', () => {
  it('starts the fallback when Spotify reports nothing playing', () => {
    const actions = reconcile(input({ playback: null }));
    const start = find(actions, 'start_fallback');
    assert.equal(start?.contextUri, FALLBACK);
    assert.match(start!.reason, /nothing playing/);
  });

  it('starts the fallback when the player is stopped with nothing loaded', () => {
    const actions = reconcile(input({ playback: playing({ isPlaying: false, track: null }) }));
    assert.ok(find(actions, 'start_fallback'));
  });

  it('leaves alone something playing that it cannot identify', () => {
    // `item` is null for podcast episodes, ads and local files. Restarting
    // here relaunches the playlist on every tick, which sounds exactly like
    // the track skipping every few seconds.
    const actions = reconcile(input({ playback: playing({ isPlaying: true, track: null }) }));
    assert.deepEqual(types(actions), ['wait']);
    assert.equal(find(actions, 'start_fallback'), undefined);
  });

  it('does not relaunch on every tick while an unidentified track plays', () => {
    const scenario = input({ playback: playing({ isPlaying: true, track: null }) });
    for (let tick = 0; tick < 5; tick++) {
      assert.equal(find(reconcile(scenario), 'start_fallback'), undefined, `tick ${tick}`);
    }
  });

  it('does nothing when no fallback playlist has been chosen', () => {
    const actions = reconcile(
      input({ playback: null, settings: { ...input().settings, fallbackPlaylistUri: '' } }),
    );
    assert.deepEqual(types(actions), ['wait']);
    assert.match(find(actions, 'wait')!.reason, /no fallback playlist/);
  });

  it('resumes rather than reloading when merely paused', () => {
    const actions = reconcile(input({ playback: playing({ isPlaying: false }), queue: [request()] }));
    assert.ok(find(actions, 'resume'));
    assert.equal(find(actions, 'start_fallback'), undefined);
  });
});

describe('keeping the fallback looping', () => {
  it('re-enables repeat when it has been turned off', () => {
    const actions = reconcile(input({ playback: playing({ repeatState: 'off' }) }));
    assert.ok(find(actions, 'ensure_repeat'), 'without repeat the room goes quiet at the end');
  });

  it('leaves repeat alone when it is already on the context', () => {
    const actions = reconcile(input({ playback: playing({ repeatState: 'context' }) }));
    assert.equal(find(actions, 'ensure_repeat'), undefined);
  });

  it('does not force repeat while a request is playing off-context', () => {
    const req = request({ state: 'playing', pushed_at: new Date(NOW).toISOString() });
    const actions = reconcile(
      input({
        playback: playing({ contextUri: null, repeatState: 'off', track: track({ uri: req.track_uri }) }),
        playing: req,
      }),
    );
    assert.equal(find(actions, 'ensure_repeat'), undefined);
  });

  it('takes playback back when it drifts off our playlist with nothing pending', () => {
    const actions = reconcile(
      input({ playback: playing({ contextUri: 'spotify:album:someone-elses-album' }) }),
    );
    const start = find(actions, 'start_fallback');
    assert.match(start!.reason, /drifted/);
  });

  it('does not yank playback back while one of our requests is playing', () => {
    const req = request({ state: 'playing' });
    const actions = reconcile(
      input({
        playback: playing({ contextUri: null, track: track({ uri: req.track_uri }) }),
        playing: req,
      }),
    );
    assert.equal(find(actions, 'start_fallback'), undefined);
  });
});

describe('handing a request to Spotify', () => {
  it('waits while the current track still has time left', () => {
    const actions = reconcile(input({ queue: [request()], playback: playing({ progressMs: 10_000 }) }));
    assert.deepEqual(types(actions), ['wait']);
  });

  it('hands over once the current track is inside the lead window', () => {
    const req = request();
    const actions = reconcile(
      input({ queue: [req], playback: playing({ progressMs: 290_000 }) }), // 10s left
    );
    const push = find(actions, 'push_request');
    assert.equal(push?.requestId, req.id);
    assert.equal(push?.trackUri, req.track_uri);
    assert.equal(push?.deviceId, 'librespot-1');
  });

  it('treats the lead window as inclusive', () => {
    const actions = reconcile(
      input({ queue: [request()], playback: playing({ progressMs: 285_000 }) }), // exactly 15s
    );
    assert.ok(find(actions, 'push_request'));
  });

  it('hands over rather than stalling when Spotify reports no progress', () => {
    const actions = reconcile(input({ queue: [request()], playback: playing({ progressMs: null }) }));
    assert.match(find(actions, 'push_request')!.reason, /no progress/);
  });

  it('hands over exactly one request, however many are waiting', () => {
    const queue = [request(), request(), request()];
    const actions = reconcile(input({ queue, playback: playing({ progressMs: 295_000 }) }));
    const pushes = actions.filter((a) => a.type === 'push_request');
    assert.equal(pushes.length, 1, 'a second hand-off would make the first unreorderable too');
  });

  it('hands over the head of the queue, not whichever came first', () => {
    // Positions, not ids, decide order — an admin reorder must be respected.
    const later = request({ id: 10, position: 500 });
    const earlier = request({ id: 20, position: 100 });
    const actions = reconcile(
      input({ queue: [earlier, later], playback: playing({ progressMs: 295_000 }) }),
    );
    assert.equal(find(actions, 'push_request')?.requestId, 20);
  });

  it('does not hand over a second while one is still outstanding', () => {
    const outstanding = request({ id: 1, pushed_at: new Date(NOW - 5_000).toISOString() });
    const waiting = request({ id: 2 });
    const actions = reconcile(
      input({ queue: [outstanding, waiting], playback: playing({ progressMs: 299_000 }) }),
    );
    assert.equal(find(actions, 'push_request'), undefined);
  });
});

describe('interrupt mode', () => {
  it('queues then skips, in that order', () => {
    const req = request();
    const actions = reconcile(
      input({
        queue: [req],
        playback: playing({ progressMs: 5_000 }),
        settings: { ...input().settings, interruptCurrent: true },
      }),
    );
    // Skipping before queueing would play whatever the playlist had next.
    assert.deepEqual(types(actions), ['push_request', 'skip_now']);
  });

  it('never interrupts a track another guest paid for', () => {
    const paidAndPlaying = request({ id: 1, state: 'playing', amount_cents: 200 });
    const waiting = request({ id: 2 });
    const actions = reconcile(
      input({
        queue: [waiting],
        playing: paidAndPlaying,
        playback: playing({ progressMs: 5_000, track: track({ uri: paidAndPlaying.track_uri }) }),
        settings: { ...input().settings, interruptCurrent: true },
      }),
    );
    assert.equal(find(actions, 'skip_now'), undefined, 'someone paid for the track now playing');
    assert.equal(find(actions, 'push_request'), undefined, 'and it is not yet time to hand over');
  });

  it('does interrupt a free request, which nobody paid for', () => {
    const freeAndPlaying = request({ id: 1, state: 'playing', amount_cents: 0 });
    const actions = reconcile(
      input({
        queue: [request({ id: 2 })],
        playing: freeAndPlaying,
        playback: playing({ progressMs: 5_000, track: track({ uri: freeAndPlaying.track_uri }) }),
        settings: { ...input().settings, interruptCurrent: true },
      }),
    );
    assert.ok(find(actions, 'skip_now'));
  });
});

describe('tracking what is playing', () => {
  it('marks a handed-over request as playing once it is audible', () => {
    const pushed = request({ pushed_at: new Date(NOW - 20_000).toISOString() });
    const actions = reconcile(
      input({ queue: [pushed], playback: playing({ track: track({ uri: pushed.track_uri }) }) }),
    );
    assert.equal(find(actions, 'mark_playing')?.requestId, pushed.id);
  });

  it('does not re-mark a request that is already playing', () => {
    const current = request({ id: 1, state: 'playing', pushed_at: new Date(NOW).toISOString() });
    const actions = reconcile(
      input({
        queue: [],
        playing: current,
        playback: playing({ track: track({ uri: current.track_uri }) }),
      }),
    );
    assert.equal(find(actions, 'mark_playing'), undefined);
  });

  it('marks a request played once something else is on', () => {
    const finished = request({ id: 1, state: 'playing' });
    const actions = reconcile(
      input({ playing: finished, playback: playing({ track: track({ uri: 'spotify:track:other' }) }) }),
    );
    assert.equal(find(actions, 'mark_played')?.requestId, finished.id);
  });

  it('marks it played even when it was skipped early', () => {
    const skipped = request({ id: 1, state: 'playing' });
    const actions = reconcile(
      input({
        playing: skipped,
        playback: playing({ progressMs: 2_000, track: track({ uri: 'spotify:track:next-one' }) }),
      }),
    );
    assert.ok(find(actions, 'mark_played'));
  });

  it('closes out the old request and opens the new one in one pass', () => {
    const outgoing = request({ id: 1, state: 'playing' });
    const incoming = request({ id: 2, pushed_at: new Date(NOW - 10_000).toISOString() });
    const actions = reconcile(
      input({
        queue: [incoming],
        playing: outgoing,
        playback: playing({ track: track({ uri: incoming.track_uri }) }),
      }),
    );
    assert.equal(find(actions, 'mark_played')?.requestId, 1);
    assert.equal(find(actions, 'mark_playing')?.requestId, 2);
  });

  it('marks a request played when playback dies entirely', () => {
    const orphan = request({ id: 1, state: 'playing' });
    const actions = reconcile(input({ playing: orphan, playback: null }));
    assert.equal(find(actions, 'mark_played')?.requestId, 1);
    assert.ok(find(actions, 'start_fallback'));
  });
});

describe('giving up on a lost hand-off', () => {
  it('fails a request that never became audible', () => {
    const lost = request({ pushed_at: new Date(NOW - PUSH_TIMEOUT_MS - 1_000).toISOString() });
    const actions = reconcile(input({ queue: [lost] }));
    const failed = find(actions, 'mark_failed');
    assert.equal(failed?.requestId, lost.id);
    assert.match(failed!.reason, /never started/);
  });

  it('is patient inside the timeout', () => {
    const recent = request({ pushed_at: new Date(NOW - PUSH_TIMEOUT_MS + 5_000).toISOString() });
    const actions = reconcile(input({ queue: [recent] }));
    assert.equal(find(actions, 'mark_failed'), undefined);
  });

  it('lets the queue move on after abandoning one', () => {
    const lost = request({ id: 1, pushed_at: new Date(NOW - PUSH_TIMEOUT_MS - 1_000).toISOString() });
    const waiting = request({ id: 2 });
    const actions = reconcile(
      input({ queue: [lost, waiting], playback: playing({ progressMs: 295_000 }) }),
    );
    assert.ok(find(actions, 'mark_failed'));
    assert.equal(find(actions, 'push_request')?.requestId, 2, 'the next one must not be blocked');
  });

  it('does not fail a hand-off that did start, however old', () => {
    const old = request({ pushed_at: new Date(NOW - PUSH_TIMEOUT_MS * 3).toISOString() });
    const actions = reconcile(
      input({ queue: [old], playback: playing({ track: track({ uri: old.track_uri }) }) }),
    );
    assert.equal(find(actions, 'mark_failed'), undefined);
    assert.ok(find(actions, 'mark_playing'));
  });
});

describe('determinism', () => {
  it('returns the same actions for the same input', () => {
    const scenario = input({ queue: [request({ id: 7 })], playback: playing({ progressMs: 295_000 }) });
    assert.deepEqual(reconcile(scenario), reconcile(scenario));
  });

  it('never mutates its input', () => {
    const scenario = input({ queue: [request({ id: 9 })], playback: playing({ progressMs: 295_000 }) });
    const snapshot = structuredClone(scenario);
    reconcile(scenario);
    assert.deepEqual(scenario, snapshot);
  });

  it('always returns at least one action, so every tick is explainable', () => {
    for (const scenario of [
      input(),
      input({ playback: null }),
      input({ devices: [] }),
      input({ queue: [request()] }),
      input({ playing: request({ state: 'playing' }) }),
    ]) {
      assert.ok(reconcile(scenario).length > 0);
    }
  });
});
