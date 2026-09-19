/**
 * Append-only audit log. Every state change an operator might later need to
 * explain — to a guest, or to a card issuer — goes through here.
 */
import type { Db } from './index.js';
import { now } from './index.js';
import { log } from '../log.js';

export type EventKind =
  | 'admin_login'
  | 'admin_login_failed'
  | 'admin_logout'
  | 'settings_updated'
  | 'request_created'
  | 'request_paid'
  | 'request_queued'
  | 'request_pushed'
  | 'request_started'
  | 'request_played'
  | 'request_failed'
  | 'request_removed'
  | 'request_reordered'
  | 'request_refunded'
  | 'request_rejected'
  | 'playback_skipped'
  | 'playback_paused'
  | 'playback_resumed'
  | 'fallback_restarted'
  | 'device_retargeted'
  | 'spotify_connected'
  | 'spotify_disconnected';

export type Actor = 'system' | 'admin' | 'guest';

export interface EventRow {
  id: number;
  at: string;
  kind: EventKind;
  request_id: number | null;
  detail: string | null;
  actor: Actor;
}

export class EventLog {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  record(
    kind: EventKind,
    opts: { requestId?: number; detail?: Record<string, unknown>; actor?: Actor } = {},
  ): void {
    try {
      this.#db
        .prepare('INSERT INTO events (at, kind, request_id, detail, actor) VALUES (?, ?, ?, ?, ?)')
        .run(
          now(),
          kind,
          opts.requestId ?? null,
          opts.detail ? JSON.stringify(opts.detail) : null,
          opts.actor ?? 'system',
        );
    } catch (err) {
      // The audit log must never be the reason a request fails.
      log.error('failed to write audit event', { kind, err });
    }
  }

  recent(limit = 200): EventRow[] {
    return this.#db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as EventRow[];
  }
}
