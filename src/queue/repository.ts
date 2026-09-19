/**
 * The request queue. This table — not Spotify's queue — is the source of truth.
 *
 * Spotify's own queue can be appended to but never read back reliably,
 * reordered, or emptied. So we hold the line here and hand Spotify exactly one
 * track at a time, just before it is needed. Everything an operator can do to
 * the queue (reorder, remove) works on rows that have not been handed over yet.
 */
import type { Db } from '../db/index.js';
import { now } from '../db/index.js';
import type { Track } from '../spotify/types.js';

/**
 * pending_payment → queued → playing → played
 *                 ↘ failed / refunded / cancelled
 */
export type RequestState =
  | 'pending_payment'
  | 'queued'
  | 'playing'
  | 'played'
  | 'failed'
  | 'refunded'
  | 'cancelled';

export interface RequestRow {
  id: number;
  track_uri: string;
  track_id: string;
  track_name: string;
  artist_name: string;
  album_name: string;
  album_art_url: string | null;
  duration_ms: number;
  explicit: number;
  session_id: string;
  ip_hash: string;
  state: RequestState;
  position: number | null;
  amount_cents: number;
  currency: string;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  refund_id: string | null;
  failure_reason: string | null;
  created_at: string;
  paid_at: string | null;
  queued_at: string | null;
  pushed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

/** Gap between adjacent positions, so a reorder is one UPDATE rather than a
 *  rewrite of every row after it. */
const POSITION_GAP = 1000;

export interface EnqueueInput {
  track: Track;
  sessionId: string;
  ipHash: string;
  state: Extract<RequestState, 'queued' | 'pending_payment'>;
  amountCents: number;
  currency: string;
  stripeSessionId?: string;
}

export class QueueRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Append to the end of the queue. Returns the new row's id. */
  enqueue(input: EnqueueInput): number {
    const timestamp = now();
    const position = this.#nextPosition();

    const result = this.#db
      .prepare(
        `INSERT INTO requests (
           track_uri, track_id, track_name, artist_name, album_name, album_art_url,
           duration_ms, explicit, session_id, ip_hash, state, position,
           amount_cents, currency, stripe_session_id, created_at, queued_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.track.uri,
        input.track.id,
        input.track.name,
        input.track.artist,
        input.track.album,
        input.track.albumArtUrl,
        input.track.durationMs,
        input.track.explicit ? 1 : 0,
        input.sessionId,
        input.ipHash,
        input.state,
        position,
        input.amountCents,
        input.currency,
        input.stripeSessionId ?? null,
        timestamp,
        input.state === 'queued' ? timestamp : null,
      );

    return Number(result.lastInsertRowid);
  }

  #nextPosition(): number {
    const row = this.#db
      .prepare(`SELECT MAX(position) AS max_position FROM requests WHERE state IN ('queued', 'playing')`)
      .get() as { max_position: number | null };
    return (row.max_position ?? 0) + POSITION_GAP;
  }

  /** Everything waiting to play, in play order. */
  listQueued(): RequestRow[] {
    return this.#db
      .prepare(`SELECT * FROM requests WHERE state = 'queued' ORDER BY position ASC, id ASC`)
      .all() as RequestRow[];
  }

  /** The request Spotify is playing right now, if it is one of ours. */
  nowPlaying(): RequestRow | null {
    return (
      (this.#db
        .prepare(`SELECT * FROM requests WHERE state = 'playing' ORDER BY started_at DESC LIMIT 1`)
        .get() as RequestRow | undefined) ?? null
    );
  }

  byId(id: number): RequestRow | null {
    return (this.#db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined) ?? null;
  }

  byStripeSession(sessionId: string): RequestRow | null {
    return (
      (this.#db.prepare('SELECT * FROM requests WHERE stripe_session_id = ?').get(sessionId) as
        | RequestRow
        | undefined) ?? null
    );
  }

  countQueued(): number {
    const row = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM requests WHERE state IN ('queued', 'playing')`)
      .get() as { n: number };
    return row.n;
  }

