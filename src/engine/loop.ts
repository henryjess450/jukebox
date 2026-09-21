/**
 * The playback engine: poll Spotify, reconcile, act, repeat.
 *
 * Built to survive weeks unattended. Every tick is wrapped so a failure logs
 * and the next tick still runs; nothing in here may throw into the timer.
 * Ticks never overlap — a slow Spotify cannot stack up work.
 */
import { EventLog } from '../db/events.js';
import type { SettingsStore } from '../config/settings.js';
import { QueueRepository } from '../queue/repository.js';
import { SpotifyClient } from '../spotify/client.js';
import type { SpotifyDevice } from '../spotify/types.js';
import { formatDuration } from '../spotify/types.js';
import { SpotifyError } from '../spotify/errors.js';
import type { SpotifyAuth } from '../spotify/auth.js';
import { log } from '../log.js';
import {
  nextPollDelayMs,
  reconcile,
  type Action,
  type ReconcileInput,
} from './reconciler.js';

/** Only a starting point; the interval adapts — see `nextPollDelayMs`. */
const TICK_MS = 3_000;
/**
 * The device list barely changes, but fetching it every tick doubled the
 * engine's call rate and helped push the account into Spotify's rate limit.
 * It is re-read on this interval, or immediately whenever the device we want
 * is not in the cached copy.
 */
const DEVICE_CACHE_MS = 30_000;

/** After this many consecutive failures, slow down rather than hammering. */
const BACKOFF_AFTER_FAILURES = 3;
const BACKOFF_TICK_MS = 15_000;
export interface EngineDeps {
  spotify: SpotifyClient;
  auth: SpotifyAuth;
  queue: QueueRepository;
  settings: SettingsStore;
  events: EventLog;
  /** Injected for tests. */
  now?: () => number;
  random?: () => number;
}

export class PlaybackEngine {
  readonly #deps: EngineDeps;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #ticking = false;
  #consecutiveFailures = 0;
  /** Consecutive polls reporting dead air; see IDLE_TICKS_BEFORE_ACTING. */
  #idleTicks = 0;
  /** What the last pass decided the next interval should be. */
  #nextDelayMs = TICK_MS;
  /** Set while an operator has deliberately paused playback. */
  #adminPaused = false;

  #deviceCache: { devices: SpotifyDevice[]; at: number } | null = null;

  /**
   * When Spotify says it is rate limiting us, it also says for how long. Until
   * then the engine makes no calls at all: continuing to knock is what turns a
   * short penalty into a long one.
   */
  #rateLimitedUntilMs = 0;

  /** Remembers the last device id we saw, so a change is worth logging once. */
  #lastDeviceId: string | null = null;

