/**
 * Admin authentication: one shared password, hashed with bcrypt in the
 * environment. There is no user table and no default password — if
 * ADMIN_PASSWORD_HASH is absent the process refuses to boot (see config/env).
 *
 * The session is a signed cookie holding an opaque id; sessions live in memory
 * and are therefore dropped on restart, which is the behaviour we want on a box
 * that restarts unattended.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyReply, FastifyRequest } from 'fastify';

export const ADMIN_COOKIE = 'jb_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  id: string;
  expiresAt: number;
}

export class AdminSessions {
  readonly #sessions = new Map<string, Session>();

  create(): string {
    this.#sweep();
    const id = randomUUID();
    this.#sessions.set(id, { id, expiresAt: Date.now() + SESSION_TTL_MS });
    return id;
  }

  isValid(id: string | undefined): boolean {
    if (!id) return false;
    const session = this.#sessions.get(id);
    if (!session) return false;
    if (session.expiresAt < Date.now()) {
      this.#sessions.delete(id);
      return false;
    }
    return true;
  }

  destroy(id: string | undefined): void {
    if (id) this.#sessions.delete(id);
  }

  #sweep(): void {
    const cutoff = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt < cutoff) this.#sessions.delete(id);
    }
  }
}

/** Verify a submitted password against the configured bcrypt hash. */
export async function verifyAdminPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/** Constant-time compare, for CSRF tokens. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Read the signed admin cookie, returning the session id if the signature holds. */
export function readAdminCookie(req: FastifyRequest): string | undefined {
  const raw = req.cookies[ADMIN_COOKIE];
  if (!raw) return undefined;
  const unsigned = req.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : undefined;
}

/**
 * Path is `/` rather than `/admin`: the status page lives at `/status`, and a
 * cookie scoped to `/admin` would never be sent there, making the page
 * unreachable no matter how correct the session is. Everything else that
 * protects this cookie — httpOnly, SameSite, signing, Secure over HTTPS — is
 * unchanged by the wider path.
 */
export function setAdminCookie(reply: FastifyReply, sessionId: string, secure: boolean): void {
  reply.setCookie(ADMIN_COOKIE, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    signed: true,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearAdminCookie(reply: FastifyReply): void {
  reply.clearCookie(ADMIN_COOKIE, { path: '/' });
}
