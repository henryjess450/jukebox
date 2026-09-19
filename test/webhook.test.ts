/**
 * Webhook signature verification and the HTTP routes around payment.
 *
 * `constructEvent` is local cryptography, so this exercises the real Stripe
 * gateway with no network. Signatures are generated with Stripe's own test
 * helper — the point is that a forged one is rejected.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import Stripe from 'stripe';
import { openDatabase, type Db } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { SettingsStore } from '../src/config/settings.js';
import { QueueRepository } from '../src/queue/repository.js';
import { BlocklistRepository } from '../src/queue/blocklist.js';
import { PlaybackEngine } from '../src/engine/loop.js';
import { PaymentService } from '../src/payments/service.js';
import { StripeGateway } from '../src/payments/gateway.js';
import { buildServer } from '../src/server.js';
import { loadEnv } from '../src/config/env.js';
import type { AppContext } from '../src/context.js';
import type { PaymentGateway, RetrievedSession } from '../src/payments/gateway.js';
import type { SpotifyAuth } from '../src/spotify/auth.js';
import type { SpotifyClient } from '../src/spotify/client.js';
import type { Track } from '../src/spotify/types.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

const WEBHOOK_SECRET = 'whsec_test_secret_for_signature_checks';
const BCRYPT = '$2b$04$x9IebrW3lUCYuMoC6nDCW.dKgG/M0x/Yuk1u1ebbE874/h.doiM5e';

function track(): Track {
  return {
    id: 't1',
    uri: 'spotify:track:t1',
    name: 'Harvest Moon',
    artist: 'Neil Young',
    album: 'Harvest Moon',
    albumArtUrl: null,
    durationMs: 300_000,
    explicit: false,
    artistIds: ['a1'],
  };
}

/** A completed-checkout event body, as Stripe would send it. */
function completedEvent(sessionId: string, paymentStatus = 'paid'): string {
  return JSON.stringify({
    id: 'evt_test_1',
    object: 'event',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        payment_status: paymentStatus,
        payment_intent: 'pi_test_1',
        metadata: { request_id: '1', track_uri: 'spotify:track:t1' },
      },
    },
  });
}

function sign(payload: string, secret = WEBHOOK_SECRET): string {
  return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}

describe('StripeGateway.parseWebhook', () => {
  const gateway = new StripeGateway('sk_test_placeholder', WEBHOOK_SECRET);

  it('accepts a correctly signed payload', () => {
    const payload = completedEvent('cs_test_1');
    const event = gateway.parseWebhook(Buffer.from(payload), sign(payload));

    assert.equal(event.type, 'checkout.session.completed');
    assert.equal(event.sessionId, 'cs_test_1');
    assert.equal(event.paymentIntentId, 'pi_test_1');
    assert.equal(event.paymentStatus, 'paid');
  });

  it('rejects a payload signed with the wrong secret', () => {
    const payload = completedEvent('cs_test_1');
    assert.throws(() =>
      gateway.parseWebhook(Buffer.from(payload), sign(payload, 'whsec_someone_elses_secret')),
    );
  });

  it('rejects a tampered payload', () => {
    const payload = completedEvent('cs_test_1');
    const signature = sign(payload);
    // Same signature, different body — the attack the signature exists to stop.
    const tampered = completedEvent('cs_test_attacker_controlled');
    assert.throws(() => gateway.parseWebhook(Buffer.from(tampered), signature));
  });

  it('rejects a missing or malformed signature header', () => {
    const payload = completedEvent('cs_test_1');
    assert.throws(() => gateway.parseWebhook(Buffer.from(payload), ''));
    assert.throws(() => gateway.parseWebhook(Buffer.from(payload), 't=1,v1=deadbeef'));
  });

  it('rejects a replayed payload once its timestamp is stale', () => {
    const payload = completedEvent('cs_test_1');
    const old = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    assert.throws(() => gateway.parseWebhook(Buffer.from(payload), old));
  });

  it('refuses to verify anything when no secret is configured', () => {
    const noSecret = new StripeGateway('sk_test_placeholder');
    const payload = completedEvent('cs_test_1');
    assert.throws(() => noSecret.parseWebhook(Buffer.from(payload), sign(payload)), /secret/);
  });
});

