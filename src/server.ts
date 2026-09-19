/** Fastify assembly: plugins, routes, error handling. */
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppContext } from './context.js';
import { log } from './log.js';
import { registerAdminRoutes } from './routes/admin/index.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerGuestRoutes } from './routes/guest/index.js';
import { registerPaymentRoutes } from './routes/payments.js';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, '..', 'public');

const STATIC_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    // We emit our own JSON lines; Fastify's logger would duplicate them.
    logger: false,
    trustProxy: true,
    bodyLimit: 64 * 1024,
  });

  await app.register(cookie, { secret: ctx.env.COOKIE_SECRET });
  await app.register(formbody);

  app.setErrorHandler((err: unknown, req, reply) => {
    log.error('unhandled route error', { err, method: req.method, url: req.url });
    const status = (err as { statusCode?: number }).statusCode;
    reply
      .status(status && status >= 400 && status < 500 ? status : 500)
      .type('text/html')
      .send('<h1>Something went wrong</h1><p>Try again in a moment.</p>');
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).type('text/html').send('<h1>Not found</h1>');
  });

  // Tiny static handler — a whole plugin is more than three files deserve.
  app.get<{ Params: { '*': string } }>('/static/*', async (req, reply) => {
    const requested = normalize(req.params['*']);
    if (requested.startsWith('..') || requested.includes('\0')) {
      return reply.status(400).send('bad path');
    }
    const ext = requested.slice(requested.lastIndexOf('.'));
    const type = STATIC_TYPES[ext];
    if (!type) return reply.status(404).send('not found');

    try {
      const body = readFileSync(join(PUBLIC_DIR, requested));
      return reply
        .type(type)
        .header('cache-control', ctx.env.NODE_ENV === 'production' ? 'public, max-age=3600' : 'no-store')
        .send(body);
    } catch {
      return reply.status(404).send('not found');
    }
  });

  app.get('/healthz', async () => ({ ok: true, uptime_s: Math.round(process.uptime()) }));

  // Before any other route: it installs the raw-body parser the webhook needs.
  registerPaymentRoutes(app, ctx);

  registerAdminRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerGuestRoutes(app, ctx);

  return app;
}
