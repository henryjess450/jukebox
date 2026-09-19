/**
 * One error type for everything that can go wrong talking to Spotify, with a
 * machine-readable `code` so callers can branch without string-matching
 * messages, and a `guestMessage` for anything a guest might be shown.
 */

export type SpotifyErrorCode =
  | 'unauthorized'      // 401 — token is dead and refreshing did not help
  | 'forbidden'         // 403 — usually "Premium required" or a missing scope
  | 'rate_limited'      // 429
  | 'no_active_device'  // 404 from a player endpoint, or an empty device list
  | 'not_found'         // 404 for a track/playlist
  | 'bad_request'       // 400
  | 'server'            // 5xx
  | 'timeout'
  | 'network'
  | 'malformed';        // the response did not match what we expect

export class SpotifyError extends Error {
  readonly code: SpotifyErrorCode;
  readonly status: number | undefined;
  /** Milliseconds the API asked us to wait, when it said so. */
  readonly retryAfterMs: number | undefined;
  readonly endpoint: string | undefined;

  constructor(
    code: SpotifyErrorCode,
    message: string,
    opts: { status?: number; retryAfterMs?: number; endpoint?: string; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'SpotifyError';
    this.code = code;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.endpoint = opts.endpoint;
  }

  /** True when trying the same call again later could plausibly work. */
  get transient(): boolean {
    return (
      this.code === 'rate_limited' ||
      this.code === 'server' ||
      this.code === 'timeout' ||
      this.code === 'network'
    );
  }

  /** Safe to show a guest: never leaks endpoints, tokens or account details. */
  get guestMessage(): string {
    switch (this.code) {
      case 'rate_limited':
        return 'The jukebox is busy right now. Try again in a moment.';
      case 'no_active_device':
        return 'The speaker is offline. Ask someone behind the bar.';
      case 'not_found':
        return 'That track is not available here.';
      case 'timeout':
      case 'network':
      case 'server':
        return 'Spotify is not responding. Try again in a moment.';
      default:
        return 'Something went wrong. Try again in a moment.';
    }
  }

  /** For the structured log — never includes the token. */
  toLogFields(): Record<string, unknown> {
    return {
      code: this.code,
      status: this.status,
      endpoint: this.endpoint,
      retry_after_ms: this.retryAfterMs,
      message: this.message,
    };
  }
}

/** Map an HTTP status onto our taxonomy. */
export function codeForStatus(status: number, isPlayerEndpoint: boolean): SpotifyErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status === 404) return isPlayerEndpoint ? 'no_active_device' : 'not_found';
  if (status >= 500) return 'server';
  return 'bad_request';
}
