/**
 * The reconciler: a pure function from "what we observe" to "what should
 * happen next". No I/O, no clock, no randomness — everything it needs is an
 * argument, which is what makes the engine's behaviour testable without
 * touching Spotify.
 *
 * The executor in `loop.ts` performs the actions it returns. Keeping the two
 * apart means a misjudged decision shows up as a wrong action in a test,
 * rather than as a mystery in a venue at 1am.
 */
import type { RequestRow } from '../queue/repository.js';
import type { PlayerSnapshot } from '../spotify/client.js';
import type { SpotifyDevice } from '../spotify/types.js';

export type Action =
  /** librespot reappeared under a new id; point playback back at it. */
  | { type: 'retarget_device'; deviceId: string; reason: string }
  /** Start the fallback playlist as the playback context, shuffled. */
  | { type: 'start_fallback'; deviceId: string; contextUri: string; reason: string }
  /** Resume a paused player without reloading anything. */
  | { type: 'resume'; deviceId: string; reason: string }
  /** The fallback must repeat, or the night ends when the playlist does. */
  | { type: 'ensure_repeat'; deviceId: string }
  /** Hand exactly one request to Spotify's queue. */
  | { type: 'push_request'; requestId: number; trackUri: string; deviceId: string; reason: string }
  /** Skip what is playing so a request starts now. */
  | { type: 'skip_now'; deviceId: string; reason: string }
  | { type: 'mark_playing'; requestId: number }
  | { type: 'mark_played'; requestId: number }
  | { type: 'mark_failed'; requestId: number; reason: string }
  /** Nothing to do, or nothing we *can* do. The reason is logged, not acted on. */
  | { type: 'wait'; reason: string };

export interface ReconcileInput {
  /** Milliseconds since the epoch. Passed in so tests control time. */
  now: number;
  /** Null when Spotify reports nothing playing at all (a 204). */
  playback: PlayerSnapshot | null;
  devices: SpotifyDevice[];
  /** State 'queued', in play order. */
  queue: RequestRow[];
  /** State 'playing', if any. */
  playing: RequestRow | null;
  settings: {
    deviceName: string;
    fallbackPlaylistUri: string;
    pushLeadMs: number;
    interruptCurrent: boolean;
  };
}

/**
 * A request handed to Spotify that never started within this window is
 * presumed lost — librespot restarted, or the track was pulled. We give up
 * and let the queue move on rather than blocking it forever.
 */
export const PUSH_TIMEOUT_MS = 10 * 60 * 1000;

/** Case-insensitive match on the librespot `--name`. The device *id* changes
 *  every time librespot restarts, so the name is the only stable handle. */
export function findDeviceByName(devices: SpotifyDevice[], name: string): SpotifyDevice | null {
  const wanted = name.trim().toLowerCase();
  return devices.find((d) => d.name.trim().toLowerCase() === wanted) ?? null;
}

