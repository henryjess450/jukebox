/**
 * Guest routes: the page, the request endpoint, and the live queue.
 *
 * Free mode is complete here. Paid mode is rejected with a clear message
 * until milestone 5 wires up Stripe, rather than pretending to work.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { isPaidMode } from '../../config/settings.js';
import { log } from '../../log.js';
import { SpotifyError } from '../../spotify/errors.js';
import { formatDuration } from '../../spotify/types.js';
import { ensureGuestSession, hashIp, RateLimiter } from '../../guest/session.js';
import { priceFor, priceLabel, validateRequest } from '../../guest/validation.js';
import { SseHub } from '../../http/sse.js';
import { guestPage } from './views.js';

const RequestBody = z.object({
  /** The track id, not a URI: we re-fetch from Spotify rather than trusting
   *  whatever the browser sends about duration, explicitness or artist. */
  trackId: z.string().min(1).max(64),
});

export interface QueueSnapshot {
  nowPlaying: {
    name: string;
    artist: string;
    albumArtUrl: string | null;
    duration: string;
    requested: boolean;
  } | null;
  upNext: Array<{
    id: number;
    name: string;
    artist: string;
    albumArtUrl: string | null;
    duration: string;
    mine?: boolean;
  }>;
  accepting: boolean;
}

