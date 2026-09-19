/**
 * Spotify OAuth, Authorization Code flow with a persisted refresh token.
 *
 * Client Credentials cannot control playback, so this is the only flow that
 * works for us. The owner authorizes once from the admin panel; the refresh
 * token then lives in the database and survives restarts indefinitely, which
 * is what lets the box run unattended for weeks.
 */
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { now } from '../db/index.js';
import { log } from '../log.js';
import { SpotifyError } from './errors.js';

const ACCOUNTS_BASE = 'https://accounts.spotify.com';

/**
 * Least privilege that still does the job:
 * - read/modify playback state: the whole point
 * - read currently playing: the reconciler's input
 * - read private playlists: so an operator can use an unlisted fallback list
 * - read private (user profile): shows which account is connected, and its country
 */
export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-private',
] as const;

/** Refresh this far before actual expiry, so a request never races the clock. */
const REFRESH_SKEW_MS = 60_000;

const TokenResponse = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number(),
  // Absent on refresh — Spotify only sometimes rotates it.
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

interface AuthRow {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string;
  account_name: string | null;
  updated_at: string;
}

export interface ConnectionStatus {
  connected: boolean;
  accountName: string | null;
  scopes: string[];
  expiresAt: string | null;
  /** True when the stored scopes no longer cover what the app needs — happens
   *  after an upgrade adds a scope, and requires re-authorizing. */
  missingScopes: string[];
}

export class SpotifyAuth {
  readonly #db: Db;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #stateSecret: string;
  readonly #fetch: typeof fetch;

  /** Single-flight guard: concurrent callers share one refresh round trip
   *  rather than each burning the refresh token in parallel. */
  #refreshInFlight: Promise<string> | null = null;

  constructor(opts: {
    db: Db;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    stateSecret: string;
    fetchImpl?: typeof fetch;
  }) {
    this.#db = opts.db;
    this.#clientId = opts.clientId;
    this.#clientSecret = opts.clientSecret;
    this.#redirectUri = opts.redirectUri;
    this.#stateSecret = opts.stateSecret;
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  // --- the authorize step ---------------------------------------------------

  /**
   * Build the URL the operator is sent to, with a signed `state` so the
   * callback can prove it belongs to a flow we started. The nonce is signed
   * rather than stored, so a restart mid-flow does not strand the operator.
   */
  authorizeUrl(): string {
    const nonce = randomBytes(16).toString('base64url');
    const state = `${nonce}.${this.#signState(nonce)}`;
    const url = new URL('/authorize', ACCOUNTS_BASE);
    url.searchParams.set('client_id', this.#clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', this.#redirectUri);
    url.searchParams.set('scope', SPOTIFY_SCOPES.join(' '));
    url.searchParams.set('state', state);
    // Always show the account chooser: on a shared box, silently reusing
    // whoever is logged into the browser is a trap.
    url.searchParams.set('show_dialog', 'true');
    return url.toString();
  }

  verifyState(state: unknown): boolean {
    if (typeof state !== 'string') return false;
    const [nonce, signature] = state.split('.');
    if (!nonce || !signature) return false;
    const expected = Buffer.from(this.#signState(nonce));
    const got = Buffer.from(signature);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  #signState(nonce: string): string {
    return createHmac('sha256', this.#stateSecret).update(`spotify-state:${nonce}`).digest('base64url');
  }

  // --- the token steps ------------------------------------------------------

  /** Exchange the callback's `code` for tokens and store them. */
  async exchangeCode(code: string): Promise<void> {
    const parsed = await this.#tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.#redirectUri,
    });

    if (!parsed.refresh_token) {
      throw new SpotifyError(
        'bad_request',
        'Spotify did not return a refresh token. Re-authorize and approve all requested permissions.',
      );
    }

    this.#persist({
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token,
      expiresIn: parsed.expires_in,
      scope: parsed.scope ?? SPOTIFY_SCOPES.join(' '),
    });
    log.info('spotify connected', { scopes: parsed.scope });
  }

  /** A valid access token, refreshing first if it is close to expiry. */
  async getAccessToken(): Promise<string> {
    const row = this.#row();
    if (!row) {
      throw new SpotifyError(
        'unauthorized',
        'Spotify is not connected. Connect it from the admin panel.',
      );
    }
    if (Date.parse(row.expires_at) - REFRESH_SKEW_MS > Date.now()) {
      return row.access_token;
    }
    return this.refresh();
  }

