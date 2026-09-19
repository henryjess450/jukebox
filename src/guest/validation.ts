/**
 * Every rule about whether a request may join the queue, in one pure function.
 *
 * Pure so the rules can be tested exhaustively, and so the guest page, the
 * payment-return path and the webhook all reach the same verdict from the same
 * code — a request that passed before payment must not be silently dropped
 * after it.
 *
 * Each rejection carries a `code` for the log and a message written for a
 * person holding a phone in a loud room.
 */
import type { Settings } from '../config/settings.js';
import { formatMoney } from '../config/settings.js';
import type { Track } from '../spotify/types.js';

export type RejectionCode =
  | 'not_accepting'
  | 'queue_full'
  | 'too_many_pending'
  | 'cooldown'
  | 'rate_limited'
  | 'duplicate'
  | 'explicit'
  | 'too_long'
  | 'blocked_track'
  | 'blocked_artist';

export interface RequestContext {
  track: Track;
  settings: Readonly<Settings>;
  /** Requests this guest already has in flight. */
  pendingForGuest: number;
  /** Everything queued or playing, from every guest. */
  queueLength: number;
  /** When this guest last submitted, epoch ms, or null if never. */
  lastRequestAtMs: number | null;
  /** True when this exact track is already queued or playing. */
  isDuplicate: boolean;
  /** True when the address has used up its burst allowance. */
  ipLimited: boolean;
  blockedTrackIds: ReadonlySet<string>;
  blockedArtistIds: ReadonlySet<string>;
  now: number;
}

export type Validation =
  | { ok: true }
  | { ok: false; code: RejectionCode; message: string; retryAfterMs?: number };

export function validateRequest(ctx: RequestContext): Validation {
  const { track, settings } = ctx;

  // The kill switch comes first: when the room is closed, nothing else matters.
  if (!settings.accepting_requests) {
    return {
      ok: false,
      code: 'not_accepting',
      message: 'The jukebox is not taking requests right now.',
    };
  }

  if (ctx.blockedTrackIds.has(track.id)) {
    return { ok: false, code: 'blocked_track', message: 'That track is not available here.' };
  }

  for (const artistId of track.artistIds) {
    if (ctx.blockedArtistIds.has(artistId)) {
      return { ok: false, code: 'blocked_artist', message: 'That artist is not available here.' };
    }
  }

  if (settings.explicit_filter && track.explicit) {
    return {
      ok: false,
      code: 'explicit',
      message: 'That version is explicit. Try the clean one.',
    };
  }

  if (track.durationMs > settings.max_track_duration_ms) {
    const limitMinutes = Math.floor(settings.max_track_duration_ms / 60_000);
    return {
      ok: false,
      code: 'too_long',
      message: `That one is over ${limitMinutes} minutes. Pick something shorter.`,
    };
  }

  if (settings.block_duplicates && ctx.isDuplicate) {
    return {
      ok: false,
      code: 'duplicate',
      message: 'That song is already coming up.',
    };
  }

  if (ctx.queueLength >= settings.max_queue_length) {
    return {
      ok: false,
      code: 'queue_full',
      message: 'The queue is full. Try again in a bit.',
    };
  }

  if (ctx.pendingForGuest >= settings.max_pending_per_guest) {
    const limit = settings.max_pending_per_guest;
    return {
      ok: false,
      code: 'too_many_pending',
      message:
        limit === 1
          ? 'You already have a song coming up. Wait for it to play.'
          : `You already have ${limit} songs coming up. Wait for one to play.`,
    };
  }

  // Cooldown is checked after the per-guest cap so the more specific message
  // wins — "you already have two coming up" is more useful than "wait 90s".
  if (settings.cooldown_seconds > 0 && ctx.lastRequestAtMs !== null) {
    const elapsedMs = ctx.now - ctx.lastRequestAtMs;
    const cooldownMs = settings.cooldown_seconds * 1000;
    if (elapsedMs < cooldownMs) {
      const waitS = Math.ceil((cooldownMs - elapsedMs) / 1000);
      return {
        ok: false,
        code: 'cooldown',
        message: `You just picked one. Try again in ${formatWait(waitS)}.`,
        retryAfterMs: cooldownMs - elapsedMs,
      };
    }
  }

  if (ctx.ipLimited) {
    return {
      ok: false,
      code: 'rate_limited',
      message: 'Lots of requests coming in right now. Try again in a moment.',
    };
  }

  return { ok: true };
}

/**
 * Seconds up to two minutes, minutes beyond that. Rounding 90 seconds up to
 * "2 minutes" is safe but makes a guest wait longer than they need to.
 */
function formatWait(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

/** What a guest is charged for this request, in the smallest currency unit. */
export function priceFor(settings: Readonly<Settings>): number {
  return settings.free_mode ? 0 : settings.price_cents;
}

/** How the price is described on the confirmation screen. */
export function priceLabel(settings: Readonly<Settings>): string {
  const cents = priceFor(settings);
  return cents === 0 ? 'Free' : formatMoney(cents, settings.currency);
}
