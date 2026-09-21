/**
 * Typed wrappers over the Spotify endpoints this app uses.
 *
 * Every method returns our own shapes, never Spotify's, so the rest of the app
 * never learns the API's vocabulary. Playback commands are idempotent from our
 * side: issuing the same one twice is always safe.
 */
import { z } from 'zod';
import { SpotifyError } from './errors.js';
import { SpotifyHttp, type RequestOptions } from './http.js';
import {
  DevicesResponseSchema,
  PlaybackStateSchema,
  PlaylistSchema,
  QueueResponseSchema,
  SearchResponseSchema,
  TrackSchema,
  UserProfileSchema,
  toTrack,
  type PlaybackState,
  type SpotifyDevice,
  type Track,
  type UserProfile,
} from './types.js';

/**
 * Spotify rejects a search `limit` above 10 with "Invalid limit", despite the
 * documentation saying 50. Apps created after the November 2024 changes are
 * capped at 10, and omitting the parameter defaults to 5. Verified against the
 * live API — going over this breaks search completely, not partially.
 */
export const SEARCH_LIMIT_MAX = 10;

/** A guest is waiting on a search, so it gets a tight budget and no long 429 wait. */
const INTERACTIVE: RequestOptions = { timeoutMs: 5_000, maxAttempts: 2, maxRetryAfterMs: 2_000 };
/** The poll loop can afford to be patient; nobody is watching a spinner. */
const BACKGROUND: RequestOptions = { timeoutMs: 8_000, maxAttempts: 3, maxRetryAfterMs: 10_000 };

export interface PlayerSnapshot {
  device: SpotifyDevice | null;
  isPlaying: boolean;
  progressMs: number | null;
  repeatState: 'off' | 'track' | 'context';
  contextUri: string | null;
  track: Track | null;
}

export class SpotifyClient {
  readonly #http: SpotifyHttp;

  constructor(http: SpotifyHttp) {
    this.#http = http;
  }

  // --- reads ----------------------------------------------------------------

