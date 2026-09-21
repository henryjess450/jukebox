/**
 * The only part of this app that knows Stripe exists.
 *
 * A narrow interface rather than passing the SDK around: the payment logic
 * above it is then testable without a network, and the surface we depend on
 * stays small enough to reason about — four calls.
 *
 * No card data ever reaches this server. Checkout is hosted by Stripe; we
 * create a session, send the guest there, and later ask Stripe what happened.
 */
import Stripe from 'stripe';

export interface CheckoutSessionInput {
  /** Smallest currency unit. Already validated against the Stripe minimum. */
  amountCents: number;
  currency: string;
  /** What Stripe shows on the checkout page and the card statement. In
   *  fundraising mode this leads with the cause, not the song. */
  productName: string;
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  /** Our request id, carried through so the return and the webhook agree. */
  requestId: number;
  trackUri: string;
  successUrl: string;
  cancelUrl: string;
  /** Stripe expires the session; a guest who wanders off does not hold a slot. */
  expiresAt: number;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

export interface RetrievedSession {
  id: string;
  /** 'paid' | 'unpaid' | 'no_payment_required' */
  paymentStatus: string;
  paymentIntentId: string | null;
  amountTotal: number | null;
  currency: string | null;
  metadata: Record<string, string>;
}

export interface Refund {
  id: string;
  status: string | null;
}

export interface WebhookEvent {
  id: string;
  type: string;
  sessionId: string | null;
  paymentIntentId: string | null;
  paymentStatus: string | null;
  metadata: Record<string, string>;
}

export interface PaymentGateway {
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
  retrieveSession(sessionId: string): Promise<RetrievedSession>;
  refund(paymentIntentId: string, reason: string): Promise<Refund>;
  /** Verifies the signature and returns the event, or throws. */
  parseWebhook(rawBody: Buffer, signature: string): WebhookEvent;
}

export class StripeGateway implements PaymentGateway {
  readonly #stripe: Stripe;
  readonly #webhookSecret: string | undefined;

  constructor(secretKey: string, webhookSecret?: string, apiBase?: string) {
    // A local mock, for development only; `loadEnv` refuses to pass this
    // through in production.
    const override = apiBase ? new URL(apiBase) : null;

    this.#stripe = new Stripe(secretKey, {
      // Stripe's own retry handling, rather than a second layer of ours.
      maxNetworkRetries: 2,
      timeout: 10_000,
      appInfo: { name: 'jukebox' },
      ...(override
        ? {
            host: override.hostname,
            port: Number(override.port || (override.protocol === 'https:' ? 443 : 80)),
            protocol: override.protocol === 'https:' ? ('https' as const) : ('http' as const),
          }
        : {}),
    });
    this.#webhookSecret = webhookSecret;
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const session = await this.#stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.amountCents,
            product_data: {
              name: input.productName,
              description: `${input.trackName} — ${input.artistName}`,
              ...(input.albumArtUrl ? { images: [input.albumArtUrl] } : {}),
            },
          },
        },
      ],
      // The webhook and the return path both read these back.
      metadata: {
        request_id: String(input.requestId),
        track_uri: input.trackUri,
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: input.expiresAt,
    });

    if (!session.url) {
      throw new Error('Stripe created a session with no checkout URL');
    }
    return { id: session.id, url: session.url };
  }

  async retrieveSession(sessionId: string): Promise<RetrievedSession> {
    const session = await this.#stripe.checkout.sessions.retrieve(sessionId);
    return {
      id: session.id,
      paymentStatus: session.payment_status,
      paymentIntentId:
        typeof session.payment_intent === 'string'
          ? session.payment_intent
          : (session.payment_intent?.id ?? null),
      amountTotal: session.amount_total,
      currency: session.currency,
      metadata: (session.metadata ?? {}) as Record<string, string>,
    };
  }

  async refund(paymentIntentId: string, reason: string): Promise<Refund> {
    const refund = await this.#stripe.refunds.create({
      payment_intent: paymentIntentId,
      // Stripe's enum is narrow; the human reason goes in metadata.
      reason: 'requested_by_customer',
      metadata: { jukebox_reason: reason.slice(0, 500) },
    });
    return { id: refund.id, status: refund.status };
  }

  parseWebhook(rawBody: Buffer, signature: string): WebhookEvent {
    if (!this.#webhookSecret) {
      throw new Error('No webhook secret configured');
    }

    // Throws on a bad signature, a replayed payload, or a stale timestamp.
    const event = this.#stripe.webhooks.constructEvent(rawBody, signature, this.#webhookSecret);
    const object = event.data.object as unknown as Record<string, unknown>;

    const paymentIntent = object['payment_intent'];
    return {
      id: event.id,
      type: event.type,
      sessionId: typeof object['id'] === 'string' ? object['id'] : null,
      paymentIntentId:
        typeof paymentIntent === 'string'
          ? paymentIntent
          : ((paymentIntent as { id?: string } | undefined)?.id ?? null),
      paymentStatus: typeof object['payment_status'] === 'string' ? object['payment_status'] : null,
      metadata: (object['metadata'] ?? {}) as Record<string, string>,
    };
  }
}

/** Translate a Stripe SDK error into something loggable without card details. */
export function describeStripeError(err: unknown): Record<string, unknown> {
  if (err instanceof Stripe.errors.StripeError) {
    return { stripe_type: err.type, code: err.code, status: err.statusCode, message: err.message };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

/** True when retrying could plausibly succeed. */
export function stripeErrorIsTransient(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeError)) return false;
  return (
    err.type === 'StripeConnectionError' ||
    err.type === 'StripeAPIError' ||
    err.type === 'StripeRateLimitError' ||
    (err.statusCode !== undefined && err.statusCode >= 500)
  );
}