  /**
   * Force a refresh. Concurrent callers wait on the same promise — without
   * this, a burst of 401s would fire N refreshes and Spotify would rate-limit
   * us for it.
   */
  async refresh(): Promise<string> {
    if (this.#refreshInFlight) return this.#refreshInFlight;

    this.#refreshInFlight = this.#doRefresh().finally(() => {
      this.#refreshInFlight = null;
    });
    return this.#refreshInFlight;
  }

  async #doRefresh(): Promise<string> {
    const row = this.#row();
    if (!row) {
      throw new SpotifyError('unauthorized', 'Spotify is not connected.');
    }

    const parsed = await this.#tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    });

    this.#persist({
      accessToken: parsed.access_token,
      // Spotify rotates the refresh token only sometimes; keep the old one
      // when it does not, or the next refresh has nothing to use.
      refreshToken: parsed.refresh_token ?? row.refresh_token,
      expiresIn: parsed.expires_in,
      scope: parsed.scope ?? row.scope,
    });

    log.info('spotify access token refreshed', { expires_in_s: parsed.expires_in });
    return parsed.access_token;
  }

  async #tokenRequest(params: Record<string, string>): Promise<z.infer<typeof TokenResponse>> {
    const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);

    let response: Response;
    try {
      response = await this.#fetch(`${ACCOUNTS_BASE}/api/token`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(params).toString(),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new SpotifyError(aborted ? 'timeout' : 'network', 'Could not reach Spotify accounts', {
        endpoint: '/api/token',
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (!response.ok) {
      // The body names the real problem — invalid_grant means the refresh
      // token was revoked, which needs a human, not a retry.
      let detail = '';
      try {
        const body = JSON.parse(text) as { error?: string; error_description?: string };
        detail = body.error_description ?? body.error ?? '';
        if (body.error === 'invalid_grant') {
          this.disconnect('refresh token rejected by Spotify');
          throw new SpotifyError(
            'unauthorized',
            'Spotify rejected the saved authorization. Reconnect from the admin panel.',
            { status: response.status, endpoint: '/api/token' },
          );
        }
      } catch (err) {
        if (err instanceof SpotifyError) throw err;
      }
      throw new SpotifyError('unauthorized', detail || `Token request failed (${response.status})`, {
        status: response.status,
        endpoint: '/api/token',
      });
    }

    try {
      return TokenResponse.parse(JSON.parse(text));
    } catch (err) {
      throw new SpotifyError('malformed', 'Token response was not in the expected shape', {
        endpoint: '/api/token',
        cause: err,
      });
    }
  }

  // --- state ----------------------------------------------------------------

  #persist(opts: { accessToken: string; refreshToken: string; expiresIn: number; scope: string }): void {
    const expiresAt = new Date(Date.now() + opts.expiresIn * 1000).toISOString();
    this.#db
      .prepare(
        `INSERT INTO spotify_auth (id, access_token, refresh_token, expires_at, scope, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           scope = excluded.scope,
           updated_at = excluded.updated_at`,
      )
      .run(opts.accessToken, opts.refreshToken, expiresAt, opts.scope, now());
  }

  /** Record which account this is, for the status page. */
  setAccountName(name: string): void {
    this.#db.prepare('UPDATE spotify_auth SET account_name = ? WHERE id = 1').run(name);
  }

  #row(): AuthRow | undefined {
    return this.#db.prepare('SELECT * FROM spotify_auth WHERE id = 1').get() as AuthRow | undefined;
  }

  isConnected(): boolean {
    return this.#row() !== undefined;
  }

  status(): ConnectionStatus {
    const row = this.#row();
    if (!row) {
      return { connected: false, accountName: null, scopes: [], expiresAt: null, missingScopes: [] };
    }
    const granted = row.scope.split(/\s+/).filter(Boolean);
    return {
      connected: true,
      accountName: row.account_name,
      scopes: granted,
      expiresAt: row.expires_at,
      missingScopes: SPOTIFY_SCOPES.filter((s) => !granted.includes(s)),
    };
  }

  disconnect(reason: string): void {
    this.#db.prepare('DELETE FROM spotify_auth WHERE id = 1').run();
    log.warn('spotify disconnected', { reason });
  }
}
