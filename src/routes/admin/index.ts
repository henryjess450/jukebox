/** Admin routes: login, settings. Everything under /admin except the login
 *  endpoints requires a valid session. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../../context.js';
import { csrfToken, csrfValid } from '../../http/csrf.js';
import { log } from '../../log.js';
import { stripeConfigured } from '../../config/env.js';
import { CURRENCIES, SETTING_DEFS, type SettingKey } from '../../config/settings.js';
import {
  AdminSessions,
  clearAdminCookie,
  readAdminCookie,
  setAdminCookie,
  verifyAdminPassword,
} from './auth.js';
import { loginPage, settingsPage } from './views.js';
import { registerSpotifyRoutes, type AdminGuard } from './spotify.js';

const LoginBody = z.object({ password: z.string().min(1).max(200) });

/** Keys whose form value is a checkbox — absent means false. */
const BOOLEAN_KEYS = (Object.keys(SETTING_DEFS) as SettingKey[]).filter(
  (k) => SETTING_DEFS[k].default === true || SETTING_DEFS[k].default === false,
);
const NUMBER_KEYS = (Object.keys(SETTING_DEFS) as SettingKey[]).filter(
  (k) => typeof SETTING_DEFS[k].default === 'number',
);

/**
 * Translate an HTML form body into typed setting values. HTML gives us strings
 * and omits unchecked boxes; Zod then does the real validation in the store.
 */
export function parseSettingsForm(body: Record<string, unknown>): Partial<Record<SettingKey, unknown>> {
  const patch: Partial<Record<SettingKey, unknown>> = {};

  for (const key of BOOLEAN_KEYS) {
    patch[key] = body[key] === 'true' || body[key] === 'on' || body[key] === true;
  }

  for (const key of NUMBER_KEYS) {
    const raw = body[key];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    // Hand NaN through unchanged so Zod reports it rather than us guessing.
    patch[key] = Number.isNaN(n) ? raw : n;
  }

  for (const key of ['fallback_playlist_uri', 'device_name', 'market', 'venue_name'] as const) {
    const raw = body[key];
    if (typeof raw === 'string') patch[key] = raw.trim();
  }

  const currency = body['currency'];
  if (typeof currency === 'string' && (CURRENCIES as readonly string[]).includes(currency)) {
    patch['currency'] = currency;
  }

  return patch;
}

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const sessions = new AdminSessions();
  const secure = ctx.env.PUBLIC_URL.startsWith('https://');

  /** Shared with the Spotify routes, which live in their own module but on the
   *  same session. */
  const guard: AdminGuard = {
    requireSession: (req: FastifyRequest) => {
      const sessionId = readAdminCookie(req);
      return sessions.isValid(sessionId) ? (sessionId as string) : null;
    },
    renderLogin: () => loginPage({ error: 'Please sign in.' }),
  };

  /** Guard for every authenticated admin route. */
  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
    const sessionId = guard.requireSession(req);
    if (!sessionId) {
      await reply.type('text/html').send(guard.renderLogin());
      return null;
    }
    return sessionId;
  }

  /** Reject a POST whose CSRF token does not match the session. */
  function checkCsrf(sessionId: string, body: unknown): boolean {
    const token = (body as Record<string, unknown> | undefined)?.['csrf'];
    return csrfValid(sessionId, ctx.env.COOKIE_SECRET, token);
  }

  app.get('/admin', async (req, reply) => {
    const sessionId = readAdminCookie(req);
    if (!sessions.isValid(sessionId)) {
      return reply.type('text/html').send(loginPage({}));
    }
    return reply.type('text/html').send(
      settingsPage({
        settings: ctx.settings.all(),
        csrf: csrfToken(sessionId as string, ctx.env.COOKIE_SECRET),
        saved: (req.query as Record<string, unknown>)['saved'] === '1',
        stripeReady: stripeConfigured(ctx.env),
      }),
    );
  });

  app.post('/admin/login', async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).type('text/html').send(loginPage({ error: 'Enter a password.' }));
    }

    const ok = await verifyAdminPassword(parsed.data.password, ctx.env.ADMIN_PASSWORD_HASH);
    if (!ok) {
      ctx.events.record('admin_login_failed', { actor: 'admin' });
      log.warn('admin login failed');
      // Deliberately vague, and no timing signal beyond bcrypt's own cost.
      return reply
        .status(401)
        .type('text/html')
        .send(loginPage({ error: 'Incorrect password.' }));
    }

    const sessionId = sessions.create();
    setAdminCookie(reply, sessionId, secure);
    ctx.events.record('admin_login', { actor: 'admin' });
    log.info('admin signed in');
    return reply.redirect('/admin');
  });

  app.post('/admin/logout', async (req, reply) => {
    const sessionId = readAdminCookie(req);
    if (sessions.isValid(sessionId) && checkCsrf(sessionId as string, req.body)) {
      sessions.destroy(sessionId);
      ctx.events.record('admin_logout', { actor: 'admin' });
    }
    clearAdminCookie(reply);
    return reply.redirect('/admin');
  });

  app.post('/admin/settings', async (req, reply) => {
    const sessionId = await requireAdmin(req, reply);
    if (!sessionId) return reply;

    if (!checkCsrf(sessionId, req.body)) {
      log.warn('admin settings POST rejected: bad CSRF token');
      return reply.status(403).type('text/html').send(
        settingsPage({
          settings: ctx.settings.all(),
          csrf: csrfToken(sessionId, ctx.env.COOKIE_SECRET),
          errors: { csrf: 'Session expired — try again.' },
          stripeReady: stripeConfigured(ctx.env),
        }),
      );
    }

    const patch = parseSettingsForm((req.body ?? {}) as Record<string, unknown>);
    const result = ctx.settings.update(patch);

    if (!result.ok) {
      return reply.status(400).type('text/html').send(
        settingsPage({
          settings: ctx.settings.all(),
          csrf: csrfToken(sessionId, ctx.env.COOKIE_SECRET),
          errors: result.errors,
          // Echo the rejected input so the error sits next to what was typed.
          submitted: patch as Record<string, unknown>,
          stripeReady: stripeConfigured(ctx.env),
        }),
      );
    }

    ctx.events.record('settings_updated', { actor: 'admin', detail: { keys: Object.keys(patch) } });
    return reply.redirect('/admin?saved=1');
  });

  registerSpotifyRoutes(app, ctx, guard);
}
