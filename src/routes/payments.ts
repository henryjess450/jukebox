/**
 * Payment routes.
 *
 * `/return` is the primary confirmation path: the browser comes back from
 * Checkout, and we verify server-side before anything is queued. The webhook
 * is a secondary path for boxes reachable from the internet; it is not
 * required, and the app is fully functional without it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { log } from '../log.js';
import { html } from '../http/html.js';
import { page } from '../http/layout.js';
import { formatMoney, type Currency } from '../config/settings.js';

const ReturnQuery = z.object({ session_id: z.string().min(1).max(200) });

export function registerPaymentRoutes(app: FastifyInstance, ctx: AppContext): void {
  /**
   * Stripe signs the exact bytes it sent, so this route needs the raw body.
   * Registered only for the webhook's content type on this one path.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      if (req.url.startsWith('/webhooks/stripe')) {
        // Hand the raw buffer through untouched for signature verification.
        done(null, body);
        return;
      }
      try {
        const text = (body as Buffer).toString('utf8');
        done(null, text === '' ? {} : JSON.parse(text));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // --- the guest comes back from Checkout ----------------------------------

  app.get('/return', async (req, reply) => {
    const parsed = ReturnQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.type('text/html').send(
        statusPage({
          heading: 'Something went wrong',
          body: 'We did not get a payment reference back. If you were charged, show this screen to whoever runs the jukebox.',
          tone: 'error',
        }),
      );
    }

    if (!ctx.payments) {
      return reply.type('text/html').send(
        statusPage({
          heading: 'Payments are off',
          body: 'This jukebox is not set up to take payments right now.',
          tone: 'error',
        }),
      );
    }

    const outcome = await ctx.payments.confirmSession(parsed.data.session_id);

    switch (outcome.status) {
      case 'queued':
      case 'already_queued': {
        const position = outcome.position;
        return reply.type('text/html').send(
          statusPage({
            heading: "You're in",
            body:
              position === 1 || position === null
                ? `${outcome.request.track_name} is up next.`
                : `${outcome.request.track_name} is number ${position} in the queue.`,
            tone: 'ok',
            amount: { cents: outcome.request.amount_cents, currency: outcome.request.currency },
          }),
        );
      }

      case 'unpaid':
        return reply.type('text/html').send(
          statusPage({
            heading: 'Payment not completed',
            body: 'Your card was not charged, and nothing was queued. You can pick a song again.',
            tone: 'info',
          }),
        );

      case 'unknown_session':
        return reply.status(404).type('text/html').send(
          statusPage({
            heading: 'We could not find that request',
            body: 'If you were charged, show this screen to whoever runs the jukebox.',
            tone: 'error',
          }),
        );

      case 'error':
      default:
        return reply.status(502).type('text/html').send(
          statusPage({ heading: 'Hold on', body: outcome.message, tone: 'error' }),
        );
    }
  });

  // --- the webhook ----------------------------------------------------------

  app.post('/webhooks/stripe', async (req, reply) => {
    if (!ctx.payments || !ctx.paymentGateway) {
      return reply.status(503).send({ error: 'payments not configured' });
    }

    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      return reply.status(400).send({ error: 'missing signature' });
    }

    const rawBody = req.body;
    if (!Buffer.isBuffer(rawBody)) {
      log.error('webhook body was not raw; signature cannot be verified');
      return reply.status(400).send({ error: 'bad body' });
    }

    let event;
    try {
      event = ctx.paymentGateway.parseWebhook(rawBody, signature);
    } catch (err) {
      // An invalid signature is the expected shape of an attack here.
      log.warn('rejected a webhook with an invalid signature', {
        message: err instanceof Error ? err.message : String(err),
      });
      return reply.status(400).send({ error: 'invalid signature' });
    }

    // Acknowledge anything we do not handle, so Stripe stops retrying it.
    if (event.type !== 'checkout.session.completed') {
      return reply.send({ received: true, ignored: event.type });
    }

    if (!event.sessionId) {
      return reply.send({ received: true, ignored: 'no session id' });
    }

    // Same idempotent path as the browser return — whichever arrives second
    // finds the request already queued and changes nothing.
    const outcome = await ctx.payments.confirmSession(event.sessionId);
    log.info('webhook processed', {
      event_id: event.id,
      session_id: event.sessionId,
      outcome: outcome.status,
    });

    if (outcome.status === 'error') {
      // Tell Stripe to retry; something on our side was temporarily broken.
      return reply.status(500).send({ error: 'could not process' });
    }
    return reply.send({ received: true, outcome: outcome.status });
  });
}

function statusPage(opts: {
  heading: string;
  body: string;
  tone: 'ok' | 'error' | 'info';
  amount?: { cents: number; currency: string };
}): string {
  return page({
    title: opts.heading,
    bodyClass: 'page-guest',
    body: html`
      <main class="guest-main return">
        <div class="card return__card return__card--${opts.tone}">
          <h1>${opts.heading}</h1>
          <p>${opts.body}</p>
          ${opts.amount && opts.amount.cents > 0
            ? html`<p class="hint">
                Paid ${formatMoney(opts.amount.cents, opts.amount.currency as Currency)}
              </p>`
            : ''}
          <a class="btn btn--primary" href="/">Back to the jukebox</a>
        </div>
      </main>
    `,
  });
}
