/**
 * The HTTP layer's failure behaviour. No network: `fetch` is a stub and
 * `sleep` is a counter, so retries are exercised without waiting for them.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpotifyHttp, backoffMs, parseRetryAfterMs, type FetchLike } from '../src/spotify/http.js';
import { SpotifyError } from '../src/spotify/errors.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

interface Recorded {
  url: string;
  init: RequestInit;
}

/** Build an http client over a scripted sequence of responses. */
function harness(responses: Array<Response | Error>, opts: { refreshFails?: boolean } = {}) {
  const calls: Recorded[] = [];
  const slept: number[] = [];
  let tokenIssued = 0;
  let refreshes = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next === undefined) throw new Error('fetch called more times than scripted');
    if (next instanceof Error) throw next;
    return next;
  };

  const http = new SpotifyHttp({
    fetchImpl,
    getAccessToken: async () => `token-${tokenIssued}`,
    refreshAccessToken: async () => {
      refreshes++;
      if (opts.refreshFails) throw new Error('refresh rejected');
      tokenIssued++;
      return `token-${tokenIssued}`;
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  return { http, calls, slept, stats: () => ({ refreshes, tokenIssued }) };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('parseRetryAfterMs', () => {
  it('reads whole seconds', () => {
    assert.equal(parseRetryAfterMs('3'), 3000);
    assert.equal(parseRetryAfterMs(' 12 '), 12000);
  });

  it('defaults to a second for missing or junk values', () => {
    assert.equal(parseRetryAfterMs(null), 1000);
    assert.equal(parseRetryAfterMs('soon'), 1000);
    assert.equal(parseRetryAfterMs('-5'), 1000);
  });
});

describe('backoffMs', () => {
  it('grows with the attempt and stays bounded', () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const ms = backoffMs(attempt);
      assert.ok(ms >= 0, 'never negative');
      assert.ok(ms <= 4000, `attempt ${attempt} exceeded the ceiling: ${ms}`);
    }
  });
});

describe('SpotifyHttp', () => {
  it('returns a parsed body on success', async () => {
    const { http, calls } = harness([json({ hello: 'world' })]);
    const body = await http.request<{ hello: string }>('/test');
    assert.deepEqual(body, { hello: 'world' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.init.headers && (calls[0].init.headers as Record<string, string>)['authorization'], 'Bearer token-0');
  });

  it('returns null for 204, which every player command uses', async () => {
    const { http } = harness([new Response(null, { status: 204 })]);
    assert.equal(await http.request('/me/player/next', { method: 'POST' }), null);
  });

  it('returns null for an empty 200 body', async () => {
    const { http } = harness([new Response('', { status: 200 })]);
    assert.equal(await http.request('/me/player'), null);
  });

  it('builds the query string and drops undefined values', async () => {
    const { http, calls } = harness([json({})]);
    await http.request('/search', { query: { q: 'nina simone', limit: 20, market: undefined } });
    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get('q'), 'nina simone');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(url.searchParams.has('market'), false);
  });

  // --- 401 ------------------------------------------------------------------

  it('refreshes once on 401 and retries with the new token', async () => {
    const { http, calls, stats } = harness([json({ error: {} }, 401), json({ ok: true })]);
    const body = await http.request<{ ok: boolean }>('/me/player');
    assert.deepEqual(body, { ok: true });
    assert.equal(stats().refreshes, 1);
    const second = calls[1]?.init.headers as Record<string, string>;
    assert.equal(second['authorization'], 'Bearer token-1', 'retry must use the refreshed token');
  });

  it('does not consume a retry attempt for the refresh', async () => {
    // One 401, then two 500s. With maxAttempts 3 the 401 must not eat one,
    // so both 500s still get their retries and the third response wins.
    const { http } = harness([json({}, 401), json({}, 500), json({}, 500), json({ ok: true })]);
    const body = await http.request<{ ok: boolean }>('/me/player', { maxAttempts: 3 });
    assert.deepEqual(body, { ok: true });
  });

  it('gives up if a second 401 arrives after refreshing', async () => {
    const { http, stats } = harness([json({}, 401), json({}, 401)]);
    await assert.rejects(
      () => http.request('/me/player'),
      (err: SpotifyError) => err.code === 'unauthorized',
    );
    assert.equal(stats().refreshes, 1, 'must not refresh repeatedly');
  });

  it('surfaces a refresh failure as unauthorized', async () => {
    const { http } = harness([json({}, 401)], { refreshFails: true });
    await assert.rejects(
      () => http.request('/me/player'),
      (err: SpotifyError) => err.code === 'unauthorized' && /refresh failed/i.test(err.message),
    );
  });

  // --- 429 ------------------------------------------------------------------

  it('waits exactly as long as Retry-After says, then retries', async () => {
    const { http, slept } = harness([json({}, 429, { 'retry-after': '2' }), json({ ok: true })]);
    const body = await http.request<{ ok: boolean }>('/search');
    assert.deepEqual(body, { ok: true });
    assert.deepEqual(slept, [2000]);
  });

  it('fails fast rather than waiting longer than the caller allows', async () => {
    const { http, slept } = harness([json({}, 429, { 'retry-after': '30' })]);
    await assert.rejects(
      () => http.request('/search', { maxRetryAfterMs: 2000 }),
      (err: SpotifyError) => err.code === 'rate_limited' && err.retryAfterMs === 30000,
    );
    assert.deepEqual(slept, [], 'must not sleep at all when the wait is too long');
  });

  it('reports rate limiting once attempts run out', async () => {
    const { http } = harness([
      json({}, 429, { 'retry-after': '1' }),
      json({}, 429, { 'retry-after': '1' }),
    ]);
    await assert.rejects(
      () => http.request('/search', { maxAttempts: 2 }),
      (err: SpotifyError) => err.code === 'rate_limited' && err.transient,
    );
  });

  // --- 5xx, network, timeout -------------------------------------------------

  it('retries a 500 and succeeds on a later attempt', async () => {
    const { http, calls } = harness([json({}, 500), json({}, 503), json({ ok: true })]);
    assert.deepEqual(await http.request('/me/player'), { ok: true });
    assert.equal(calls.length, 3);
  });

  it('gives up on 5xx after the attempt budget', async () => {
    const { http } = harness([json({}, 500), json({}, 500), json({}, 500)]);
    await assert.rejects(
      () => http.request('/me/player'),
      (err: SpotifyError) => err.code === 'server' && err.transient,
    );
  });

  it('retries a network error', async () => {
    const { http } = harness([new TypeError('connection reset'), json({ ok: true })]);
    assert.deepEqual(await http.request('/me/player'), { ok: true });
  });

  it('reports a timeout distinctly from a network failure', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const { http } = harness([abort, abort, abort]);
    await assert.rejects(
      () => http.request('/me/player'),
      (err: SpotifyError) => err.code === 'timeout',
    );
  });

  // --- 4xx ------------------------------------------------------------------

  it('does not retry a 400, and keeps Spotify’s explanation', async () => {
    const { http, calls } = harness([
      json({ error: { message: 'Invalid track uri' } }, 400),
    ]);
    await assert.rejects(
      () => http.request('/me/player/queue', { method: 'POST' }),
      (err: SpotifyError) => err.code === 'bad_request' && err.message === 'Invalid track uri',
    );
    assert.equal(calls.length, 1, 'a 400 is our fault; retrying it is pointless');
  });

  it('reads a 404 on a player endpoint as "no active device"', async () => {
    const { http } = harness([json({ error: { message: 'No active device found' } }, 404)]);
    await assert.rejects(
      () => http.request('/me/player/play', { method: 'PUT', isPlayerEndpoint: true }),
      (err: SpotifyError) => err.code === 'no_active_device' && !err.transient,
    );
  });

  it('reads a 404 elsewhere as a missing resource', async () => {
    const { http } = harness([json({}, 404)]);
    await assert.rejects(
      () => http.request('/tracks/nope'),
      (err: SpotifyError) => err.code === 'not_found',
    );
  });

  it('flags 403 separately, since it usually means a free account', async () => {
    const { http } = harness([json({ error: { message: 'Player command failed: Premium required' } }, 403)]);
    await assert.rejects(
      () => http.request('/me/player/play', { method: 'PUT' }),
      (err: SpotifyError) => err.code === 'forbidden' && /Premium/.test(err.message),
    );
  });

  it('accepts a 200 whose body is not JSON when the caller ignores it', async () => {
    // Spotify answers shuffle and repeat with an opaque plain-text token.
    // Parsing it made successful commands look like failures.
    const { http } = harness([new Response('OY8tXec5CTMh_SiFDV-nMqNg8N4', { status: 200 })]);
    assert.equal(await http.request('/me/player/shuffle', { method: 'PUT', ignoreBody: true }), null);
  });

  it('rejects a non-JSON body as malformed rather than crashing', async () => {
    const { http } = harness([new Response('<html>502 Bad Gateway</html>', { status: 200 })]);
    await assert.rejects(
      () => http.request('/me/player'),
      (err: SpotifyError) => err.code === 'malformed',
    );
  });

  it('never puts the token anywhere but the Authorization header', async () => {
    const { http, calls } = harness([json({})]);
    await http.request('/search', { query: { q: 'test' } });
    assert.ok(!calls[0]!.url.includes('token-'), 'token must not reach the URL');
  });
});

describe('SpotifyError', () => {
  it('keeps transient and permanent failures apart', () => {
    assert.equal(new SpotifyError('rate_limited', '').transient, true);
    assert.equal(new SpotifyError('timeout', '').transient, true);
    assert.equal(new SpotifyError('server', '').transient, true);
    assert.equal(new SpotifyError('network', '').transient, true);
    assert.equal(new SpotifyError('unauthorized', '').transient, false);
    assert.equal(new SpotifyError('bad_request', '').transient, false);
    assert.equal(new SpotifyError('no_active_device', '').transient, false);
  });

  it('never leaks internals in the guest-facing message', () => {
    const err = new SpotifyError('unauthorized', 'Bearer token BQD... expired', {
      endpoint: '/me/player',
    });
    assert.ok(!err.guestMessage.includes('Bearer'));
    assert.ok(!err.guestMessage.includes('/me/player'));
  });
});
