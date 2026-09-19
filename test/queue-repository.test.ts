/** The queue's storage and ordering rules, against a real SQLite file. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '../src/db/index.js';
import { QueueRepository } from '../src/queue/repository.js';
import type { Track } from '../src/spotify/types.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

let dir: string;
let db: Db;
let repo: QueueRepository;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jukebox-queue-'));
  db = openDatabase(join(dir, 'queue.db'));
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM requests').run();
});

function track(n: number): Track {
  return {
    id: `t${n}`,
    uri: `spotify:track:t${n}`,
    name: `Track ${n}`,
    artist: 'An Artist',
    album: 'An Album',
    albumArtUrl: null,
    durationMs: 200_000,
    explicit: false,
    artistIds: [`a${n}`],
  };
}

function add(n: number, over: Partial<Parameters<QueueRepository['enqueue']>[0]> = {}): number {
  return repo.enqueue({
    track: track(n),
    sessionId: 'sess-a',
    ipHash: 'hash',
    state: 'queued',
    amountCents: 0,
    currency: 'CAD',
    ...over,
  });
}

describe('QueueRepository', () => {
  beforeEach(() => {
    repo = new QueueRepository(db);
  });

  it('stores a request and returns it in order', () => {
    add(1);
    add(2);
    const queued = repo.listQueued();
    assert.deepEqual(queued.map((r) => r.track_id), ['t1', 't2']);
    assert.equal(queued[0]?.state, 'queued');
    assert.equal(queued[0]?.track_name, 'Track 1');
  });

  it('leaves gaps between positions so a reorder is cheap', () => {
    add(1);
    add(2);
    const [first, second] = repo.listQueued();
    assert.ok((second?.position ?? 0) - (first?.position ?? 0) >= 1000);
  });

  it('counts the queue including whatever is playing', () => {
    const id = add(1);
    add(2);
    repo.markPlaying(id);
    assert.equal(repo.countQueued(), 2);
  });

  it('reports a guest’s position as a human would count it', () => {
    const a = add(1);
    const b = add(2);
    const c = add(3);
    assert.equal(repo.queuePosition(a), 1);
    assert.equal(repo.queuePosition(b), 2);
    assert.equal(repo.queuePosition(c), 3);
  });

  describe('state machine', () => {
    it('walks queued → playing → played', () => {
      const id = add(1);
      repo.markPlaying(id);
      assert.equal(repo.byId(id)?.state, 'playing');
      assert.ok(repo.byId(id)?.started_at);

      repo.markPlayed(id);
      assert.equal(repo.byId(id)?.state, 'played');
      assert.ok(repo.byId(id)?.finished_at);
    });

    it('refuses to start a request that is not queued', () => {
      const id = add(1);
      repo.markPlaying(id);
      repo.markPlayed(id);
      repo.markPlaying(id); // a stale tick arriving late
      assert.equal(repo.byId(id)?.state, 'played', 'a finished request must not restart');
    });

    it('refuses to finish a request that never started', () => {
      const id = add(1);
      repo.markPlayed(id);
      assert.equal(repo.byId(id)?.state, 'queued');
    });

    it('records a hand-off without changing state', () => {
      const id = add(1);
      repo.markPushed(id);
      const row = repo.byId(id);
      assert.equal(row?.state, 'queued', 'handed over is not the same as started');
      assert.ok(row?.pushed_at);
    });

    it('can take a hand-off back so the next tick retries', () => {
      const id = add(1);
      repo.markPushed(id);
      repo.clearPushed(id);
      assert.equal(repo.byId(id)?.pushed_at, null);
    });

    it('moves an unpaid request into the queue once payment lands', () => {
      const id = add(1, { state: 'pending_payment', amountCents: 200 });
      assert.equal(repo.listQueued().length, 0, 'unpaid requests must not play');

      repo.markQueued(id, 'pi_123');
      const row = repo.byId(id);
      assert.equal(row?.state, 'queued');
      assert.equal(row?.stripe_payment_intent, 'pi_123');
      assert.ok(row?.paid_at);
      assert.equal(repo.listQueued().length, 1);
    });

    it('will not queue the same payment twice', () => {
      const id = add(1, { state: 'pending_payment', amountCents: 200 });
      repo.markQueued(id, 'pi_123');
      const firstQueuedAt = repo.byId(id)?.queued_at;
      // The webhook arrives after the browser redirect already confirmed it.
      repo.markQueued(id, 'pi_123');
      assert.equal(repo.byId(id)?.queued_at, firstQueuedAt, 'a second confirmation must be inert');
      assert.equal(repo.listQueued().length, 1);
    });

    it('records a failure with its reason', () => {
      const id = add(1);
      repo.markFailed(id, 'handed to Spotify but never started playing');
      const row = repo.byId(id);
      assert.equal(row?.state, 'failed');
      assert.match(row?.failure_reason ?? '', /never started/);
    });

    it('keeps admin removal distinct from failure', () => {
      const id = add(1);
      repo.cancel(id, 'removed by admin');
      assert.equal(repo.byId(id)?.state, 'cancelled');
    });

    it('will not cancel something already playing', () => {
      const id = add(1);
      repo.markPlaying(id);
      repo.cancel(id, 'removed by admin');
      assert.equal(repo.byId(id)?.state, 'playing', 'stopping a playing track is a skip, not a cancel');
    });
  });

  describe('reordering', () => {
    it('moves a request to the front', () => {
      const a = add(1);
      const b = add(2);
      const c = add(3);
      repo.moveTo(c, a);
      assert.deepEqual(repo.listQueued().map((r) => r.id), [c, a, b]);
    });

    it('moves a request to the end', () => {
      const a = add(1);
      const b = add(2);
      const c = add(3);
      repo.moveTo(a, null);
      assert.deepEqual(repo.listQueued().map((r) => r.id), [b, c, a]);
    });

    it('moves a request into the middle', () => {
      const a = add(1);
      const b = add(2);
      const c = add(3);
      repo.moveTo(c, b);
      assert.deepEqual(repo.listQueued().map((r) => r.id), [a, c, b]);
    });

    it('is a no-op for an unknown request or target', () => {
      const a = add(1);
      assert.equal(repo.moveTo(9999, a), false);
      assert.equal(repo.moveTo(a, 9999), false);
    });

    it('survives repeated moves into the same gap', () => {
      const ids = [add(1), add(2), add(3)];
      // Each move halves the gap; eventually positions must be renumbered
      // rather than silently colliding.
      for (let i = 0; i < 80; i++) {
        repo.moveTo(ids[2] as number, ids[1] as number);
        repo.moveTo(ids[1] as number, ids[2] as number);
      }
      const order = repo.listQueued().map((r) => r.id);
      assert.equal(order.length, 3);
      assert.equal(new Set(order).size, 3, 'positions must stay distinct');
    });
  });

  describe('guest limits', () => {
    it('counts only what is in flight for a session', () => {
      const a = add(1);
      add(2);
      assert.equal(repo.countPendingForSession('sess-a'), 2);

      repo.markPlaying(a);
      repo.markPlayed(a);
      assert.equal(repo.countPendingForSession('sess-a'), 1, 'a finished song frees a slot');
    });

    it('counts an unpaid request against the guest', () => {
      add(1, { state: 'pending_payment', amountCents: 200 });
      assert.equal(repo.countPendingForSession('sess-a'), 1);
    });

    it('keeps sessions apart', () => {
      add(1);
      add(2, { sessionId: 'sess-b' });
      assert.equal(repo.countPendingForSession('sess-a'), 1);
      assert.equal(repo.countPendingForSession('sess-b'), 1);
    });

    it('knows whether a track is already in flight', () => {
      const id = add(1);
      assert.equal(repo.isActive('spotify:track:t1'), true);
      assert.equal(repo.isActive('spotify:track:nope'), false);

      repo.markPlaying(id);
      repo.markPlayed(id);
      assert.equal(repo.isActive('spotify:track:t1'), false, 'a played track may be requested again');
    });

    it('remembers when a guest last asked for something', () => {
      assert.equal(repo.lastRequestAt('sess-a'), null);
      add(1);
      assert.ok(repo.lastRequestAt('sess-a'));
    });
  });

  describe('housekeeping', () => {
    it('clears abandoned checkouts so they stop occupying a guest’s slot', () => {
      const id = add(1, { state: 'pending_payment', amountCents: 200 });
      db.prepare('UPDATE requests SET created_at = ? WHERE id = ?').run(
        new Date(Date.now() - 60 * 60_000).toISOString(),
        id,
      );

      assert.equal(repo.expireAbandonedPayments(30 * 60_000), 1);
      assert.equal(repo.byId(id)?.state, 'cancelled');
      assert.equal(repo.countPendingForSession('sess-a'), 0);
    });

    it('leaves a recent checkout alone — the guest may still be typing a card', () => {
      add(1, { state: 'pending_payment', amountCents: 200 });
      assert.equal(repo.expireAbandonedPayments(30 * 60_000), 0);
    });

    it('lists paid requests that never played as owed a refund', () => {
      const paid = add(1, { state: 'pending_payment', amountCents: 200 });
      repo.markQueued(paid, 'pi_123');
      repo.markFailed(paid, 'never started');

      const free = add(2);
      repo.markFailed(free, 'never started');

      const refundable = repo.listRefundable();
      assert.deepEqual(refundable.map((r) => r.id), [paid], 'a free request owes nobody anything');
    });

    it('stops listing a request once it has been refunded', () => {
      const id = add(1, { state: 'pending_payment', amountCents: 200 });
      repo.markQueued(id, 'pi_123');
      repo.markFailed(id, 'never started');
      repo.markRefunded(id, 're_123');
      assert.deepEqual(repo.listRefundable(), []);
    });

    it('finds a request by its Stripe session, for webhook idempotency', () => {
      const id = add(1, { state: 'pending_payment', amountCents: 200, stripeSessionId: 'cs_test_1' });
      assert.equal(repo.byStripeSession('cs_test_1')?.id, id);
      assert.equal(repo.byStripeSession('cs_test_missing'), null);
    });

    it('refuses two requests sharing one Stripe session', () => {
      add(1, { state: 'pending_payment', amountCents: 200, stripeSessionId: 'cs_test_1' });
      assert.throws(
        () => add(2, { state: 'pending_payment', amountCents: 200, stripeSessionId: 'cs_test_1' }),
        /UNIQUE/,
        'one payment must never be able to buy two plays',
      );
    });
  });
});