export function registerGuestRoutes(app: FastifyInstance, ctx: AppContext): void {
  const secure = ctx.env.PUBLIC_URL.startsWith('https://');
  const ipLimiter = new RateLimiter(60_000);

  /**
   * What everyone sees. Deliberately free of guest-specific data so one
   * snapshot can be broadcast to every connected phone.
   */
  const snapshot = (): QueueSnapshot => {
    const playing = ctx.queue.nowPlaying();
    const upNext = ctx.queue.listQueued();

    return {
      nowPlaying: playing
        ? {
            name: playing.track_name,
            artist: playing.artist_name,
            albumArtUrl: playing.album_art_url,
            duration: formatDuration(playing.duration_ms),
            requested: true,
          }
        : ctx.engine.lastKnownTrack(),
      upNext: upNext.map((r) => ({
        id: r.id,
        name: r.track_name,
        artist: r.artist_name,
        albumArtUrl: r.album_art_url,
        duration: formatDuration(r.duration_ms),
      })),
      accepting: ctx.settings.get('accepting_requests'),
    };
  };

  const hub = new SseHub<QueueSnapshot>(snapshot);
  ctx.queueStream = hub;

  // --- the page -------------------------------------------------------------

  app.get('/', async (req, reply) => {
    ensureGuestSession(req, reply, { secure });
    const settings = ctx.settings.all();

    return reply.type('text/html').send(
      guestPage({
        venueName: settings.venue_name,
        priceLabel: priceLabel(settings),
        isPaid: isPaidMode(settings),
        accepting: settings.accepting_requests,
        closedMessage: null,
      }),
    );
  });

  // --- the live queue -------------------------------------------------------

  app.get('/api/queue', async (_req, reply) => reply.send(snapshot()));

  app.get('/api/queue/stream', (req, reply) => {
    hub.add(reply);
    // Fastify must not try to send a body for a hijacked socket.
    req.raw.on('close', () => void 0);
  });

  // --- submitting a request -------------------------------------------------

  app.post('/api/request', async (req, reply) => {
    const parsed = RequestBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'That request did not look right. Try again.' });
    }

    const guestId = ensureGuestSession(req, reply, { secure });
    const ipHash = hashIp(req.ip, ctx.env.COOKIE_SECRET);
    const settings = ctx.settings.all();

    if (!ctx.spotifyAuth.isConnected()) {
      return reply.status(503).send({ error: 'The jukebox is not set up yet.' });
    }

    // Re-read the track from Spotify. The browser's copy is untrusted input:
    // duration, explicitness and artist all gate the decision below.
    let track;
    try {
      track = await ctx.spotify.getTrack(parsed.data.trackId, settings.market);
    } catch (err) {
      if (err instanceof SpotifyError) {
        log.warn('could not look up requested track', err.toLogFields());
        return reply.status(err.transient ? 503 : 404).send({ error: err.guestMessage });
      }
      throw err;
    }

    const ipCheck = ipLimiter.check(ipHash, settings.ip_requests_per_minute);
    const lastRequestAt = ctx.queue.lastRequestAt(guestId);

    const verdict = validateRequest({
      track,
      settings,
      pendingForGuest: ctx.queue.countPendingForSession(guestId),
      queueLength: ctx.queue.countQueued(),
      lastRequestAtMs: lastRequestAt ? Date.parse(lastRequestAt) : null,
      isDuplicate: ctx.queue.isActive(track.uri),
      ipLimited: !ipCheck.allowed,
      blockedTrackIds: ctx.blocklist.trackIds,
      blockedArtistIds: ctx.blocklist.artistIds,
      now: Date.now(),
    });

    if (!verdict.ok) {
      ctx.events.record('request_rejected', {
        actor: 'guest',
        detail: { code: verdict.code, track: track.name },
      });
      log.info('request rejected', { code: verdict.code, track_id: track.id });
      return reply.status(429).send({ error: verdict.message, code: verdict.code });
    }

    const amountCents = priceFor(settings);

    // --- paid: create the request unpaid, then send them to Stripe ---------

    if (amountCents > 0) {
      if (!ctx.payments) {
        // Misconfiguration, not a guest error: never queue something unpaid.
        log.error('paid mode is on but Stripe is not configured');
        return reply.status(503).send({
          error: 'Card payments are not working right now. Ask whoever runs this.',
          code: 'payment_unavailable',
        });
      }

      const pendingId = ctx.queue.enqueue({
        track,
        sessionId: guestId,
        ipHash,
        state: 'pending_payment',
        amountCents,
        currency: settings.currency,
      });
      const row = ctx.queue.byId(pendingId);
      if (!row) return reply.status(500).send({ error: 'Something went wrong. Try again.' });

      try {
        const checkout = await ctx.payments.startCheckout({ requestId: pendingId, row });
        return reply.send({ ok: true, checkoutUrl: checkout.url });
      } catch {
        // startCheckout already cancelled the row and logged the cause.
        return reply.status(502).send({
          error: 'Could not start the payment. Nothing was charged — try again.',
        });
      }
    }

    // --- free: straight into the queue -------------------------------------

    const id = ctx.queue.enqueue({
      track,
      sessionId: guestId,
      ipHash,
      state: 'queued',
      amountCents: 0,
      currency: settings.currency,
    });

    ctx.events.record('request_created', {
      actor: 'guest',
      requestId: id,
      detail: { track: track.name, artist: track.artist, amount_cents: 0 },
    });
    log.info('request queued', { request_id: id, track_id: track.id });

    // Push the new queue to every open page at once.
    hub.publish();

    return reply.send({
      ok: true,
      id,
      position: ctx.queue.queuePosition(id),
      track: { name: track.name, artist: track.artist },
    });
  });

  /** Where a guest's own request sits, for the confirmation screen. */
  app.get<{ Params: { id: string } }>('/api/request/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.status(400).send({ error: 'Unknown request.' });

    const row = ctx.queue.byId(id);
    if (!row) return reply.status(404).send({ error: 'Unknown request.' });

    return reply.send({
      id: row.id,
      state: row.state,
      position: row.state === 'queued' ? ctx.queue.queuePosition(row.id) : null,
      track: { name: row.track_name, artist: row.artist_name },
    });
  });
}

/** Close every stream during shutdown so systemd does not wait on them. */
export function closeGuestStreams(reply: SseHub<QueueSnapshot> | undefined): void {
  reply?.closeAll();
}

export type { FastifyReply };