  /**
   * The most recent track Spotify reported. The guest page shows this when
   * nothing in our queue is playing — otherwise "Playing now" would be blank
   * for the whole time the fallback playlist is running.
   */
  #lastTrack: {
    name: string;
    artist: string;
    albumArtUrl: string | null;
    duration: string;
    requested: boolean;
  } | null = null;

  constructor(deps: EngineDeps) {
    this.#deps = deps;
  }

  /**
   * Engine health, for the status page and for tests. `consecutiveFailures`
   * above zero means Spotify is not answering; the tick interval widens once
   * it reaches the backoff threshold.
   */
  /** What the player last reported, for the guest page. Null before the first
   *  successful poll. */
  lastKnownTrack(): {
    name: string;
    artist: string;
    albumArtUrl: string | null;
    duration: string;
    requested: boolean;
  } | null {
    return this.#lastTrack;
  }

  stats(): {
    running: boolean;
    consecutiveFailures: number;
    backingOff: boolean;
    tickMs: number;
    rateLimitedForMs: number;
  } {
    const backingOff = this.#consecutiveFailures >= BACKOFF_AFTER_FAILURES;
    return {
      running: this.#running,
      consecutiveFailures: this.#consecutiveFailures,
      backingOff,
      tickMs: backingOff ? BACKOFF_TICK_MS : this.#nextDelayMs,
      rateLimitedForMs: Math.max(0, this.#rateLimitedUntilMs - this.#now()),
    };
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /**
   * Suspend or resume the engine's own intervention, for the admin pause
   * button. While held, the reconciler is told to do nothing at all rather
   * than resuming the player under the operator's feet.
   */
  holdPaused(paused: boolean): void {
    this.#adminPaused = paused;
    // Otherwise the ticks counted while paused would trigger an immediate
    // takeover the moment the hold is released.
    this.#idleTicks = 0;
    log.info(paused ? 'engine held paused by admin' : 'engine released from admin pause');
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule(TICK_MS);
    log.info('playback engine started', { tick_ms: TICK_MS });
  }

  stop(): void {
    this.#running = false;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    log.info('playback engine stopped');
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => {
        const rateLimitWait = this.#rateLimitedUntilMs - this.#now();
        if (rateLimitWait > 0) {
          // Wake once when the penalty expires rather than ticking through it.
          this.#schedule(rateLimitWait + 1_000);
          return;
        }
        this.#schedule(
          this.#consecutiveFailures >= BACKOFF_AFTER_FAILURES ? BACKOFF_TICK_MS : this.#nextDelayMs,
        );
      });
    }, delayMs);
    // Never hold the process open for a timer.
    this.#timer.unref?.();
  }

  /**
   * One pass. Public so a test — or an admin action wanting an immediate
   * reaction — can drive it directly instead of waiting for the timer.
   */
  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;

    try {
      const waitMs = this.#rateLimitedUntilMs - this.#now();
      if (waitMs > 0) {
        // Making the call anyway would earn another 429 and, on Spotify, a
        // longer penalty. Sit it out in silence.
        log.debug('rate limited; skipping tick', { wait_s: Math.ceil(waitMs / 1000) });
        return;
      }

      if (!this.#deps.auth.isConnected()) {
        // Not an error: the box may simply not be set up yet.
        this.#consecutiveFailures = 0;
        return;
      }

      const input = await this.#observe();
      const actions = reconcile(input);
      this.#nextDelayMs = nextPollDelayMs(input);
      await this.#execute(actions);
      this.#consecutiveFailures = 0;
    } catch (err) {
      this.#consecutiveFailures++;

      if (err instanceof SpotifyError && err.code === 'rate_limited') {
        // Spotify's Retry-After is authoritative; a minute is a floor for the
        // case where it did not say.
        const waitMs = Math.max(err.retryAfterMs ?? 60_000, 60_000);
        this.#rateLimitedUntilMs = this.#now() + waitMs;
        log.warn('rate limited by Spotify; pausing all calls', {
          wait_s: Math.ceil(waitMs / 1000),
          resumes_at: new Date(this.#rateLimitedUntilMs).toISOString(),
        });
        return;
      }

      const fields =
        err instanceof SpotifyError
          ? err.toLogFields()
          : { message: err instanceof Error ? err.message : String(err) };
      log.error('engine tick failed', { ...fields, consecutive_failures: this.#consecutiveFailures });

      if (this.#consecutiveFailures === BACKOFF_AFTER_FAILURES) {
        log.warn('engine backing off', { tick_ms: BACKOFF_TICK_MS });
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Gather everything the reconciler needs, in as few calls as possible. */
  async #observe(): Promise<ReconcileInput> {
    const settings = this.#deps.settings.all();
    const now = this.#deps.now?.() ?? Date.now();

    const [playback, devices] = await Promise.all([
      this.#deps.spotify.getPlaybackState(),
      this.#devices(settings.device_name, now),
    ]);

    // Dead air is nothing playing, or playing nothing identifiable, or paused.
    const idle = playback === null || playback.track === null || !playback.isPlaying;
    this.#idleTicks = idle ? this.#idleTicks + 1 : 0;

    this.#lastTrack = playback?.track
      ? {
          name: playback.track.name,
          artist: playback.track.artist,
          albumArtUrl: playback.track.albumArtUrl,
          duration: formatDuration(playback.track.durationMs),
          requested: false,
        }
      : null;

    return {
      now,
      idleTicks: this.#idleTicks,
      adminPaused: this.#adminPaused,
      playback,
      devices,
      queue: this.#deps.queue.listQueued(),
      playing: this.#deps.queue.nowPlaying(),
      settings: {
        deviceName: settings.device_name,
        fallbackPlaylistUri: settings.fallback_playlist_uri,
        pushLeadMs: settings.push_lead_ms,
        interruptCurrent: settings.interrupt_current,
      },
    };
  }

  /**
   * The device list, cached. Re-read when it is stale, or when the device we
   * are looking for is not in the copy we have — a librespot restart changes
   * the id, and waiting 30s to notice would be 30s of silence.
   */
  async #devices(wantedName: string, now: number): Promise<SpotifyDevice[]> {
    const cached = this.#deviceCache;
    if (cached) {
      const fresh = now - cached.at < DEVICE_CACHE_MS;
      const wanted = wantedName.trim().toLowerCase();
      const present = cached.devices.some((d) => d.name.trim().toLowerCase() === wanted);
      if (fresh && present) return cached.devices;
    }

    const devices = await this.#deps.spotify.getDevices();
    this.#deviceCache = { devices, at: now };
    return devices;
  }

  /**
   * Carry out the reconciler's decisions in order.
   *
   * Database updates are applied even when the matching Spotify call fails —
   * `mark_played` reflects something that already happened, and refusing to
   * record it would wedge the queue.
   */
  async #execute(actions: Action[]): Promise<void> {
    const { spotify, queue, events } = this.#deps;

    for (const action of actions) {
      switch (action.type) {
        case 'wait':
          log.debug('engine idle', { reason: action.reason });
          break;

        case 'mark_playing': {
          queue.markPlaying(action.requestId);
          events.record('request_started', { requestId: action.requestId });
          log.info('request started playing', { request_id: action.requestId });
          break;
        }

        case 'mark_played': {
          queue.markPlayed(action.requestId);
          events.record('request_played', { requestId: action.requestId });
          log.info('request finished', { request_id: action.requestId });
          break;
        }

        case 'mark_failed': {
          queue.markFailed(action.requestId, action.reason);
          events.record('request_failed', {
            requestId: action.requestId,
            detail: { reason: action.reason },
          });
          log.warn('request failed', { request_id: action.requestId, reason: action.reason });
          break;
        }

        case 'push_request': {
          try {
            await spotify.addToQueue(action.trackUri, action.deviceId);
            queue.markPushed(action.requestId);
            events.record('request_pushed', {
              requestId: action.requestId,
              detail: { reason: action.reason },
            });
            log.info('request handed to Spotify', {
              request_id: action.requestId,
              reason: action.reason,
            });
          } catch (err) {
            // Leave pushed_at null so the next tick tries again — unless the
            // track itself is the problem, in which case retrying is pointless.
            if (err instanceof SpotifyError && !err.transient && err.code !== 'no_active_device') {
              queue.markFailed(action.requestId, err.message);
              events.record('request_failed', {
                requestId: action.requestId,
                detail: { reason: err.message, code: err.code },
              });
              log.error('request rejected by Spotify', {
                request_id: action.requestId,
                ...err.toLogFields(),
              });
            } else {
              log.warn('could not hand request to Spotify; will retry', {
                request_id: action.requestId,
                ...(err instanceof SpotifyError ? err.toLogFields() : { err }),
              });
            }
          }
          break;
        }

        case 'skip_now': {
          await spotify.skipToNext(action.deviceId);
          events.record('playback_skipped', { detail: { reason: action.reason } });
          log.info('skipped current track', { reason: action.reason });
          break;
        }

        case 'start_fallback': {
          await spotify.playContext(action.contextUri, action.deviceId);

          // Both must follow playback: Spotify ignores them on a device that
          // is not yet playing anything. Neither is worth failing the tick
          // over — the music is already on, which is the important part.
          //
          // Shuffle is what stops the same song opening every evening. The
          // API gives us no way to learn a playlist's length, so a random
          // start offset is not available to us.
          await spotify.setShuffle(true, action.deviceId).catch((err: unknown) => {
            log.warn('could not enable shuffle', {
              err: err instanceof SpotifyError ? err.toLogFields() : err,
            });
          });
          await spotify.setRepeat('context', action.deviceId).catch((err: unknown) => {
            log.warn('could not set repeat', {
              err: err instanceof SpotifyError ? err.toLogFields() : err,
            });
          });

          events.record('fallback_restarted', { detail: { reason: action.reason } });
          log.info('fallback playlist started', { reason: action.reason });
          break;
        }

        case 'resume': {
          await spotify.resume(action.deviceId);
          events.record('playback_resumed', { detail: { reason: action.reason } });
          log.info('resumed playback', { reason: action.reason });
          break;
        }

        case 'ensure_repeat': {
          await spotify.setRepeat('context', action.deviceId);
          log.info('repeat re-enabled on the fallback context');
          break;
        }

        case 'retarget_device': {
          await spotify.transferPlayback(action.deviceId, true);
          if (this.#lastDeviceId !== action.deviceId) {
            events.record('device_retargeted', {
              detail: { device_id: action.deviceId, reason: action.reason },
            });
            this.#lastDeviceId = action.deviceId;
          }
          log.info('playback retargeted to our device', { reason: action.reason });
          break;
        }
      }
    }
  }
}
