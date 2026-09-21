/**
 * Admin queue and playback control.
 *
 * Everything that changes state is a POST with a CSRF token, and every one of
 * them is recorded in the audit log — an operator removing a paid request is
 * exactly the kind of thing someone will ask about later.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { csrfToken, csrfValid } from '../../http/csrf.js';
import { log } from '../../log.js';
import { SpotifyError } from '../../spotify/errors.js';
import { findDeviceByName } from '../../engine/reconciler.js';
import type { AdminGuard } from './spotify.js';
import { queuePage } from './queue-view.js';

const IdBody = z.object({ id: z.coerce.number().int().positive() });
const MoveBody = IdBody.extend({ direction: z.enum(['up', 'down']) });
const BlockBody = z.object({
  query: z.string().min(1).max(120),
  kind: z.enum(['track', 'artist']),
});

export function registerQueueRoutes(app: FastifyInstance, ctx: AppContext, guard: AdminGuard): void {
  /** Resolve the device we are meant to be driving, or null. */
  async function targetDeviceId(): Promise<string | null> {
    try {
      const devices = await ctx.spotify.getDevices();
      return findDeviceByName(devices, ctx.settings.get('device_name'))?.id ?? null;
    } catch {
      return null;
    }
  }

  /** Every admin POST shares this shape: check session, check CSRF, act, redirect. */
  function command(
    path: string,
    handler: (body: unknown, sessionId: string) => Promise<{ tone: 'ok' | 'error'; message: string }>,
  ): void {
    app.post(path, async (req, reply) => {
      const sessionId = guard.requireSession(req);
      if (!sessionId) return reply.type('text/html').send(guard.renderLogin());
      if (!csrfValid(sessionId, ctx.env.COOKIE_SECRET, (req.body as Record<string, unknown>)?.['csrf'])) {
        return reply.status(403).send('bad csrf');
      }
      const result = await handler(req.body, sessionId);
      const query = new URLSearchParams({ [result.tone === 'ok' ? 'ok' : 'error']: result.message });
      return reply.redirect(`/admin/queue?${query.toString()}`);
    });
  }

  // --- the page -------------------------------------------------------------

  app.get('/admin/queue', async (req, reply) => {
    const sessionId = guard.requireSession(req);
    if (!sessionId) return reply.type('text/html').send(guard.renderLogin());

    const query = req.query as Record<string, unknown>;
    const lastTrack = ctx.engine.lastKnownTrack();

    // Playback state is a nicety here; the page must render without it.
    let isPlaying = false;
    try {
      const snapshot = await ctx.spotify.getPlaybackState();
      isPlaying = snapshot?.isPlaying ?? false;
    } catch {
      isPlaying = false;
    }

    return reply.type('text/html').send(
      queuePage({
        settings: ctx.settings.all(),
        csrf: csrfToken(sessionId, ctx.env.COOKIE_SECRET),
        playing: ctx.queue.nowPlaying(),
        queue: ctx.queue.listQueued(),
        fallbackTrack: lastTrack ? { name: lastTrack.name, artist: lastTrack.artist } : null,
        isPlaying,
        recent: ctx.queue.recent(60),
        blocklist: ctx.blocklist.list(),
        engine: ctx.engine.stats(),
        ...(typeof query['ok'] === 'string'
          ? { flash: { tone: 'ok' as const, message: query['ok'] } }
          : typeof query['error'] === 'string'
            ? { flash: { tone: 'error' as const, message: query['error'] } }
            : {}),
      }),
    );
  });

  // --- queue ----------------------------------------------------------------

  command('/admin/queue/move', async (body) => {
    const parsed = MoveBody.safeParse(body);
    if (!parsed.success) return { tone: 'error', message: 'Could not move that.' };

    const queue = ctx.queue.listQueued();
    const index = queue.findIndex((r) => r.id === parsed.data.id);
    if (index === -1) return { tone: 'error', message: 'That request is no longer in the queue.' };

    // `moveTo` positions a row before another; translate a nudge into that.
    const target =
      parsed.data.direction === 'up'
        ? (queue[index - 1]?.id ?? null)
        : (queue[index + 2]?.id ?? null);

    if (parsed.data.direction === 'up' && index === 0) {
      return { tone: 'error', message: 'Already first.' };
    }

    const moved = ctx.queue.moveTo(parsed.data.id, target);
    if (!moved) return { tone: 'error', message: 'Could not move that.' };

    ctx.events.record('request_reordered', {
      requestId: parsed.data.id,
      actor: 'admin',
      detail: { direction: parsed.data.direction },
    });
    ctx.queueStream?.publish();
    return { tone: 'ok', message: 'Moved.' };
  });

  command('/admin/queue/remove', async (body) => {
    const parsed = IdBody.safeParse(body);
    if (!parsed.success) return { tone: 'error', message: 'Could not remove that.' };

    const row = ctx.queue.byId(parsed.data.id);
    if (!row) return { tone: 'error', message: 'That request no longer exists.' };

    ctx.queue.cancel(row.id, 'removed by admin');
    ctx.events.record('request_removed', {
      requestId: row.id,
      actor: 'admin',
      detail: { track: row.track_name, amount_cents: row.amount_cents },
    });
    ctx.queueStream?.publish();

    // A paid request that will never play has to be given back. The sweeper
    // would catch it within five minutes anyway; doing it now means the
    // operator sees the result while they are still looking at the screen.
    if (row.amount_cents > 0 && row.stripe_payment_intent && ctx.payments) {
      const refund = await ctx.payments.refund(row.id, 'removed by admin');
      return refund.ok
        ? { tone: 'ok', message: `Removed and refunded ${row.track_name}.` }
        : { tone: 'error', message: `Removed, but the refund failed: ${refund.message ?? ''}` };
    }

    return { tone: 'ok', message: `Removed ${row.track_name}.` };
  });

  command('/admin/requests/refund', async (body) => {
    const parsed = IdBody.safeParse(body);
    if (!parsed.success) return { tone: 'error', message: 'Could not refund that.' };
    if (!ctx.payments) return { tone: 'error', message: 'Stripe is not configured.' };

    const result = await ctx.payments.refund(parsed.data.id, 'refunded by admin');
    return result.ok
      ? { tone: 'ok', message: 'Refunded.' }
      : { tone: 'error', message: result.message ?? 'The refund failed.' };
  });

  // --- playback -------------------------------------------------------------

  command('/admin/playback/skip', async () => {
    const deviceId = await targetDeviceId();
    if (!deviceId) return { tone: 'error', message: 'The Connect device is not available.' };
    try {
      await ctx.spotify.skipToNext(deviceId);
      ctx.events.record('playback_skipped', { actor: 'admin' });
      return { tone: 'ok', message: 'Skipped.' };
    } catch (err) {
      return { tone: 'error', message: describe(err) };
    }
  });

  command('/admin/playback/pause', async () => {
    const deviceId = await targetDeviceId();
    if (!deviceId) return { tone: 'error', message: 'The Connect device is not available.' };
    try {
      await ctx.spotify.pause(deviceId);
      ctx.events.record('playback_paused', { actor: 'admin' });
      // The engine would helpfully resume it; tell it not to.
      ctx.engine.holdPaused(true);
      return { tone: 'ok', message: 'Paused. The engine will leave it paused until you resume.' };
    } catch (err) {
      return { tone: 'error', message: describe(err) };
    }
  });

  command('/admin/playback/resume', async () => {
    const deviceId = await targetDeviceId();
    if (!deviceId) return { tone: 'error', message: 'The Connect device is not available.' };
    try {
      ctx.engine.holdPaused(false);
      await ctx.spotify.resume(deviceId);
      ctx.events.record('playback_resumed', { actor: 'admin' });
      return { tone: 'ok', message: 'Resumed.' };
    } catch (err) {
      return { tone: 'error', message: describe(err) };
    }
  });

  command('/admin/playback/restart', async () => {
    const deviceId = await targetDeviceId();
    if (!deviceId) return { tone: 'error', message: 'The Connect device is not available.' };
    const uri = ctx.settings.get('fallback_playlist_uri');
    if (uri === '') return { tone: 'error', message: 'No fallback playlist is set.' };
    try {
      ctx.engine.holdPaused(false);
      await ctx.spotify.playContext(uri, deviceId);
      await ctx.spotify.setShuffle(true, deviceId).catch(() => undefined);
      await ctx.spotify.setRepeat('context', deviceId).catch(() => undefined);
      ctx.events.record('fallback_restarted', { actor: 'admin', detail: { reason: 'admin' } });
      return { tone: 'ok', message: 'Playlist restarted.' };
    } catch (err) {
      return { tone: 'error', message: describe(err) };
    }
  });

  // --- blocklist ------------------------------------------------------------

  command('/admin/blocklist/add', async (body) => {
    const parsed = BlockBody.safeParse(body);
    if (!parsed.success) return { tone: 'error', message: 'Enter something to block.' };

    const market = ctx.settings.get('market');
    try {
      const results = await ctx.spotify.search(parsed.data.query, market, 1);
      const track = results[0];
      if (!track) return { tone: 'error', message: 'Nothing found for that.' };

      if (parsed.data.kind === 'track') {
        ctx.blocklist.add('track', track.id, `${track.name} — ${track.artist}`);
        return { tone: 'ok', message: `Blocked ${track.name}.` };
      }

      const artistId = track.artistIds[0];
      if (!artistId) return { tone: 'error', message: 'That track has no artist to block.' };
      ctx.blocklist.add('artist', artistId, track.artist);
      return { tone: 'ok', message: `Blocked everything by ${track.artist}.` };
    } catch (err) {
      return { tone: 'error', message: describe(err) };
    }
  });

  command('/admin/blocklist/remove', async (body) => {
    const parsed = IdBody.safeParse(body);
    if (!parsed.success) return { tone: 'error', message: 'Could not unblock that.' };
    ctx.blocklist.remove(parsed.data.id);
    return { tone: 'ok', message: 'Unblocked.' };
  });
}

function describe(err: unknown): string {
  if (err instanceof SpotifyError) {
    log.warn('admin command failed', err.toLogFields());
    return err.message;
  }
  log.error('admin command failed unexpectedly', { err });
  return 'Something went wrong.';
}