export function reconcile(input: ReconcileInput): Action[] {
  const { now, playback, devices, queue, playing, settings } = input;
  const actions: Action[] = [];

  // --- 1. Is our speaker even there? ---------------------------------------

  if (settings.fallbackPlaylistUri === '') {
    return [{ type: 'wait', reason: 'no fallback playlist set — choose one in the admin panel' }];
  }

  const device = findDeviceByName(devices, settings.deviceName);
  if (!device || device.id === null) {
    return [
      {
        type: 'wait',
        reason: `no Connect device named "${settings.deviceName}" — is librespot running?`,
      },
    ];
  }
  const deviceId = device.id;

  // --- 2. Did the request that was playing finish? -------------------------

  const currentUri = playback?.track?.uri ?? null;

  if (playing && currentUri !== playing.track_uri) {
    // Something else is playing now, so ours is over — whether it finished,
    // was skipped, or the device changed underneath us.
    actions.push({ type: 'mark_played', requestId: playing.id });
  }

  // --- 3. Did a request we handed over start playing? ----------------------

  const pushed = queue.filter((r) => r.pushed_at !== null);
  const startedNow = pushed.find((r) => r.track_uri === currentUri);

  if (startedNow && (!playing || playing.id !== startedNow.id)) {
    actions.push({ type: 'mark_playing', requestId: startedNow.id });
  }

  // Give up on a hand-off that never became audible.
  for (const request of pushed) {
    if (request.id === startedNow?.id) continue;
    const pushedAt = Date.parse(request.pushed_at as string);
    if (Number.isFinite(pushedAt) && now - pushedAt > PUSH_TIMEOUT_MS) {
      actions.push({
        type: 'mark_failed',
        requestId: request.id,
        reason: 'handed to Spotify but never started playing',
      });
    }
  }

  // --- 4. Is anything playing at all? --------------------------------------

  const stillPending = queue.filter(
    (r) =>
      r.id !== startedNow?.id &&
      !actions.some((a) => a.type === 'mark_failed' && a.requestId === r.id),
  );

  if (playback === null || playback.track === null) {
    // Dead air. Start the fallback; a pending request will be inserted on the
    // next pass, once there is something to insert it ahead of.
    actions.push({
      type: 'start_fallback',
      deviceId,
      contextUri: settings.fallbackPlaylistUri,
      reason: playback === null ? 'nothing playing' : 'player has no current track',
    });
    return actions;
  }

  if (!device.is_active) {
    // Spotify knows the device but is pointed somewhere else — typically a
    // librespot restart, or someone grabbed playback from their phone.
    actions.push({ type: 'retarget_device', deviceId, reason: 'our device is not the active one' });
    return actions;
  }

  if (!playback.isPlaying) {
    if (stillPending.length > 0 || playback.track !== null) {
      actions.push({ type: 'resume', deviceId, reason: 'player is paused' });
    } else {
      actions.push({
        type: 'start_fallback',
        deviceId,
        contextUri: settings.fallbackPlaylistUri,
        reason: 'player stopped with an empty queue',
      });
    }
    return actions;
  }

  // --- 5. Keep the fallback looping ----------------------------------------

  const onFallback = playback.contextUri === settings.fallbackPlaylistUri;
  if (onFallback && playback.repeatState !== 'context') {
    // Without this the playlist plays through once and the room goes quiet.
    actions.push({ type: 'ensure_repeat', deviceId });
  }

  if (!onFallback && stillPending.length === 0 && !startedNow && !playing) {
    // We drifted off the fallback context — someone played an album from
    // their phone, say — and there is nothing of ours pending. Take it back.
    actions.push({
      type: 'start_fallback',
      deviceId,
      contextUri: settings.fallbackPlaylistUri,
      reason: 'playback drifted off the fallback playlist',
    });
    return actions;
  }

  // --- 6. Hand over the next request, at the last responsible moment -------

  // Exactly one at a time: anything already pushed is out of our hands, and
  // pushing a second would make the first unreorderable too.
  const alreadyHandedOver = pushed.some(
    (r) => !actions.some((a) => a.type === 'mark_failed' && a.requestId === r.id),
  );

  const next = stillPending.find((r) => r.pushed_at === null);

  if (next && !alreadyHandedOver) {
    const remainingMs = remainingTrackMs(playback);
    const currentIsPaidRequest = playing !== null && playing.amount_cents > 0;

    if (settings.interruptCurrent && !currentIsPaidRequest) {
      // Skip straight to it. Queue first, then skip — the other order plays
      // whatever the context had next, which is not what anyone asked for.
      actions.push({
        type: 'push_request',
        requestId: next.id,
        trackUri: next.track_uri,
        deviceId,
        reason: 'interrupt mode',
      });
      actions.push({ type: 'skip_now', deviceId, reason: 'interrupt mode' });
    } else if (remainingMs !== null && remainingMs <= settings.pushLeadMs) {
      actions.push({
        type: 'push_request',
        requestId: next.id,
        trackUri: next.track_uri,
        deviceId,
        reason: `current track ends in ${Math.round(remainingMs / 1000)}s`,
      });
    } else if (remainingMs === null) {
      // No progress information — better to hand it over than to stall.
      actions.push({
        type: 'push_request',
        requestId: next.id,
        trackUri: next.track_uri,
        deviceId,
        reason: 'no progress information from Spotify',
      });
    }
  }

  if (actions.length === 0) {
    actions.push({
      type: 'wait',
      reason: stillPending.length > 0 ? 'waiting for the current track to end' : 'fallback playing',
    });
  }

  return actions;
}

/** Milliseconds left on the current track, or null when Spotify is not telling. */
export function remainingTrackMs(playback: PlayerSnapshot): number | null {
  if (playback.progressMs === null || playback.track === null) return null;
  return Math.max(0, playback.track.durationMs - playback.progressMs);
}
