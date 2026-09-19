/**
 * CSRF protection for admin forms.
 *
 * The token is an HMAC of the session id, so it needs no storage and is
 * invalidated automatically when the session changes. Admin cookies are
 * SameSite=Lax, which already blocks cross-site POSTs in current browsers;
 * this is the belt to that's braces.
 */
import { createHmac } from 'node:crypto';
import { safeEqual } from '../routes/admin/auth.js';

export function csrfToken(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(`csrf:${sessionId}`).digest('base64url');
}

export function csrfValid(sessionId: string, secret: string, submitted: unknown): boolean {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  return safeEqual(csrfToken(sessionId, secret), submitted);
}
