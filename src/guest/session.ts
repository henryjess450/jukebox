/**
 * Guest identity.
 *
 * A signed cookie holding a random id. This is deliberately weak: a guest can
 * clear it, or open a private tab, and look new. That is acceptable — the
 * cookie exists to make the *honest* path pleasant (your requests, your
 * position in the queue, your cooldown), not to stop a determined person.
 * The real backstop is the per-IP limit and the queue length cap.
 *
 * We never store a raw IP address. The hash is salted with the cookie secret,
 * so the database cannot be used to work out who was in the room.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const GUEST_COOKIE = 'jb_guest';
const GUEST_TTL_S = 12 * 60 * 60;

/** Read the guest's id, minting and setting one if this is their first visit. */
export function ensureGuestSession(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: { secure: boolean },
): string {
  const existing = readGuestSession(req);
  if (existing) return existing;

  const id = randomUUID();
  reply.setCookie(GUEST_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: opts.secure,
    signed: true,
    maxAge: GUEST_TTL_S,
  });
  return id;
}

export function readGuestSession(req: FastifyRequest): string | null {
  const raw = req.cookies[GUEST_COOKIE];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : null;
}

/**
 * A stable, non-reversible handle for the requesting address.
 *
 * `trustProxy` is on, so `req.ip` is the client address Cloudflare reports
 * rather than the tunnel's own. On venue Wi-Fi most guests share one NAT'd
 * address, which is exactly why the per-IP limit is a venue-wide burst
 * control and not a per-person quota.
 */
export function hashIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(`ip:${ip}`).digest('base64url').slice(0, 22);
}

/**
 * A fixed-window rate limiter, in memory.
 *
 * In memory is the right scope here: there is one process, and a restart
 * clearing the counters is harmless. Windows are swept lazily so an evening's
 * worth of addresses does not accumulate.
 */
export class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  readonly #windowMs: number;

  constructor(windowMs = 60_000) {
    this.#windowMs = windowMs;
  }

  /** Record an attempt and report whether it is within the limit. */
  check(key: string, limit: number, now = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const cutoff = now - this.#windowMs;
    const recent = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);

    if (recent.length >= limit) {
      const oldest = recent[0] as number;
      this.#hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.#windowMs - now) };
    }

    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > 512) this.#sweep(cutoff);
    return { allowed: true, retryAfterMs: 0 };
  }

  #sweep(cutoff: number): void {
    for (const [key, times] of this.#hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length === 0) this.#hits.delete(key);
      else this.#hits.set(key, kept);
    }
  }
}
