/** Pricing rules and the settings store's validation and caching behaviour. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openDatabase, type Db } from '../src/db/index.js';
import {
  SettingsStore,
  STRIPE_MINIMUM_CENTS,
  formatMoney,
  isPaidMode,
  validatePrice,
} from '../src/config/settings.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

describe('validatePrice', () => {
  it('accepts zero as free', () => {
    assert.equal(validatePrice(0, 'CAD'), null);
    assert.equal(validatePrice(0, 'USD'), null);
  });

  it('accepts exactly the Stripe minimum', () => {
    assert.equal(validatePrice(STRIPE_MINIMUM_CENTS.CAD, 'CAD'), null);
    assert.equal(validatePrice(STRIPE_MINIMUM_CENTS.USD, 'USD'), null);
  });

  it('accepts anything above the minimum', () => {
    assert.equal(validatePrice(100, 'CAD'), null);
    assert.equal(validatePrice(2500, 'USD'), null);
  });

  it('rejects the unchargeable band between 1 and the minimum', () => {
    for (const cents of [1, 25, 49]) {
      const err = validatePrice(cents, 'CAD');
      assert.ok(err, `expected ${cents} to be rejected`);
      assert.match(err, /Stripe cannot charge less/);
      // The message must tell the operator both ways out.
      assert.match(err, /\$0\.50/);
    }
  });

  it('rejects negative and fractional cents', () => {
    assert.ok(validatePrice(-1, 'CAD'));
    assert.ok(validatePrice(10.5, 'CAD'));
  });
});

describe('formatMoney', () => {
  it('renders cents as currency', () => {
    assert.equal(formatMoney(50, 'CAD'), '$0.50');
    assert.equal(formatMoney(100, 'CAD'), '$1.00');
    assert.equal(formatMoney(1234, 'USD'), 'US$12.34');
  });
});

describe('isPaidMode', () => {
  const base = { free_mode: false, price_cents: 100 } as Parameters<typeof isPaidMode>[0];

  it('is paid only when free mode is off and the price is above zero', () => {
    assert.equal(isPaidMode({ ...base, free_mode: false, price_cents: 100 }), true);
    assert.equal(isPaidMode({ ...base, free_mode: true, price_cents: 100 }), false);
    assert.equal(isPaidMode({ ...base, free_mode: false, price_cents: 0 }), false);
    assert.equal(isPaidMode({ ...base, free_mode: true, price_cents: 0 }), false);
  });
});

describe('SettingsStore', () => {
  let dir: string;
  let db: Db;
  let store: SettingsStore;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'jukebox-test-'));
    db = openDatabase(join(dir, 'test.db'));
    store = new SettingsStore(db);
  });

  after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves defaults before anything is written', () => {
    assert.equal(store.get('free_mode'), true);
    assert.equal(store.get('currency'), 'CAD');
    assert.equal(store.get('market'), 'CA');
  });

  it('applies a valid update immediately, with no reload', () => {
    const result = store.update({ venue_name: 'The Back Room', cooldown_seconds: 90 });
    assert.deepEqual(result, { ok: true });
    assert.equal(store.get('venue_name'), 'The Back Room');
    assert.equal(store.get('cooldown_seconds'), 90);
  });

  it('persists across a fresh store on the same database', () => {
    const reopened = new SettingsStore(db);
    assert.equal(reopened.get('venue_name'), 'The Back Room');
  });

  it('rejects an out-of-range value and changes nothing', () => {
    const before_ = store.get('volume_percent');
    const result = store.update({ volume_percent: 150 });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors['volume_percent']);
    assert.equal(store.get('volume_percent'), before_);
  });

  it('rejects a whole patch if any key fails — updates are all or nothing', () => {
    const result = store.update({ venue_name: 'Valid Name', volume_percent: 999 });
    assert.equal(result.ok, false);
    assert.equal(store.get('venue_name'), 'The Back Room');
  });

  it('rejects a malformed playlist URI', () => {
    const result = store.update({ fallback_playlist_uri: 'not-a-uri' });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /spotify:playlist/.test(result.errors['fallback_playlist_uri'] ?? ''));
  });

  it('enforces the Stripe minimum when the price changes', () => {
    const result = store.update({ price_cents: 25 });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && /Stripe cannot charge less/.test(result.errors['price_cents'] ?? ''));
  });

  it('allows zero even though it is below the Stripe minimum', () => {
    assert.deepEqual(store.update({ price_cents: 0 }), { ok: true });
    assert.equal(store.get('price_cents'), 0);
  });

  it('re-validates the price when only the currency changes', () => {
    assert.deepEqual(store.update({ price_cents: 60, currency: 'CAD' }), { ok: true });
    assert.deepEqual(store.update({ currency: 'USD' }), { ok: true });
    assert.equal(store.get('currency'), 'USD');
  });

  it('ignores unknown keys by reporting them rather than writing them', () => {
    const result = store.update({ definitely_not_a_setting: 1 } as Record<string, unknown>);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors['definitely_not_a_setting']);
  });

  it('falls back to the default when a stored row is corrupt', () => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('max_queue_length', 'not json', datetime())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run();
    const reopened = new SettingsStore(db);
    assert.equal(reopened.get('max_queue_length'), 25);
  });
});
