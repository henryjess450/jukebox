/** Token lifecycle: exchange, refresh, single-flight, and revocation. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '../src/db/index.js';
import { SpotifyAuth, SPOTIFY_SCOPES } from '../src/spotify/auth.js';
import { SpotifyError } from '../src/spotify/errors.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

let dir: string;
let db: Db;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jukebox-auth-'));
  db = openDatabase(join(dir, 'auth.db'));
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare('DELETE FROM spotify_auth').run();
});

interface Scripted {
  body: unknown;
  status?: number;
}

function build(script: Scripted[], opts: { onCall?: (body: string) => void } = {}) {
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    opts.onCall?.(String(init.body ?? ''));
    const next = script.shift() ?? { body: {}, status: 500 };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const auth = new SpotifyAuth({
    db,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://jukebox.example.com/admin/spotify/callback',
    stateSecret: 'k'.repeat(48),
    fetchImpl,
  });

  return { auth, callCount: () => calls };
}

describe('authorize URL', () => {
  it('requests exactly the scopes we declare, and round-trips its state', () => {
    const { auth } = build([]);
    const url = new URL(auth.authorizeUrl());

    assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'client-id');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      'https://jukebox.example.com/admin/spotify/callback',
    );
    assert.equal(url.searchParams.get('scope'), SPOTIFY_SCOPES.join(' '));
    // Playback control is impossible without these two.
    assert.ok(url.searchParams.get('scope')?.includes('user-modify-playback-state'));
    assert.ok(url.searchParams.get('scope')?.includes('user-read-playback-state'));

    assert.equal(auth.verifyState(url.searchParams.get('state')), true);
  });

  it('never reuses a state value', () => {
    const { auth } = build([]);
    const a = new URL(auth.authorizeUrl()).searchParams.get('state');
    const b = new URL(auth.authorizeUrl()).searchParams.get('state');
    assert.notEqual(a, b);
  });

  it('rejects forged, absent and truncated state', () => {
    const { auth } = build([]);
    const real = new URL(auth.authorizeUrl()).searchParams.get('state') as string;
    assert.equal(auth.verifyState(undefined), false);
    assert.equal(auth.verifyState(''), false);
    assert.equal(auth.verifyState('nonce.signature'), false);
    assert.equal(auth.verifyState(real.split('.')[0] as string), false);
    assert.equal(auth.verifyState(`${real}x`), false);
  });
});

describe('exchangeCode', () => {
  it('stores the tokens and reports a connection', async () => {
    let sentBody = '';
    const { auth } = build(
      [{ body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT', scope: SPOTIFY_SCOPES.join(' ') } }],
      { onCall: (b) => (sentBody = b) },
    );

    await auth.exchangeCode('the-code');

    assert.equal(auth.isConnected(), true);
    assert.equal(await auth.getAccessToken(), 'AT');
    // Authorization Code flow, not client credentials — the distinction is the
    // whole reason playback control works at all.
    assert.ok(sentBody.includes('grant_type=authorization_code'));
    assert.ok(sentBody.includes('code=the-code'));
  });

  it('refuses a response with no refresh token', async () => {
    const { auth } = build([{ body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600 } }]);
    await assert.rejects(
      () => auth.exchangeCode('code'),
      (err: SpotifyError) => /refresh token/i.test(err.message),
    );
    assert.equal(auth.isConnected(), false);
  });

  it('reports a rejected code without storing anything', async () => {
    const { auth } = build([{ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid authorization code' } }]);
    await assert.rejects(() => auth.exchangeCode('stale'));
    assert.equal(auth.isConnected(), false);
  });
});

describe('getAccessToken', () => {
  it('refuses when nothing is connected', async () => {
    const { auth } = build([]);
    await assert.rejects(
      () => auth.getAccessToken(),
      (err: SpotifyError) => err.code === 'unauthorized' && /admin panel/.test(err.message),
    );
  });

  it('serves the cached token while it is still fresh', async () => {
    const { auth, callCount } = build([
      { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' } },
    ]);
    await auth.exchangeCode('code');
    await auth.getAccessToken();
    await auth.getAccessToken();
    assert.equal(callCount(), 1, 'a valid token must not cost a round trip');
  });

  it('refreshes ahead of expiry rather than letting a call fail', async () => {
    const { auth } = build([
      // Expires in 30s — inside the skew window, so the next read refreshes.
      { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 30, refresh_token: 'RT' } },
      { body: { access_token: 'AT2', token_type: 'Bearer', expires_in: 3600 } },
    ]);
    await auth.exchangeCode('code');
    assert.equal(await auth.getAccessToken(), 'AT2');
  });
});

describe('refresh', () => {
  it('keeps the old refresh token when Spotify does not rotate it', async () => {
    let lastBody = '';
    const { auth } = build(
      [
        { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' } },
        { body: { access_token: 'AT2', token_type: 'Bearer', expires_in: 3600 } },
        { body: { access_token: 'AT3', token_type: 'Bearer', expires_in: 3600 } },
      ],
      { onCall: (b) => (lastBody = b) },
    );

    await auth.exchangeCode('code');
    await auth.refresh();
    await auth.refresh();
    // Still the original — dropping it would strand the box permanently.
    assert.ok(lastBody.includes('refresh_token=RT'));
  });

  it('adopts a rotated refresh token when one is sent', async () => {
    let lastBody = '';
    const { auth } = build(
      [
        { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' } },
        { body: { access_token: 'AT2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT2' } },
        { body: { access_token: 'AT3', token_type: 'Bearer', expires_in: 3600 } },
      ],
      { onCall: (b) => (lastBody = b) },
    );

    await auth.exchangeCode('code');
    await auth.refresh();
    await auth.refresh();
    assert.ok(lastBody.includes('refresh_token=RT2'));
  });

  it('collapses concurrent refreshes into one round trip', async () => {
    const { auth, callCount } = build([
      { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' } },
      { body: { access_token: 'AT2', token_type: 'Bearer', expires_in: 3600 } },
    ]);
    await auth.exchangeCode('code');

    // Five callers hit a dead token at once — the poll loop plus four guests.
    const results = await Promise.all([
      auth.refresh(),
      auth.refresh(),
      auth.refresh(),
      auth.refresh(),
      auth.refresh(),
    ]);

    assert.deepEqual(results, ['AT2', 'AT2', 'AT2', 'AT2', 'AT2']);
    assert.equal(callCount(), 2, 'one exchange plus exactly one refresh');
  });

  it('allows a later refresh after an in-flight one settles', async () => {
    const { auth, callCount } = build([
      { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' } },
      { body: { access_token: 'AT2', token_type: 'Bearer', expires_in: 3600 } },
      { body: { access_token: 'AT3', token_type: 'Bearer', expires_in: 3600 } },
    ]);
    await auth.exchangeCode('code');
    assert.equal(await auth.refresh(), 'AT2');
    assert.equal(await auth.refresh(), 'AT3');
    assert.equal(callCount(), 3);
  });

  it('disconnects on invalid_grant, because only a human can fix it', async () => {
    const { auth } = build([
      { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' } },
      { status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token revoked' } },
    ]);
    await auth.exchangeCode('code');

    await assert.rejects(
      () => auth.refresh(),
      (err: SpotifyError) => err.code === 'unauthorized' && /econnect/.test(err.message),
    );
    assert.equal(auth.isConnected(), false, 'a revoked token must not linger as if usable');
  });

  it('keeps the connection on a transient failure', async () => {
    const { auth } = build([
      { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' } },
      { status: 503, body: { error: 'server_error' } },
    ]);
    await auth.exchangeCode('code');
    await assert.rejects(() => auth.refresh());
    assert.equal(auth.isConnected(), true, 'a 503 is not a revocation');
  });
});

describe('status', () => {
  it('reports nothing connected on a fresh database', () => {
    const { auth } = build([]);
    assert.deepEqual(auth.status(), {
      connected: false,
      accountName: null,
      scopes: [],
      expiresAt: null,
      missingScopes: [],
    });
  });

  it('names scopes granted at authorization time that we now need but lack', async () => {
    const { auth } = build([
      {
        body: {
          access_token: 'AT',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'RT',
          // An older authorization, from before playback control was added.
          scope: 'user-read-private',
        },
      },
    ]);
    await auth.exchangeCode('code');

    const status = auth.status();
    assert.equal(status.connected, true);
    assert.ok(status.missingScopes.includes('user-modify-playback-state'));
    assert.ok(!status.missingScopes.includes('user-read-private'));
  });

  it('records the account name for the status page', async () => {
    const { auth } = build([
      { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' } },
    ]);
    await auth.exchangeCode('code');
    auth.setAccountName('The Back Room');
    assert.equal(auth.status().accountName, 'The Back Room');
  });

  it('forgets everything on disconnect', async () => {
    const { auth } = build([
      { body: { access_token: 'AT', token_type: 'Bearer', expires_in: 3600, refresh_token: 'RT' } },
    ]);
    await auth.exchangeCode('code');
    auth.disconnect('test');
    assert.equal(auth.isConnected(), false);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM spotify_auth').get() as { n: number };
    assert.equal(remaining.n, 0, 'the refresh token must actually be gone from disk');
  });
});
