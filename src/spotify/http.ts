/**
 * The single place any HTTP request leaves this process for Spotify.
 *
 * Every call gets a timeout, bounded retries with jittered backoff, explicit
 * 429 handling that honours `Retry-After`, and one 401 recovery attempt via a
 * token refresh. Nothing above this layer sees a raw `fetch`.
 */
import { codeForStatus, SpotifyError } from './errors.js';
import { log } from '../log.js';

/** Injected so tests can drive this without a network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query parameters; undefined values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** Attempts in total, including the first. */
  maxAttempts?: number;
  /**
   * Longest we are willing to sit out a 429. A guest waiting on a search will
   * not tolerate 30 seconds, so interactive callers pass something small and
   * take the error instead.
   */
  maxRetryAfterMs?: number;
  /** Player endpoints report "no active device" as a 404; everything else 404s
   *  because the thing genuinely is not there. */
  isPlayerEndpoint?: boolean;
}

export interface HttpClientOptions {
  fetchImpl?: FetchLike;
  /** Returns a valid access token, refreshing if needed. */
  getAccessToken: () => Promise<string>;
  /** Forces a refresh after a 401. Returns the new token, or throws. */
  refreshAccessToken: () => Promise<string>;
  /** Overridable so tests need not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
const API_BASE = 'https://api.spotify.com/v1';

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with full jitter, so a restart storm does not sync up. */
export function backoffMs(attempt: number): number {
  const ceiling = Math.min(250 * 2 ** (attempt - 1), 4_000);
  return Math.round(Math.random() * ceiling);
}

/** Spotify sends Retry-After in whole seconds. Absent or junk → treat as 1s. */
export function parseRetryAfterMs(header: string | null): number {
  if (!header) return 1_000;
  const seconds = Number(header.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return 1_000;
  return Math.round(seconds * 1_000);
}

export class SpotifyHttp {
  readonly #fetch: FetchLike;
  readonly #getToken: () => Promise<string>;
  readonly #refreshToken: () => Promise<string>;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #baseUrl: string;

  constructor(opts: HttpClientOptions) {
    this.#fetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.#getToken = opts.getAccessToken;
    this.#refreshToken = opts.refreshAccessToken;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#baseUrl = opts.baseUrl ?? API_BASE;
  }

  /** Perform a request and parse JSON. Returns `null` for 204/empty bodies,
   *  which the player endpoints use for every successful command. */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T | null> {
    const {
      method = 'GET',
      query,
      body,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      maxAttempts = DEFAULT_MAX_ATTEMPTS,
      maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
      isPlayerEndpoint = false,
    } = options;

    const url = this.#buildUrl(path, query);
    let refreshed = false;
    let lastError: SpotifyError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      const token = await this.#getToken();

      try {
        response = await this.#fetchWithTimeout(url, method, body, token, timeoutMs);
      } catch (err) {
        lastError = this.#networkError(err, path, timeoutMs);
        if (attempt < maxAttempts) {
          await this.#sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (response.ok) return this.#parseBody<T>(response, path);

      // 401: the token died mid-flight. Refresh once, then retry immediately —
      // this does not consume an attempt, because nothing was wrong with the
      // request itself.
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        log.warn('spotify 401; refreshing access token', { endpoint: path });
        try {
          await this.#refreshToken();
        } catch (err) {
          throw new SpotifyError('unauthorized', 'Access token expired and refresh failed', {
            status: 401,
            endpoint: path,
            cause: err,
          });
        }
        attempt--; // the refresh is not a failed attempt
        continue;
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        lastError = new SpotifyError('rate_limited', `Rate limited by Spotify`, {
          status: 429,
          retryAfterMs,
          endpoint: path,
        });
        // Waiting longer than the caller can tolerate is worse than failing.
        if (retryAfterMs > maxRetryAfterMs || attempt >= maxAttempts) throw lastError;
        log.warn('spotify rate limited; waiting', { endpoint: path, retry_after_ms: retryAfterMs });
        await this.#sleep(retryAfterMs);
        continue;
      }

      const error = await this.#httpError(response, path, isPlayerEndpoint);
      if (error.code === 'server' && attempt < maxAttempts) {
        lastError = error;
        await this.#sleep(backoffMs(attempt));
        continue;
      }
      throw error;
    }

    throw lastError ?? new SpotifyError('network', 'Request failed', { endpoint: path });
  }

  #buildUrl(path: string, query: RequestOptions['query']): string {
    const url = new URL(path.startsWith('http') ? path : `${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async #fetchWithTimeout(
    url: string,
    method: string,
    body: unknown,
    token: string,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #parseBody<T>(response: Response, path: string): Promise<T | null> {
    if (response.status === 204) return null;
    const text = await response.text();
    if (text.trim() === '') return null;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new SpotifyError('malformed', 'Spotify returned a body that was not JSON', {
        status: response.status,
        endpoint: path,
        cause: err,
      });
    }
  }

  #networkError(err: unknown, path: string, timeoutMs: number): SpotifyError {
    const aborted = err instanceof Error && err.name === 'AbortError';
    return aborted
      ? new SpotifyError('timeout', `Spotify did not respond within ${timeoutMs}ms`, {
          endpoint: path,
          cause: err,
        })
      : new SpotifyError('network', 'Could not reach Spotify', { endpoint: path, cause: err });
  }

  /** Spotify puts a useful sentence in `error.message`; surface it in logs. */
  async #httpError(response: Response, path: string, isPlayerEndpoint: boolean): Promise<SpotifyError> {
    let detail = '';
    try {
      const parsed = JSON.parse(await response.text()) as { error?: { message?: string } };
      detail = parsed.error?.message ?? '';
    } catch {
      // Body was not JSON; the status alone will have to do.
    }
    const code = codeForStatus(response.status, isPlayerEndpoint);
    return new SpotifyError(code, detail || `Spotify returned ${response.status}`, {
      status: response.status,
      endpoint: path,
    });
  }
}
