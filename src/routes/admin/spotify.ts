/**
 * The Spotify connect/reconnect flow and the diagnostic status page.
 *
 * Both live behind the admin session: the status page names the account, the
 * device and the playlist, none of which a guest should see.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { csrfToken, csrfValid } from '../../http/csrf.js';
import { log } from '../../log.js';
import { SpotifyError } from '../../spotify/errors.js';
import { playlistIdFromUri } from '../../spotify/client.js';
import type { SpotifyDevice } from '../../spotify/types.js';
import { statusPage, type StatusView } from './status-view.js';

/** Supplied by the admin module, which owns the session table. */
export interface AdminGuard {
  /** The session id, or null when the caller is not signed in. */
  requireSession: (req: FastifyRequest) => string | null;
  renderLogin: () => string;
}

const CallbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

export function registerSpotifyRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  guard: AdminGuard,
): void {
  /** Kick off the authorization code flow. */
  app.get('/admin/spotify/connect', async (req, reply) => {
    const sessionId = guard.requireSession(req);
    if (!sessionId) return reply.type('text/html').send(guard.renderLogin());
    return reply.redirect(ctx.spotifyAuth.authorizeUrl());
  });

  /**
   * Spotify redirects here. Note this runs without an admin session check on
   * the query itself — the signed `state` is what proves the flow is ours.
   * An admin session is still required, so a stolen callback URL alone is
   * useless.
   */
  app.get('/admin/spotify/callback', async (req, reply) => {
    const sessionId = guard.requireSession(req);
    if (!sessionId) return reply.type('text/html').send(guard.renderLogin());

    const parsed = CallbackQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.redirect('/status?error=' + encodeURIComponent('Malformed callback from Spotify.'));
    }
    const { code, state, error } = parsed.data;

    if (error) {
      // The operator pressed Cancel, or the app is misconfigured.
      log.warn('spotify authorization declined', { error });
      return reply.redirect('/status?error=' + encodeURIComponent(`Spotify said: ${error}`));
    }

    if (!ctx.spotifyAuth.verifyState(state)) {
      log.warn('spotify callback with bad state');
      return reply.redirect(
        '/status?error=' + encodeURIComponent('Authorization state did not match. Start again.'),
      );
    }

    if (!code) {
      return reply.redirect('/status?error=' + encodeURIComponent('Spotify returned no code.'));
    }

    try {
      await ctx.spotifyAuth.exchangeCode(code);
      // Record who we connected as, and warn immediately if it is not Premium —
      // playback control silently does nothing on a free account.
      const profile = await ctx.spotify.getCurrentUser();
      ctx.spotifyAuth.setAccountName(profile.display_name ?? profile.id);
      ctx.events.record('spotify_connected', {
        actor: 'admin',
        detail: { account: profile.display_name ?? profile.id, product: profile.product },
      });

      if (profile.product && profile.product !== 'premium') {
        return reply.redirect(
          '/status?error=' +
            encodeURIComponent(
              `Connected as a ${profile.product} account. Playback control needs Premium.`,
            ),
        );
      }
      return reply.redirect('/status?connected=1');
    } catch (err) {
      const message =
        err instanceof SpotifyError ? err.message : 'Could not complete the Spotify connection.';
      log.error('spotify code exchange failed', {
        err: err instanceof SpotifyError ? err.toLogFields() : err,
      });
      return reply.redirect('/status?error=' + encodeURIComponent(message));
    }
  });

  app.post('/admin/spotify/disconnect', async (req, reply) => {
    const sessionId = guard.requireSession(req);
    if (!sessionId) return reply.type('text/html').send(guard.renderLogin());
    if (!csrfValid(sessionId, ctx.env.COOKIE_SECRET, (req.body as Record<string, unknown>)?.['csrf'])) {
      return reply.status(403).send('bad csrf');
    }
    ctx.spotifyAuth.disconnect('admin disconnected');
    ctx.events.record('spotify_disconnected', { actor: 'admin' });
    return reply.redirect('/status');
  });

  /**
   * The proof-of-life page: which account, which devices Spotify can see,
   * whether our configured device is among them, and what is playing.
   *
   * Every lookup is independent and failure-tolerant — one dead call must not
   * blank the whole page, because this page is what an operator looks at
   * precisely when something is broken.
   */
  app.get('/status', async (req, reply) => {
    const sessionId = guard.requireSession(req);
    if (!sessionId) return reply.type('text/html').send(guard.renderLogin());

    const query = req.query as Record<string, unknown>;
    const settings = ctx.settings.all();
    const auth = ctx.spotifyAuth.status();

    const view: StatusView = {
      auth,
      csrf: csrfToken(sessionId, ctx.env.COOKIE_SECRET),
      deviceName: settings.device_name,
      devices: null,
      matchedDevice: null,
      playback: null,
      playlist: null,
      account: null,
      errors: [],
      ...(typeof query['error'] === 'string' ? { flashError: query['error'] } : {}),
      justConnected: query['connected'] === '1',
    };

    if (auth.connected) {
      // Run the four lookups together; collect failures rather than throwing.
      const [devices, playback, playlist, account] = await Promise.allSettled([
        ctx.spotify.getDevices(),
        ctx.spotify.getPlaybackState(),
        lookupPlaylist(ctx, settings.fallback_playlist_uri),
        ctx.spotify.getCurrentUser(),
      ]);

      if (devices.status === 'fulfilled') {
        view.devices = devices.value;
        view.matchedDevice = findDevice(devices.value, settings.device_name);
      } else {
        view.errors.push(describe('Device list', devices.reason));
      }

      if (playback.status === 'fulfilled') view.playback = playback.value;
      else view.errors.push(describe('Playback state', playback.reason));

      if (playlist.status === 'fulfilled') view.playlist = playlist.value;
      else view.errors.push(describe('Fallback playlist', playlist.reason));

      if (account.status === 'fulfilled') view.account = account.value;
      else view.errors.push(describe('Account', account.reason));
    }

    return reply.type('text/html').send(statusPage(view));
  });
}

async function lookupPlaylist(
  ctx: AppContext,
  uri: string,
): Promise<{ id: string; name: string } | null> {
  // Empty means the operator has not chosen one yet, which the status page
  // reports differently from a playlist it cannot read.
  if (uri === '') return null;
  const id = playlistIdFromUri(uri);
  if (!id) return null;
  return ctx.spotify.getPlaylist(id);
}

/** Case-insensitive match on the librespot `--name`, which is all we have to
 *  go on: the device id changes every time librespot restarts. */
export function findDevice(devices: SpotifyDevice[], name: string): SpotifyDevice | null {
  const wanted = name.trim().toLowerCase();
  return devices.find((d) => d.name.trim().toLowerCase() === wanted) ?? null;
}

function describe(label: string, reason: unknown): string {
  if (reason instanceof SpotifyError) return `${label}: ${reason.message}`;
  return `${label}: ${reason instanceof Error ? reason.message : 'unknown error'}`;
}
