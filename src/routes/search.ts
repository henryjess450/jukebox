/**
 * Track search, as JSON, for the guest page's debounced search box.
 *
 * Public by design — a guest has no account. Abuse controls (per-IP limits)
 * arrive in milestone 6; what is here already refuses to answer when the
 * jukebox is not accepting requests, so a closed room does not advertise a
 * working search.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { log } from '../log.js';
import { SpotifyError } from '../spotify/errors.js';
import { SEARCH_LIMIT_MAX } from '../spotify/client.js';
import { formatDuration, type Track } from '../spotify/types.js';

const SearchQuery = z.object({
  q: z.string().min(1).max(120),
  // Spotify rejects anything above 10 outright; see SEARCH_LIMIT_MAX.
  limit: z.coerce.number().int().min(1).max(SEARCH_LIMIT_MAX).optional(),
});

export interface SearchResultDto {
  id: string;
  uri: string;
  name: string;
  artist: string;
  album: string;
  albumArtUrl: string | null;
  durationMs: number;
  duration: string;
  explicit: boolean;
}

export function toDto(track: Track): SearchResultDto {
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artist: track.artist,
    album: track.album,
    albumArtUrl: track.albumArtUrl,
    durationMs: track.durationMs,
    duration: formatDuration(track.durationMs),
    explicit: track.explicit,
  };
}

/**
 * Filters that apply to what a guest is even shown. Anything hidden here is
 * also re-checked when the request is submitted — a filtered list is a
 * courtesy, not a security boundary.
 */
export function applySearchFilters(
  tracks: Track[],
  opts: { explicitFilter: boolean; maxDurationMs: number },
): Track[] {
  return tracks.filter((t) => {
    if (opts.explicitFilter && t.explicit) return false;
    if (t.durationMs > opts.maxDurationMs) return false;
    return true;
  });
}

export function registerSearchRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/search', async (req, reply) => {
    const parsed = SearchQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Enter something to search for.' });
    }

    if (!ctx.settings.get('accepting_requests')) {
      return reply.status(503).send({ error: 'The jukebox is not taking requests right now.' });
    }

    if (!ctx.spotifyAuth.isConnected()) {
      // An operator problem, not a guest one — say so without the detail.
      return reply.status(503).send({ error: 'The jukebox is not set up yet.' });
    }

    const settings = ctx.settings.all();

    try {
      const tracks = await ctx.spotify.search(
        parsed.data.q,
        settings.market,
        parsed.data.limit ?? SEARCH_LIMIT_MAX,
      );
      const filtered = applySearchFilters(tracks, {
        explicitFilter: settings.explicit_filter,
        maxDurationMs: settings.max_track_duration_ms,
      });
      return reply.send({ results: filtered.map(toDto) });
    } catch (err) {
      if (err instanceof SpotifyError) {
        log.warn('search failed', err.toLogFields());
        return reply.status(err.transient ? 503 : 502).send({ error: err.guestMessage });
      }
      log.error('search failed unexpectedly', { err });
      return reply.status(500).send({ error: 'Something went wrong. Try again in a moment.' });
    }
  });
}
