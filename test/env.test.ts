/** Boot-time environment validation. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadEnv, stripeConfigured } from '../src/config/env.js';

const VALID_BCRYPT = '$2b$04$x9IebrW3lUCYuMoC6nDCW.dKgG/M0x/Yuk1u1ebbE874/h.doiM5e';

function baseEnv(): NodeJS.ProcessEnv {
  return {
    PUBLIC_URL: 'https://jukebox.example.com',
    COOKIE_SECRET: 'x'.repeat(48),
    ADMIN_PASSWORD_HASH: VALID_BCRYPT,
    SPOTIFY_CLIENT_ID: 'id',
    SPOTIFY_CLIENT_SECRET: 'secret',
  };
}

describe('loadEnv', () => {
  it('accepts a complete environment and applies defaults', () => {
    const env = loadEnv(baseEnv());
    assert.equal(env.PORT, 4321);
    assert.equal(env.HOST, '127.0.0.1');
    assert.equal(env.NODE_ENV, 'production');
  });

  it('refuses to boot without an admin password hash', () => {
    const env = baseEnv();
    delete env['ADMIN_PASSWORD_HASH'];
    assert.throws(() => loadEnv(env), /ADMIN_PASSWORD_HASH/);
  });

  it('refuses a plaintext admin password mistaken for a hash', () => {
    assert.throws(
      () => loadEnv({ ...baseEnv(), ADMIN_PASSWORD_HASH: 'hunter2' }),
      /bcrypt hash/,
    );
  });

  it('refuses a short cookie secret', () => {
    assert.throws(() => loadEnv({ ...baseEnv(), COOKIE_SECRET: 'short' }), /COOKIE_SECRET/);
  });

  it('refuses a malformed public URL', () => {
    assert.throws(() => loadEnv({ ...baseEnv(), PUBLIC_URL: 'jukebox.example.com' }), /PUBLIC_URL/);
  });

  it('refuses localhost, which Spotify will not accept as a redirect URI', () => {
    // Since Feb 2025 Spotify rejects the hostname outright; finding out here
    // beats finding out on Spotify's error page.
    assert.throws(
      () => loadEnv({ ...baseEnv(), PUBLIC_URL: 'http://localhost:4321' }),
      /127\.0\.0\.1/,
    );
  });

  it('accepts the loopback literal over plain HTTP', () => {
    const env = loadEnv({ ...baseEnv(), PUBLIC_URL: 'http://127.0.0.1:4321' });
    assert.equal(env.PUBLIC_URL, 'http://127.0.0.1:4321');
  });

  it('accepts IPv6 loopback', () => {
    const env = loadEnv({ ...baseEnv(), PUBLIC_URL: 'http://[::1]:4321' });
    assert.equal(env.PUBLIC_URL, 'http://[::1]:4321');
  });

  it('refuses plain HTTP on a real hostname', () => {
    assert.throws(
      () => loadEnv({ ...baseEnv(), PUBLIC_URL: 'http://jukebox.example.com' }),
      /loopback/,
    );
  });

  it('strips a trailing slash from the public URL', () => {
    const env = loadEnv({ ...baseEnv(), PUBLIC_URL: 'https://jukebox.example.com/' });
    assert.equal(env.PUBLIC_URL, 'https://jukebox.example.com');
  });

  it('treats an empty value as absent, as a dotenv file means it', () => {
    // .env.example ships `STRIPE_SECRET_KEY=` with nothing after it.
    const env = loadEnv({ ...baseEnv(), STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '   ' });
    assert.equal(env.STRIPE_SECRET_KEY, undefined);
    assert.equal(stripeConfigured(env), false);
  });

  it('still reports a required variable that is present but empty', () => {
    assert.throws(() => loadEnv({ ...baseEnv(), COOKIE_SECRET: '' }), /COOKIE_SECRET/);
  });

  it('falls back to defaults when an optional value is blank', () => {
    const env = loadEnv({ ...baseEnv(), PORT: '', HOST: '' });
    assert.equal(env.PORT, 4321);
    assert.equal(env.HOST, '127.0.0.1');
  });

  it('honours an API base override outside production', () => {
    const env = loadEnv({ ...baseEnv(), NODE_ENV: 'development', SPOTIFY_API_BASE: 'http://localhost:4010/v1' });
    assert.equal(env.SPOTIFY_API_BASE, 'http://localhost:4010/v1');
  });

  it('ignores a Stripe API override in production', () => {
    // A live box must never send a real payment anywhere but Stripe.
    const env = loadEnv({
      ...baseEnv(),
      NODE_ENV: 'production',
      STRIPE_SECRET_KEY: 'sk_live_x',
      STRIPE_API_BASE: 'http://attacker.test',
    });
    assert.equal(env.STRIPE_API_BASE, undefined);
  });

  it('ignores an API base override in production, whatever is set', () => {
    // A stray value in the environment must never redirect a live box's
    // traffic away from Spotify.
    const env = loadEnv({ ...baseEnv(), NODE_ENV: 'production', SPOTIFY_API_BASE: 'http://evil.test/v1' });
    assert.equal(env.SPOTIFY_API_BASE, undefined);
  });

  it('treats Stripe as optional', () => {
    assert.equal(stripeConfigured(loadEnv(baseEnv())), false);
    assert.equal(stripeConfigured(loadEnv({ ...baseEnv(), STRIPE_SECRET_KEY: 'sk_test_x' })), true);
  });
});
