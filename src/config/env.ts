/**
 * Process environment. Validated once at boot; the process refuses to start
 * if anything required is missing or malformed. Secrets live here only —
 * they are never written to the database and never logged.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

loadDotenv();

/** A bcrypt hash, any of the common prefixes, 60 chars. */
const bcryptHash = z
  .string()
  .regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, 'must be a bcrypt hash (see: npm run hash-password)');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  /**
   * Public origin guests reach us on (Cloudflare Tunnel hostname). Used for
   * Spotify's redirect URI and Stripe's return URLs. No trailing slash.
   *
   * Spotify rejects `localhost` in a redirect URI, and rejects plain HTTP for
   * anything that is not a loopback literal. Checked here so a misconfigured
   * box fails at boot rather than at the Spotify error page.
   */
  PUBLIC_URL: z
    .string()
    .url()
    .transform((u) => u.replace(/\/+$/, ''))
    .refine((u) => !/^https?:\/\/localhost(:|$|\/)/i.test(u), {
      message:
        'Spotify rejects "localhost" in a redirect URI. Use http://127.0.0.1:<port> for local testing, or your public HTTPS hostname.',
    })
    .refine(
      (u) =>
        u.startsWith('https://') ||
        /^http:\/\/(127\.0\.0\.1|\[::1\])(:|$|\/)/.test(u),
      {
        message:
          'Spotify only allows plain HTTP for loopback addresses. Use https://… or http://127.0.0.1:<port>.',
      },
    ),

  DATABASE_PATH: z.string().default('./jukebox.db'),

  /** Signs session cookies. Rotating it logs everyone out, which is harmless. */
  COOKIE_SECRET: z.string().min(32, 'must be at least 32 characters'),

  ADMIN_PASSWORD_HASH: bcryptHash,

  /**
   * Point the API client somewhere other than Spotify. Development only —
   * `loadEnv` ignores it under NODE_ENV=production, so a misconfigured box can
   * never silently talk to the wrong host.
   */
  SPOTIFY_API_BASE: z.string().url().optional(),

  SPOTIFY_CLIENT_ID: z.string().min(1),
  SPOTIFY_CLIENT_SECRET: z.string().min(1),

  /** Optional; paid mode requires the secret key. */
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

  /**
   * Point the Stripe SDK at a local mock. Development only, and stripped
   * under NODE_ENV=production exactly like SPOTIFY_API_BASE — a live box must
   * never send a real payment anywhere but Stripe.
   */
  STRIPE_API_BASE: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Treat an empty value as absent.
 *
 * `.env.example` ships keys with nothing after the `=`, which is how you say
 * "not configured" in a dotenv file. Without this, copying the example and
 * filling in only what you need leaves `STRIPE_SECRET_KEY=` behind and the
 * process refuses to boot over a variable that is genuinely optional.
 */
function dropEmpty(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}

/**
 * Parse and freeze the environment. Throws with an operator-readable message;
 * `main` catches it, prints, and exits non-zero so systemd shows the reason.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(dropEmpty(source));
  if (!parsed.success) {
    throw new Error(
      `Invalid environment — refusing to start:\n${formatIssues(parsed.error)}\n\n` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    delete (env as { SPOTIFY_API_BASE?: string }).SPOTIFY_API_BASE;
    delete (env as { STRIPE_API_BASE?: string }).STRIPE_API_BASE;
  }
  return Object.freeze(env);
}

/** True when Stripe can take a payment. The webhook secret is not required
 *  for that — the primary confirmation path is a server-side session lookup. */
export function stripeConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

/** True when the secondary (webhook) confirmation path is also available. */
export function stripeWebhookConfigured(env: Env): boolean {
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}
