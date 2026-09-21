/**
 * Payment confirmation. The gateway is a fake, so every path — including the
 * ones that only happen when Stripe is having a bad day — is exercised
 * deterministically.
 *
 * The rule under test throughout: one payment buys exactly one play.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { QueueRepository } from '../src/queue/repository.js';
import { PaymentService } from '../src/payments/service.js';
import type {
  CheckoutSession,
  CheckoutSessionInput,
  PaymentGateway,
  Refund,
  RetrievedSession,
  WebhookEvent,
} from '../src/payments/gateway.js';
import type { Track } from '../src/spotify/types.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

function track(over: Partial<Track> = {}): Track {
  return {
    id: 't1',
    uri: 'spotify:track:t1',
    name: 'Harvest Moon',
    artist: 'Neil Young',
    album: 'Harvest Moon',
    albumArtUrl: 'https://example.test/art.jpg',
    durationMs: 300_000,
    explicit: false,
    artistIds: ['a1'],
    ...over,
  };
}

interface FakeOptions {
  paymentStatus?: string;
  failCreate?: Error;
  failRetrieve?: Error;
  failRefund?: Error;
}

function fakeGateway(opts: FakeOptions = {}) {
  const created: CheckoutSessionInput[] = [];
  const refunded: Array<{ paymentIntentId: string; reason: string }> = [];
  let retrievals = 0;
  let sessionCounter = 0;

  const gateway: PaymentGateway = {
    async createCheckoutSession(input): Promise<CheckoutSession> {
      if (opts.failCreate) throw opts.failCreate;
      created.push(input);
      sessionCounter++;
      return { id: `cs_test_${sessionCounter}`, url: `https://checkout.stripe.test/${sessionCounter}` };
    },
    async retrieveSession(sessionId): Promise<RetrievedSession> {
      if (opts.failRetrieve) throw opts.failRetrieve;
      retrievals++;
      return {
        id: sessionId,
        paymentStatus: opts.paymentStatus ?? 'paid',
        paymentIntentId: 'pi_test_1',
        amountTotal: 200,
        currency: 'cad',
        metadata: { request_id: '1', track_uri: 'spotify:track:t1' },
      };
    },
    async refund(paymentIntentId, reason): Promise<Refund> {
      if (opts.failRefund) throw opts.failRefund;
      refunded.push({ paymentIntentId, reason });
      return { id: `re_test_${refunded.length}`, status: 'succeeded' };
    },
    parseWebhook(): WebhookEvent {
      throw new Error('not used in these tests');
    },
  };

  return {
    gateway,
    created,
    refunded,
    retrievals: () => retrievals,
  };
}

let dir: string;
let db: Db;
let queue: QueueRepository;
let events: EventLog;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jukebox-pay-'));
  db = openDatabase(join(dir, 'pay.db'));
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM requests').run();
  queue = new QueueRepository(db);
  events = new EventLog(db);
});

function serviceWith(fake: ReturnType<typeof fakeGateway>, onQueued?: () => void): PaymentService {
  return new PaymentService({
    gateway: fake.gateway,
    queue,
    events,
    publicUrl: 'https://jukebox.example.com',
    ...(onQueued ? { onQueued } : {}),
  });
}

function pendingRequest(amountCents = 200): number {
  return queue.enqueue({
    track: track(),
    sessionId: 'guest-1',
    ipHash: 'hash',
    state: 'pending_payment',
    amountCents,
    currency: 'CAD',
  });
}

describe('startCheckout', () => {
  it('creates a session carrying the request id and the track', async () => {
    const fake = fakeGateway();
    const id = pendingRequest();
    const result = await serviceWith(fake).startCheckout({
      requestId: id,
      row: queue.byId(id)!,
      productName: 'Harvest Moon',
    });

    assert.match(result.url, /^https:\/\/checkout\.stripe\.test\//);
    const input = fake.created[0]!;
    assert.equal(input.requestId, id);
    assert.equal(input.amountCents, 200);
    assert.equal(input.currency, 'CAD');
    assert.equal(input.trackName, 'Harvest Moon');
    assert.equal(input.productName, 'Harvest Moon');
    assert.equal(input.trackUri, 'spotify:track:t1');
  });

  it('points the return URL at our own confirmation route', async () => {
    const fake = fakeGateway();
    const id = pendingRequest();
    await serviceWith(fake).startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' });

    const input = fake.created[0]!;
    assert.match(input.successUrl, /^https:\/\/jukebox\.example\.com\/return/);
    // The placeholder Stripe substitutes — without it we cannot verify at all.
    assert.match(input.successUrl, /\{CHECKOUT_SESSION_ID\}/);
  });

  it('records the session id against the request', async () => {
    const fake = fakeGateway();
    const id = pendingRequest();
    const result = await serviceWith(fake).startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' });
    assert.equal(queue.byId(id)?.stripe_session_id, result.sessionId);
  });

  it('gives the guest a deadline, so an abandoned checkout expires', async () => {
    const fake = fakeGateway();
    const id = pendingRequest();
    await serviceWith(fake).startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' });
    assert.ok(fake.created[0]!.expiresAt > Math.floor(Date.now() / 1000));
  });

  it('cancels the request when Stripe will not create a session', async () => {
    const fake = fakeGateway({ failCreate: new Error('Stripe is down') });
    const id = pendingRequest();

    await assert.rejects(() =>
      serviceWith(fake).startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' }),
    );
    // Otherwise the row sits in pending_payment and eats the guest's allowance.
    assert.equal(queue.byId(id)?.state, 'cancelled');
  });

  it('never queues anything before payment', async () => {
    const fake = fakeGateway();
    const id = pendingRequest();
    await serviceWith(fake).startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' });
    assert.equal(queue.listQueued().length, 0);
    assert.equal(queue.byId(id)?.state, 'pending_payment');
  });
});

describe('confirmSession', () => {
  async function started(fake: ReturnType<typeof fakeGateway>): Promise<{ id: number; sessionId: string }> {
    const id = pendingRequest();
    const result = await serviceWith(fake).startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' });
    return { id, sessionId: result.sessionId };
  }

  it('queues a paid request', async () => {
    const fake = fakeGateway({ paymentStatus: 'paid' });
    const { id, sessionId } = await started(fake);

    const outcome = await serviceWith(fake).confirmSession(sessionId);

    assert.equal(outcome.status, 'queued');
    assert.equal(queue.byId(id)?.state, 'queued');
    assert.equal(queue.byId(id)?.stripe_payment_intent, 'pi_test_1');
    assert.ok(queue.byId(id)?.paid_at);
  });

  it('asks Stripe rather than believing the browser', async () => {
    const fake = fakeGateway({ paymentStatus: 'paid' });
    const { sessionId } = await started(fake);
    await serviceWith(fake).confirmSession(sessionId);
    assert.equal(fake.retrievals(), 1, 'the session id alone must never be enough');
  });

  it('refuses to queue an unpaid session', async () => {
    const fake = fakeGateway({ paymentStatus: 'unpaid' });
    const { id, sessionId } = await started(fake);

    const outcome = await serviceWith(fake).confirmSession(sessionId);

    assert.equal(outcome.status, 'unpaid');
    assert.equal(queue.byId(id)?.state, 'pending_payment');
    assert.equal(queue.listQueued().length, 0);
  });

  it('is idempotent: confirming twice queues once', async () => {
    const fake = fakeGateway({ paymentStatus: 'paid' });
    const { id, sessionId } = await started(fake);
    const service = serviceWith(fake);

    const first = await service.confirmSession(sessionId);
    const second = await service.confirmSession(sessionId);

    assert.equal(first.status, 'queued');
    assert.equal(second.status, 'already_queued');
    assert.equal(queue.listQueued().length, 1, 'one payment, one play');
    assert.equal(queue.byId(id)?.state, 'queued');
  });

  it('survives the browser return and the webhook racing each other', async () => {
    const fake = fakeGateway({ paymentStatus: 'paid' });
    const { sessionId } = await started(fake);
    const service = serviceWith(fake);

    const outcomes = await Promise.all([
      service.confirmSession(sessionId),
      service.confirmSession(sessionId),
      service.confirmSession(sessionId),
    ]);

    assert.equal(queue.listQueued().length, 1);
    assert.equal(outcomes.filter((o) => o.status === 'queued').length, 1);
  });

  it('records the payment exactly once in the audit log', async () => {
    const fake = fakeGateway({ paymentStatus: 'paid' });
    const { sessionId } = await started(fake);
    const service = serviceWith(fake);

    await service.confirmSession(sessionId);
    await service.confirmSession(sessionId);

    const paid = events.recent().filter((e) => e.kind === 'request_paid');
    assert.equal(paid.length, 1);
  });

  it('reports a session it never issued', async () => {
    const fake = fakeGateway({ paymentStatus: 'paid' });
    const outcome = await serviceWith(fake).confirmSession('cs_test_not_ours');
    assert.equal(outcome.status, 'unknown_session');
    assert.equal(queue.listQueued().length, 0);
  });

  it('does not queue when Stripe cannot be reached', async () => {
    const fake = fakeGateway({ failRetrieve: new Error('connection reset') });
    const outcome = await serviceWith(fake).confirmSession('cs_test_1');
    assert.equal(outcome.status, 'error');
    assert.equal(queue.listQueued().length, 0);
  });

  it('pushes the live queue once payment lands', async () => {
    const fake = fakeGateway({ paymentStatus: 'paid' });
    let published = 0;
    const service = serviceWith(fake, () => published++);
    const id = pendingRequest();
    const { sessionId } = await service.startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' });

    await service.confirmSession(sessionId);
    await service.confirmSession(sessionId);

    assert.equal(published, 1, 'only the confirmation that changed anything notifies');
  });

  it('reports a position a guest can act on', async () => {
    const fake = fakeGateway({ paymentStatus: 'paid' });
    queue.enqueue({
      track: track({ id: 'other', uri: 'spotify:track:other' }),
      sessionId: 'guest-2',
      ipHash: 'h',
      state: 'queued',
      amountCents: 0,
      currency: 'CAD',
    });
    const { sessionId } = await started(fake);

    const outcome = await serviceWith(fake).confirmSession(sessionId);
    assert.equal(outcome.status === 'queued' && outcome.position, 2);
  });
});

describe('refunds', () => {
  async function paidThenFailed(fake: ReturnType<typeof fakeGateway>): Promise<number> {
    const id = pendingRequest();
    const service = serviceWith(fake);
    const { sessionId } = await service.startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' });
    await service.confirmSession(sessionId);
    queue.markFailed(id, 'handed to Spotify but never started playing');
    return id;
  }

  it('refunds a paid request that never played', async () => {
    const fake = fakeGateway();
    const id = await paidThenFailed(fake);

    const result = await serviceWith(fake).refund(id, 'never played');

    assert.equal(result.ok, true);
    assert.equal(fake.refunded.length, 1);
    assert.equal(fake.refunded[0]?.paymentIntentId, 'pi_test_1');
    assert.equal(queue.byId(id)?.state, 'refunded');
    assert.ok(queue.byId(id)?.refund_id);
  });

  it('never refunds the same payment twice', async () => {
    const fake = fakeGateway();
    const id = await paidThenFailed(fake);
    const service = serviceWith(fake);

    await service.refund(id, 'never played');
    await service.refund(id, 'never played');
    await service.refund(id, 'never played');

    assert.equal(fake.refunded.length, 1);
  });

  it('does nothing for a free request', async () => {
    const fake = fakeGateway();
    const id = queue.enqueue({
      track: track(),
      sessionId: 'guest-1',
      ipHash: 'h',
      state: 'queued',
      amountCents: 0,
      currency: 'CAD',
    });
    queue.markFailed(id, 'never played');

    const result = await serviceWith(fake).refund(id, 'never played');
    assert.equal(result.ok, true);
    assert.equal(fake.refunded.length, 0, 'there is nothing to give back');
  });

  it('reports a request with no captured payment', async () => {
    const fake = fakeGateway();
    const id = pendingRequest();
    const result = await serviceWith(fake).refund(id, 'never played');
    assert.equal(result.ok, false);
    assert.match(result.message ?? '', /No payment/);
  });

  it('leaves the request refundable when Stripe refuses', async () => {
    const fake = fakeGateway({ failRefund: new Error('Stripe is down') });
    const id = await paidThenFailed(fake);

    const result = await serviceWith(fake).refund(id, 'never played');

    assert.equal(result.ok, false);
    assert.equal(queue.byId(id)?.refund_id, null);
    assert.equal(queue.listRefundable().length, 1, 'the next sweep must try again');
  });

  describe('sweep', () => {
    it('refunds everything owed', async () => {
      const fake = fakeGateway();
      await paidThenFailed(fake);
      await paidThenFailed(fake);

      const issued = await serviceWith(fake).sweepRefunds();

      assert.equal(issued, 2);
      assert.equal(fake.refunded.length, 2);
      assert.deepEqual(queue.listRefundable(), []);
    });

    it('is a no-op when nothing is owed', async () => {
      const fake = fakeGateway();
      assert.equal(await serviceWith(fake).sweepRefunds(), 0);
    });

    it('does not refund a request that played', async () => {
      const fake = fakeGateway();
      const id = pendingRequest();
      const service = serviceWith(fake);
      const { sessionId } = await service.startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' });
      await service.confirmSession(sessionId);
      queue.markPlaying(id);
      queue.markPlayed(id);

      assert.equal(await service.sweepRefunds(), 0);
      assert.equal(fake.refunded.length, 0);
    });

    it('carries the failure reason through to Stripe', async () => {
      const fake = fakeGateway();
      await paidThenFailed(fake);
      await serviceWith(fake).sweepRefunds();
      assert.match(fake.refunded[0]?.reason ?? '', /never started playing/);
    });

    it('refunds an admin cancellation too', async () => {
      const fake = fakeGateway();
      const id = pendingRequest();
      const service = serviceWith(fake);
      const { sessionId } = await service.startCheckout({ requestId: id, row: queue.byId(id)!, productName: 'Harvest Moon' });
      await service.confirmSession(sessionId);
      queue.cancel(id, 'removed by admin');

      assert.equal(await service.sweepRefunds(), 1);
      assert.equal(queue.byId(id)?.state, 'refunded');
    });

    it('keeps going when one refund fails', async () => {
      // A single bad payment intent must not block everyone else's refund.
      const fake = fakeGateway();
      await paidThenFailed(fake);
      const stuck = await paidThenFailed(fake);
      db.prepare('UPDATE requests SET stripe_payment_intent = NULL WHERE id = ?').run(stuck);

      const issued = await serviceWith(fake).sweepRefunds();
      assert.equal(issued, 1);
    });
  });
});
