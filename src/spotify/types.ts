/**
 * Zod schemas for the slices of Spotify's responses we actually use.
 *
 * Parsed defensively and narrowly: a field Spotify adds must not break us, and
 * a field Spotify removes must fail loudly here rather than as `undefined`
 * three layers up. Optional fields are optional because the API genuinely
 * omits them, not as a shortcut.
 */
import { z } from 'zod';

export const TrackSchema = z.object({
  id: z.string(),
  uri: z.string(),
  name: z.string(),
  duration_ms: z.number(),
  explicit: z.boolean(),
  // Absent for local files and some regional edge cases.
  is_playable: z.boolean().optional(),
  artists: z.array(z.object({ id: z.string().nullable(), name: z.string() })),
  album: z.object({
    id: z.string().nullable(),
    name: z.string(),
    images: z.array(z.object({ url: z.string(), width: z.number().nullable(), height: z.number().nullable() })),
  }),
});
export type SpotifyTrack = z.infer<typeof TrackSchema>;

export const SearchResponseSchema = z.object({
  tracks: z.object({
    // Spotify returns nulls in this array for unavailable items.
    items: z.array(TrackSchema.nullable()),
    total: z.number(),
  }),
});

export const DeviceSchema = z.object({
  id: z.string().nullable(),
  is_active: z.boolean(),
  is_restricted: z.boolean(),
  name: z.string(),
  type: z.string(),
  volume_percent: z.number().nullable(),
});
export type SpotifyDevice = z.infer<typeof DeviceSchema>;

export const DevicesResponseSchema = z.object({ devices: z.array(DeviceSchema) });

export const PlaybackStateSchema = z.object({
  device: DeviceSchema.nullable(),
  repeat_state: z.enum(['off', 'track', 'context']),
  shuffle_state: z.boolean(),
  context: z.object({ uri: z.string(), type: z.string() }).nullable(),
  progress_ms: z.number().nullable(),
  is_playing: z.boolean(),
  // Null when the current item is a podcast episode, which we ignore.
  item: TrackSchema.nullable(),
  currently_playing_type: z.string().optional(),
});
export type PlaybackState = z.infer<typeof PlaybackStateSchema>;

export const QueueResponseSchema = z.object({
  currently_playing: TrackSchema.nullable(),
  queue: z.array(TrackSchema.nullable()),
});

export const PlaylistSchema = z.object({
  id: z.string(),
  uri: z.string(),
  name: z.string(),
  tracks: z.object({ total: z.number() }),
  owner: z.object({ display_name: z.string().nullable() }).optional(),
});

export const UserProfileSchema = z.object({
  id: z.string(),
  display_name: z.string().nullable(),
  product: z.string().optional(), // 'premium' | 'free' | ...
  country: z.string().optional(),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

/**
 * Our own flattened track shape. Everything above this line is Spotify's
 * vocabulary; everything below is ours, and it is what gets stored and rendered.
 */
export interface Track {
  id: string;
  uri: string;
  name: string;
  artist: string;
  album: string;
  albumArtUrl: string | null;
  durationMs: number;
  explicit: boolean;
  /** Artist ids, for the blocklist check. Nulls (local files) are dropped. */
  artistIds: string[];
}

export function toTrack(raw: SpotifyTrack): Track {
  return {
    id: raw.id,
    uri: raw.uri,
    name: raw.name,
    artist: raw.artists.map((a) => a.name).join(', ') || 'Unknown artist',
    album: raw.album.name,
    albumArtUrl: pickImage(raw.album.images),
    durationMs: raw.duration_ms,
    explicit: raw.explicit,
    artistIds: raw.artists.map((a) => a.id).filter((id): id is string => id !== null),
  };
}

/** Smallest image at least 160px wide — album art on a phone is thumbnail-sized,
 *  and pulling the 640px original for a list of 20 is wasteful on venue Wi-Fi. */
function pickImage(images: SpotifyTrack['album']['images']): string | null {
  if (images.length === 0) return null;
  const sorted = [...images].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const chosen = sorted.find((img) => (img.width ?? 0) >= 160) ?? sorted[sorted.length - 1];
  return chosen?.url ?? null;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