describe('payment routes', () => {
  let dir: string;
  let db: Db;
  let queue: QueueRepository;
  let ctx: AppContext;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let retrievedStatus = 'paid';

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jukebox-webhook-'));
    db = openDatabase(join(dir, 'w.db'));
  });

  after(async () => {
    await app?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await app?.close();
    db.prepare('DELETE FROM events').run();
    db.prepare('DELETE FROM requests').run();
    retrievedStatus = 'paid';

    const env = loadEnv({
      NODE_ENV: 'test',
      PUBLIC_URL: 'https://jukebox.example.com',
      COOKIE_SECRET: 'c'.repeat(48),
      ADMIN_PASSWORD_HASH: BCRYPT,
      SPOTIFY_CLIENT_ID: 'id',
      SPOTIFY_CLIENT_SECRET: 'secret',
      STRIPE_SECRET_KEY: 'sk_test_placeholder',
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });

    queue = new QueueRepository(db);
    const settings = new SettingsStore(db);
    const events = new EventLog(db);
    const spotifyAuth = { isConnected: () => true } as unknown as SpotifyAuth;
    const spotify = {} as SpotifyClient;

    // Real gateway for signature checks; retrieval is stubbed so no network.
    const real = new StripeGateway('sk_test_placeholder', WEBHOOK_SECRET);
    const gateway: PaymentGateway = {
      createCheckoutSession: async () => ({ id: 'cs_test_1', url: 'https://checkout.test/1' }),
      retrieveSession: async (sessionId): Promise<RetrievedSession> => ({
        id: sessionId,
        paymentStatus: retrievedStatus,
        paymentIntentId: 'pi_test_1',
        amountTotal: 200,
        currency: 'cad',
        metadata: {},
      }),
      refund: async () => ({ id: 're_test_1', status: 'succeeded' }),
      parseWebhook: (body, signature) => real.parseWebhook(body, signature),
    };

    ctx = {
      env,
      db,
      settings,
      events,
      spotifyAuth,
      spotify,
      queue,
      blocklist: new BlocklistRepository(db),
      engine: new PlaybackEngine({ spotify, auth: spotifyAuth, queue, settings, events }),
      paymentGateway: gateway,
      payments: new PaymentService({
        gateway,
        queue,
        events,
        publicUrl: env.PUBLIC_URL,
      }),
    };

    app = await buildServer(ctx);
  });

  function pendingWithSession(sessionId: string): number {
    const id = queue.enqueue({
      track: track(),
      sessionId: 'guest-1',
      ipHash: 'h',
      state: 'pending_payment',
      amountCents: 200,
      currency: 'CAD',
    });
    queue.attachStripeSession(id, sessionId);
    return id;
  }

  describe('POST /webhooks/stripe', () => {
    it('queues the request on a signed completion event', async () => {
      const id = pendingWithSession('cs_test_1');
      const payload = completedEvent('cs_test_1');

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'stripe-signature': sign(payload), 'content-type': 'application/json' },
        payload,
      });

      assert.equal(response.statusCode, 200);
      assert.equal(queue.byId(id)?.state, 'queued');
    });

    it('rejects an unsigned request without touching the queue', async () => {
      const id = pendingWithSession('cs_test_1');
      const payload = completedEvent('cs_test_1');

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'content-type': 'application/json' },
        payload,
      });

      assert.equal(response.statusCode, 400);
      assert.equal(queue.byId(id)?.state, 'pending_payment');
    });

    it('rejects a forged signature', async () => {
      const id = pendingWithSession('cs_test_1');
      const payload = completedEvent('cs_test_1');

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: {
          'stripe-signature': sign(payload, 'whsec_forged'),
          'content-type': 'application/json',
        },
        payload,
      });

      assert.equal(response.statusCode, 400);
      assert.equal(queue.byId(id)?.state, 'pending_payment', 'a forgery must never queue anything');
    });

    it('is idempotent across repeated deliveries', async () => {
      const id = pendingWithSession('cs_test_1');
      const payload = completedEvent('cs_test_1');
      const headers = { 'stripe-signature': sign(payload), 'content-type': 'application/json' };

      await app.inject({ method: 'POST', url: '/webhooks/stripe', headers, payload });
      await app.inject({ method: 'POST', url: '/webhooks/stripe', headers, payload });
      await app.inject({ method: 'POST', url: '/webhooks/stripe', headers, payload });

      assert.equal(queue.listQueued().length, 1, 'Stripe retries; we must not re-queue');
      assert.equal(queue.byId(id)?.state, 'queued');
    });

    it('acknowledges event types it does not handle', async () => {
      const payload = JSON.stringify({
        id: 'evt_2',
        object: 'event',
        type: 'payment_intent.created',
        data: { object: { id: 'pi_test_9' } },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'stripe-signature': sign(payload), 'content-type': 'application/json' },
        payload,
      });

      // A 200 stops Stripe retrying something we will never act on.
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /ignored/);
    });

    it('does not queue an unpaid session even when the event is genuine', async () => {
      retrievedStatus = 'unpaid';
      const id = pendingWithSession('cs_test_1');
      const payload = completedEvent('cs_test_1', 'unpaid');

      await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'stripe-signature': sign(payload), 'content-type': 'application/json' },
        payload,
      });

      assert.equal(queue.byId(id)?.state, 'pending_payment');
    });
  });

  describe('GET /return', () => {
    it('confirms server-side and shows the position', async () => {
      const id = pendingWithSession('cs_test_1');

      const response = await app.inject({ method: 'GET', url: '/return?session_id=cs_test_1' });

      assert.equal(response.statusCode, 200);
      assert.match(response.body, /You&#39;re in|You're in/);
      assert.match(response.body, /Harvest Moon/);
      assert.equal(queue.byId(id)?.state, 'queued');
    });

    it('says plainly when payment did not complete', async () => {
      retrievedStatus = 'unpaid';
      const id = pendingWithSession('cs_test_1');

      const response = await app.inject({ method: 'GET', url: '/return?session_id=cs_test_1' });

      assert.match(response.body, /not charged/);
      assert.equal(queue.byId(id)?.state, 'pending_payment');
    });

    it('does not queue twice when the guest refreshes', async () => {
      pendingWithSession('cs_test_1');
      await app.inject({ method: 'GET', url: '/return?session_id=cs_test_1' });
      await app.inject({ method: 'GET', url: '/return?session_id=cs_test_1' });
      assert.equal(queue.listQueued().length, 1);
    });

    it('rejects a made-up session id', async () => {
      const response = await app.inject({ method: 'GET', url: '/return?session_id=cs_invented' });
      assert.equal(response.statusCode, 404);
      assert.equal(queue.listQueued().length, 0);
    });

    it('handles a missing session id without a stack trace', async () => {
      const response = await app.inject({ method: 'GET', url: '/return' });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /payment reference/);
    });
  });

  it('still parses ordinary JSON bodies on other routes', async () => {
    // The webhook's raw-body parser must not break the rest of the API.
    const response = await app.inject({
      method: 'POST',
      url: '/api/request',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ trackId: '' }),
    });
    assert.equal(response.statusCode, 400);
  });
});
