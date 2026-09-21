/**
 * Payment flow, independent of HTTP and of Stripe's SDK.
 *
 * Two confirmation paths reach the same function:
 *
 *   1. The browser comes back from Checkout with a session id, and we ask
 *      Stripe — server-side — whether it was actually paid. This is the
 *      primary path, because the box sits behind NAT and a webhook may never
 *      arrive.
 *   2. The `checkout.session.completed` webhook, when a tunnel exposes it.
 *
 * Both are idempotent, and the guard is in the database rather than in this
 * code: `markQueued` only transitions a row out of `pending_payment`, so the
 * second confirmation of the same session changes nothing. One payment can
 * never buy two plays.
 */
import type { EventLog } from '../db/events.js';
import type { QueueRepository, RequestRow } from '../queue/repository.js';
import { log } from '../log.js';
import {
  describeStripeError,
  stripeErrorIsTransient,
  type PaymentGateway,
} from './gateway.js';

/** How long a guest has to finish paying before the session lapses. */
export const CHECKOUT_TTL_MS = 30 * 60 * 1000;

export type ConfirmOutcome =
  | { status: 'queued'; request: RequestRow; position: number | null }
  | { status: 'already_queued'; request: RequestRow; position: number | null }
  | { status: 'unpaid'; request: RequestRow | null }
  | { status: 'unknown_session' }
  | { status: 'error'; message: string };

export class PaymentService {
  readonly #gateway: PaymentGateway;
  readonly #queue: QueueRepository;
  readonly #events: EventLog;
  readonly #publicUrl: string;
  readonly #onQueued: (() => void) | undefined;

  constructor(opts: {
    gateway: PaymentGateway;
    queue: QueueRepository;
    events: EventLog;
    publicUrl: string;
    /** Called after a request joins the queue, so live views update at once. */
    onQueued?: () => void;
  }) {
    this.#gateway = opts.gateway;
    this.#queue = opts.queue;
    this.#events = opts.events;
    this.#publicUrl = opts.publicUrl;
    this.#onQueued = opts.onQueued;
  }

  /**
   * Create the pending request and its Checkout session, together.
   *
   * The row is written first so the session's metadata can carry its id. If
   * Stripe then fails, the row is cancelled immediately rather than left to
   * occupy the guest's pending allowance.
   */
  async startCheckout(input: {
    requestId: number;
    row: RequestRow;
    /** Built by `checkoutProductName`, so fundraising wording is decided in
     *  one place rather than here. */
    productName: string;
  }): Promise<{ url: string; sessionId: string }> {
    const { row } = input;

    try {
      const session = await this.#gateway.createCheckoutSession({
        amountCents: row.amount_cents,
        currency: row.currency,
        productName: input.productName,
        trackName: row.track_name,
        artistName: row.artist_name,
        albumArtUrl: row.album_art_url,
        requestId: row.id,
        trackUri: row.track_uri,
        successUrl: `${this.#publicUrl}/return?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${this.#publicUrl}/?cancelled=1`,
        expiresAt: Math.floor((Date.now() + CHECKOUT_TTL_MS) / 1000),
      });

      this.#queue.attachStripeSession(row.id, session.id);
      this.#events.record('request_created', {
        requestId: row.id,
        actor: 'guest',
        detail: { track: row.track_name, amount_cents: row.amount_cents, checkout: session.id },
      });
      log.info('checkout session created', { request_id: row.id, amount_cents: row.amount_cents });

      return { url: session.url, sessionId: session.id };
    } catch (err) {
      this.#queue.cancel(row.id, 'could not start checkout');
      log.error('could not create checkout session', {
        request_id: row.id,
        ...describeStripeError(err),
      });
      throw err;
    }
  }

  /**
   * Ask Stripe whether a session was paid, and queue the request if so.
   *
   * Never trusts anything the browser says beyond the session id — the id
   * alone is useless without Stripe confirming payment against it.
   */
  async confirmSession(sessionId: string): Promise<ConfirmOutcome> {
    let session;
    try {
      session = await this.#gateway.retrieveSession(sessionId);
    } catch (err) {
      log.error('could not retrieve checkout session', {
        session_id: sessionId,
        ...describeStripeError(err),
      });
      return {
        status: 'error',
        message: stripeErrorIsTransient(err)
          ? 'We could not reach the payment provider. Your card was not charged twice — refresh in a moment.'
          : 'We could not confirm that payment.',
      };
    }

    const request = this.#queue.byStripeSession(sessionId);
    if (!request) {
      // A session we never issued, or a request already swept away.
      log.warn('confirmation for an unknown session', { session_id: sessionId });
      return { status: 'unknown_session' };
    }

    if (session.paymentStatus !== 'paid') {
      return { status: 'unpaid', request };
    }

    // Already handled — by the other path, or by a refresh of this one.
    if (request.state !== 'pending_payment') {
      return {
        status: 'already_queued',
        request,
        position: this.#queue.queuePosition(request.id),
      };
    }

    this.#queue.markQueued(request.id, session.paymentIntentId ?? undefined);
    const updated = this.#queue.byId(request.id) as RequestRow;

    this.#events.record('request_paid', {
      requestId: request.id,
      actor: 'guest',
      detail: {
        amount_cents: session.amountTotal ?? request.amount_cents,
        currency: session.currency ?? request.currency,
        stripe_session: sessionId,
      },
    });
    this.#events.record('request_queued', { requestId: request.id });
    log.info('payment confirmed; request queued', {
      request_id: request.id,
      session_id: sessionId,
    });

    this.#onQueued?.();

    return {
      status: 'queued',
      request: updated,
      position: this.#queue.queuePosition(request.id),
    };
  }

  /**
   * Refund a request that was paid for but will never play.
   *
   * Safe to call repeatedly: a request with a refund id already recorded is
   * left alone, so a retry after a crash cannot refund twice.
   */
  async refund(requestId: number, reason: string): Promise<{ ok: boolean; message?: string }> {
    const row = this.#queue.byId(requestId);
    if (!row) return { ok: false, message: 'Unknown request.' };
    if (row.refund_id) return { ok: true };
    if (row.amount_cents === 0) return { ok: true };
    if (!row.stripe_payment_intent) {
      return { ok: false, message: 'No payment was captured for that request.' };
    }

    try {
      const refund = await this.#gateway.refund(row.stripe_payment_intent, reason);
      this.#queue.markRefunded(requestId, refund.id);
      this.#events.record('request_refunded', {
        requestId,
        detail: { reason, refund_id: refund.id, amount_cents: row.amount_cents },
      });
      log.info('refund issued', { request_id: requestId, amount_cents: row.amount_cents, reason });
      return { ok: true };
    } catch (err) {
      log.error('refund failed', { request_id: requestId, ...describeStripeError(err) });
      return { ok: false, message: 'Stripe refused the refund. Try again from the Stripe dashboard.' };
    }
  }

  /**
   * Refund everything owed.
   *
   * Runs on a timer because a refund can fail transiently and a guest who
   * paid for a song that never played must not depend on someone noticing.
   */
  async sweepRefunds(): Promise<number> {
    const owed = this.#queue.listRefundable();
    let issued = 0;

    for (const row of owed) {
      const result = await this.refund(row.id, row.failure_reason ?? 'request did not play');
      if (result.ok) issued++;
    }

    if (issued > 0) log.info('automatic refunds issued', { count: issued });
    return issued;
  }
}