  async search(query: string, market: string, limit = SEARCH_LIMIT_MAX): Promise<Track[]> {
    const trimmed = query.trim();
    if (trimmed === '') return [];

    const body = await this.#http.request<unknown>('/search', {
      ...INTERACTIVE,
      // Clamped rather than trusted: a caller asking for more gets fewer
      // results, not a 400 that looks like the search is broken.
      query: { q: trimmed, type: 'track', market, limit: Math.min(limit, SEARCH_LIMIT_MAX) },
    });

    const parsed = this.#parse(SearchResponseSchema, body, '/search');
    return parsed.tracks.items
      .filter((item): item is NonNullable<typeof item> => item !== null)
      // `is_playable` is false for tracks unavailable in this market; offering
      // them guarantees a request that silently never plays.
      .filter((item) => item.is_playable !== false)
      .map(toTrack);
  }

  async getTrack(trackId: string, market: string): Promise<Track> {
    const body = await this.#http.request<unknown>(`/tracks/${encodeURIComponent(trackId)}`, {
      ...INTERACTIVE,
      query: { market },
    });
    return toTrack(this.#parse(TrackSchema, body, '/tracks'));
  }

  /** Current playback, or null when Spotify reports nothing active (204). */
  async getPlaybackState(): Promise<PlayerSnapshot | null> {
    const body = await this.#http.request<unknown>('/me/player', {
      ...BACKGROUND,
      isPlayerEndpoint: true,
    });
    if (body === null) return null;

    const state: PlaybackState = this.#parse(PlaybackStateSchema, body, '/me/player');
    return {
      device: state.device,
      isPlaying: state.is_playing,
      progressMs: state.progress_ms,
      repeatState: state.repeat_state,
      contextUri: state.context?.uri ?? null,
      track: state.item ? toTrack(state.item) : null,
    };
  }

  async getDevices(): Promise<SpotifyDevice[]> {
    const body = await this.#http.request<unknown>('/me/player/devices', BACKGROUND);
    if (body === null) return [];
    return this.#parse(DevicesResponseSchema, body, '/me/player/devices').devices;
  }

  /** Spotify's own view of what plays next. Read-only — it cannot be reordered
   *  or emptied through the API, which is why our database holds the queue. */
  async getQueue(): Promise<{ currentlyPlaying: Track | null; upNext: Track[] }> {
    const body = await this.#http.request<unknown>('/me/player/queue', {
      ...BACKGROUND,
      isPlayerEndpoint: true,
    });
    if (body === null) return { currentlyPlaying: null, upNext: [] };

    const parsed = this.#parse(QueueResponseSchema, body, '/me/player/queue');
    return {
      currentlyPlaying: parsed.currently_playing ? toTrack(parsed.currently_playing) : null,
      upNext: parsed.queue.filter((t): t is NonNullable<typeof t> => t !== null).map(toTrack),
    };
  }

  /**
   * Confirm the fallback playlist exists and get its name.
   *
   * No track count: the current API returns neither `tracks.total` on the
   * playlist nor an accessible `/playlists/{id}/tracks` endpoint (403 for
   * apps in development mode), whatever the documentation says. We only need
   * to know the playlist is readable, which a 200 here establishes.
   */
  async getPlaylist(playlistId: string): Promise<{ id: string; name: string }> {
    const body = await this.#http.request<unknown>(`/playlists/${encodeURIComponent(playlistId)}`, {
      ...BACKGROUND,
      query: { fields: 'id,uri,name,owner(display_name)' },
    });
    const parsed = this.#parse(PlaylistSchema, body, '/playlists');
    return { id: parsed.id, name: parsed.name };
  }

  async getCurrentUser(): Promise<UserProfile> {
    const body = await this.#http.request<unknown>('/me', BACKGROUND);
    return this.#parse(UserProfileSchema, body, '/me');
  }

  // --- playback commands ----------------------------------------------------

  /** Insert a track directly after whatever is playing. Stacks in call order. */
  async addToQueue(trackUri: string, deviceId?: string): Promise<void> {
    await this.#http.request('/me/player/queue', {
      ...BACKGROUND,
      method: 'POST',
      query: { uri: trackUri, device_id: deviceId },
      isPlayerEndpoint: true,
    });
  }

  async skipToNext(deviceId?: string): Promise<void> {
    await this.#http.request('/me/player/next', {
      ...BACKGROUND,
      method: 'POST',
      query: { device_id: deviceId },
      isPlayerEndpoint: true,
    });
  }

  /**
   * Start a context (our fallback playlist).
   *
   * `offset` is accepted but the engine no longer uses it: the API gives us no
   * way to learn how many tracks a playlist has, so there is no safe upper
   * bound for a random position. Shuffle achieves the same thing — a different
   * song every evening — without needing a count.
   */
  async playContext(contextUri: string, deviceId?: string, offsetPosition?: number): Promise<void> {
    await this.#http.request('/me/player/play', {
      ...BACKGROUND,
      method: 'PUT',
      query: { device_id: deviceId },
      body: {
        context_uri: contextUri,
        ...(offsetPosition !== undefined ? { offset: { position: offsetPosition } } : {}),
      },
      isPlayerEndpoint: true,
    });
  }

  /** Resume without changing what is loaded. */
  async resume(deviceId?: string): Promise<void> {
    await this.#http.request('/me/player/play', {
      ...BACKGROUND,
      method: 'PUT',
      query: { device_id: deviceId },
      isPlayerEndpoint: true,
    });
  }

  async pause(deviceId?: string): Promise<void> {
    await this.#http.request('/me/player/pause', {
      ...BACKGROUND,
      method: 'PUT',
      query: { device_id: deviceId },
      isPlayerEndpoint: true,
    });
  }

  /** Point playback at a device — how we recover when librespot restarts with
   *  a new device id. `play: true` resumes rather than transferring paused. */
  async transferPlayback(deviceId: string, play = true): Promise<void> {
    await this.#http.request('/me/player', {
      ...BACKGROUND,
      method: 'PUT',
      body: { device_ids: [deviceId], play },
      isPlayerEndpoint: true,
    });
  }

  async setRepeat(state: 'off' | 'track' | 'context', deviceId?: string): Promise<void> {
    await this.#http.request('/me/player/repeat', {
      ...BACKGROUND,
      method: 'PUT',
      query: { state, device_id: deviceId },
      isPlayerEndpoint: true,
    });
  }

  async setShuffle(state: boolean, deviceId?: string): Promise<void> {
    await this.#http.request('/me/player/shuffle', {
      ...BACKGROUND,
      method: 'PUT',
      query: { state, device_id: deviceId },
      isPlayerEndpoint: true,
    });
  }

  /** Spotify-side volume. ALSA volume is separate and set with amixer. */
  async setVolume(percent: number, deviceId?: string): Promise<void> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    await this.#http.request('/me/player/volume', {
      ...BACKGROUND,
      method: 'PUT',
      query: { volume_percent: clamped, device_id: deviceId },
      isPlayerEndpoint: true,
    });
  }

  #parse<T>(schema: z.ZodType<T>, body: unknown, endpoint: string): T {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new SpotifyError('malformed', `Unexpected response shape from ${endpoint}`, {
        endpoint,
        cause: result.error,
      });
    }
    return result.data;
  }
}

/** `spotify:playlist:37i9…` → `37i9…`; also accepts a bare id or an open.spotify URL. */
export function playlistIdFromUri(uri: string): string | null {
  const uriMatch = /^spotify:playlist:([A-Za-z0-9]+)$/.exec(uri.trim());
  if (uriMatch?.[1]) return uriMatch[1];
  const urlMatch = /open\.spotify\.com\/playlist\/([A-Za-z0-9]+)/.exec(uri.trim());
  if (urlMatch?.[1]) return urlMatch[1];
  if (/^[A-Za-z0-9]{22}$/.test(uri.trim())) return uri.trim();
  return null;
}