  /** How many requests a guest has in flight — includes unpaid ones, so an
   *  abandoned checkout still counts against them until it expires. */
  countPendingForSession(sessionId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM requests
         WHERE session_id = ? AND state IN ('pending_payment', 'queued', 'playing')`,
      )
      .get(sessionId) as { n: number };
    return row.n;
  }

  /** True when this exact track is already waiting or playing. */
  isActive(trackUri: string): boolean {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM requests
         WHERE track_uri = ? AND state IN ('pending_payment', 'queued', 'playing')`,
      )
      .get(trackUri) as { n: number };
    return row.n > 0;
  }

  /** When this guest last submitted anything, for the cooldown check. */
  lastRequestAt(sessionId: string): string | null {
    const row = this.#db
      .prepare(`SELECT created_at FROM requests WHERE session_id = ? ORDER BY id DESC LIMIT 1`)
      .get(sessionId) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  /** Position in the queue as a guest would count it, 1-based. */
  queuePosition(id: number): number | null {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) + 1 AS pos FROM requests
         WHERE state = 'queued'
           AND (position, id) < (SELECT position, id FROM requests WHERE id = ?)`,
      )
      .get(id) as { pos: number } | undefined;
    return row?.pos ?? null;
  }

  // --- state transitions ----------------------------------------------------

  /** Payment cleared: an unpaid request joins the queue. */
  markQueued(id: number, stripePaymentIntent?: string): void {
    const timestamp = now();
    this.#db
      .prepare(
        `UPDATE requests
         SET state = 'queued', queued_at = ?, paid_at = COALESCE(paid_at, ?), position = ?,
             stripe_payment_intent = COALESCE(?, stripe_payment_intent)
         WHERE id = ? AND state = 'pending_payment'`,
      )
      .run(timestamp, timestamp, this.#nextPosition(), stripePaymentIntent ?? null, id);
  }

  /**
   * Record the Checkout session that will pay for this request.
   *
   * The column is UNIQUE, so one session can only ever be attached to one
   * request — the database, not application code, is what makes a replayed
   * payment unable to buy a second play.
   */
  attachStripeSession(id: number, sessionId: string): void {
    this.#db
      .prepare(`UPDATE requests SET stripe_session_id = ? WHERE id = ? AND state = 'pending_payment'`)
      .run(sessionId, id);
  }

  /** Handed to Spotify's queue. Still `queued` — it has not started yet, and
   *  until it does we may still need to give up on it. */
  markPushed(id: number): void {
    this.#db.prepare(`UPDATE requests SET pushed_at = ? WHERE id = ?`).run(now(), id);
  }

  /** Undo a hand-off we never confirmed, so the reconciler can try again. */
  clearPushed(id: number): void {
    this.#db.prepare(`UPDATE requests SET pushed_at = NULL WHERE id = ?`).run(id);
  }

  markPlaying(id: number): void {
    this.#db
      .prepare(`UPDATE requests SET state = 'playing', started_at = ? WHERE id = ? AND state = 'queued'`)
      .run(now(), id);
  }

  markPlayed(id: number): void {
    this.#db
      .prepare(`UPDATE requests SET state = 'played', finished_at = ? WHERE id = ? AND state = 'playing'`)
      .run(now(), id);
  }

  markFailed(id: number, reason: string): void {
    this.#db
      .prepare(
        `UPDATE requests SET state = 'failed', failure_reason = ?, finished_at = ?
         WHERE id = ? AND state IN ('queued', 'playing', 'pending_payment')`,
      )
      .run(reason, now(), id);
  }

  markRefunded(id: number, refundId: string): void {
    this.#db
      .prepare(`UPDATE requests SET state = 'refunded', refund_id = ? WHERE id = ?`)
      .run(refundId, id);
  }

  /** Admin removal. Distinct from `failed` so the log tells you a human did it. */
  cancel(id: number, reason: string): void {
    this.#db
      .prepare(
        `UPDATE requests SET state = 'cancelled', failure_reason = ?, finished_at = ?
         WHERE id = ? AND state IN ('queued', 'pending_payment')`,
      )
      .run(reason, now(), id);
  }

  /**
   * Move a request between two others. Positions are sparse, so this is one
   * UPDATE; when a gap closes to nothing, `#renumber` spreads them out again.
   */
  moveTo(id: number, beforeId: number | null): boolean {
    const queued = this.listQueued();
    const moving = queued.find((r) => r.id === id);
    if (!moving) return false;

    const others = queued.filter((r) => r.id !== id);
    const targetIndex = beforeId === null ? others.length : others.findIndex((r) => r.id === beforeId);
    if (beforeId !== null && targetIndex === -1) return false;

    const previous = targetIndex > 0 ? others[targetIndex - 1] : undefined;
    const next = targetIndex < others.length ? others[targetIndex] : undefined;

    const low = previous?.position ?? 0;
    const high = next?.position ?? low + POSITION_GAP * 2;
    const midpoint = (low + high) / 2;

    // Floating-point positions eventually run out of room between neighbours.
    if (!Number.isFinite(midpoint) || midpoint <= low || midpoint >= high) {
      this.#renumber();
      return this.moveTo(id, beforeId);
    }

    this.#db.prepare('UPDATE requests SET position = ? WHERE id = ?').run(midpoint, id);
    return true;
  }

  #renumber(): void {
    const queued = this.listQueued();
    const update = this.#db.prepare('UPDATE requests SET position = ? WHERE id = ?');
    this.#db.transaction(() => {
      queued.forEach((row, index) => update.run((index + 1) * POSITION_GAP, row.id));
    })();
  }

  /** Paid requests that never played and are owed a refund. */
  listRefundable(): RequestRow[] {
    return this.#db
      .prepare(
        `SELECT * FROM requests
         WHERE state IN ('failed', 'cancelled')
           AND amount_cents > 0
           AND stripe_payment_intent IS NOT NULL
           AND refund_id IS NULL`,
      )
      .all() as RequestRow[];
  }

  /** Unpaid rows left behind by abandoned checkouts. Cleared so they stop
   *  counting against the guest's pending limit. */
  expireAbandonedPayments(olderThanMs: number): number {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const result = this.#db
      .prepare(
        `UPDATE requests SET state = 'cancelled', failure_reason = 'payment not completed', finished_at = ?
         WHERE state = 'pending_payment' AND created_at < ?`,
      )
      .run(now(), cutoff);
    return result.changes;
  }

  recent(limit = 100): RequestRow[] {
    return this.#db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT ?').all(limit) as RequestRow[];
  }
}
