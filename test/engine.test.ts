/**
 * The engine loop: does it carry out the reconciler's decisions, and does it
 * survive the ways Spotify fails? The client is a spy; no network, no timers.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '../src/db/index.js';
import { EventLog } from '../src/db/events.js';
import { SettingsStore } from '../src/config/settings.js';
import { QueueRepository } from '../src/queue/repository.js';
import { PlaybackEngine } from '../src/engine/loop.js';
import { SpotifyError } from '../src/spotify/errors.js';
import type { SpotifyClient, PlayerSnapshot } from '../src/spotify/client.js';
import type { SpotifyAuth } from '../src/spotify/auth.js';
import type { SpotifyDevice, Track } from '../src/spotify/types.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

const FALLBACK = 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M';

const ourDevice: SpotifyDevice = {
  id: 'librespot-1',
  is_active: true,
  is_restricted: false,
  name: 'Jukebox',
  type: 'Speaker',
  volume_percent: 70,
};

function track(over: Partial<Track> = {}): Track {
  return {
    id: 'fallback1',
    uri: 'spotify:track:fallback1',
    name: 'Something From The Playlist',
    artist: 'A Band',
    album: 'An Album',
    albumArtUrl: null,
    durationMs: 300_000,
    explicit: false,
    artistIds: ['a1'],
    ...over,
  };
}

interface Call {
  method: string;
  args: unknown[];
}

/** A SpotifyClient stand-in that records calls and can be told to fail. */
function spyClient(opts: {
  playback?: PlayerSnapshot | null;
  devices?: SpotifyDevice[];
  failures?: Partial<Record<string, Error>>;
} = {}) {
  const calls: Call[] = [];
  const failures = opts.failures ?? {};

  const record = async (method: string, ...args: unknown[]): Promise<void> => {
    calls.push({ method, args });
    const failure = failures[method];
    if (failure) throw failure;
  };

  const client = {
    getPlaybackState: async () => {
      calls.push({ method: 'getPlaybackState', args: [] });
      if (failures['getPlaybackState']) throw failures['getPlaybackState'];
      return opts.playback === undefined ? null : opts.playback;
    },
    getDevices: async () => {
      calls.push({ method: 'getDevices', args: [] });
      if (failures['getDevices']) throw failures['getDevices'];
      return opts.devices ?? [ourDevice];
    },
    getPlaylist: async (id: string) => {
      calls.push({ method: 'getPlaylist', args: [id] });
      if (failures['getPlaylist']) throw failures['getPlaylist'];
      return { id, name: 'Late Night Bar', trackCount: 148 };
    },
    addToQueue: (uri: string, deviceId?: string) => record('addToQueue', uri, deviceId),
    skipToNext: (deviceId?: string) => record('skipToNext', deviceId),
    playContext: (uri: string, deviceId?: string, offset?: number) =>
      record('playContext', uri, deviceId, offset),
    resume: (deviceId?: string) => record('resume', deviceId),
    pause: (deviceId?: string) => record('pause', deviceId),
    transferPlayback: (deviceId: string, play?: boolean) =>
      record('transferPlayback', deviceId, play),
    setRepeat: (state: string, deviceId?: string) => record('setRepeat', state, deviceId),
    setShuffle: (state: boolean, deviceId?: string) => record('setShuffle', state, deviceId),
    setVolume: (percent: number, deviceId?: string) => record('setVolume', percent, deviceId),
  } as unknown as SpotifyClient;

  return {
    client,
    calls,
    methods: () => calls.map((c) => c.method),
    find: (method: string) => calls.find((c) => c.method === method),
    count: (method: string) => calls.filter((c) => c.method === method).length,
  };
}

const connectedAuth = { isConnected: () => true } as unknown as SpotifyAuth;
const disconnectedAuth = { isConnected: () => false } as unknown as SpotifyAuth;

let dir: string;
let db: Db;
let queue: QueueRepository;
let settings: SettingsStore;
let events: EventLog;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'jukebox-engine-'));
  db = openDatabase(join(dir, 'engine.db'));
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // Events reference requests, so they go first.
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM requests').run();
  db.prepare('DELETE FROM settings').run();
  queue = new QueueRepository(db);
  settings = new SettingsStore(db);
  events = new EventLog(db);
  settings.update({ fallback_playlist_uri: FALLBACK, device_name: 'Jukebox' });
  // The shipped default is empty; these tests are about a configured box.
});

function engineWith(spy: ReturnType<typeof spyClient>, auth = connectedAuth): PlaybackEngine {
  return new PlaybackEngine({
    spotify: spy.client,
    auth,
    queue,
    settings,
    events,
    random: () => 0.5,
  });
}

function enqueue(n: number, over: Record<string, unknown> = {}): number {
  return queue.enqueue({
    track: track({ id: `req${n}`, uri: `spotify:track:req${n}`, name: `Request ${n}` }),
    sessionId: 'sess-a',
    ipHash: 'hash',
    state: 'queued',
    amountCents: 0,
    currency: 'CAD',
    ...over,
  });
}

describe('engine tick', () => {
  it('does nothing at all when Spotify is not connected', async () => {
    const spy = spyClient();
    await engineWith(spy, disconnectedAuth).tick();
    assert.deepEqual(spy.calls, [], 'an unconfigured box must not poll');
  });

  it('starts the fallback playlist when nothing is playing', async () => {
    const spy = spyClient({ playback: null });
    const engine = engineWith(spy);
    // One reading of dead air is not enough: Spotify reports paused or 204
    // between tracks. The engine waits for it to persist.
    await engine.tick();
    assert.equal(spy.find('playContext'), undefined, 'must not act on a single reading');
    await engine.tick();

    const play = spy.find('playContext');
    assert.equal(play?.args[0], FALLBACK);
    assert.equal(play?.args[1], 'librespot-1');

    // Both must follow playback: Spotify ignores them on a device that is not
    // yet playing anything.
    assert.ok(spy.methods().indexOf('setRepeat') > spy.methods().indexOf('playContext'));
    assert.ok(spy.methods().indexOf('setShuffle') > spy.methods().indexOf('playContext'));
    assert.equal(spy.find('setRepeat')?.args[0], 'context');
    assert.equal(spy.find('setShuffle')?.args[0], true, 'shuffle is what varies the opening song');
  });

  it('waits quietly when librespot is missing', async () => {
    const spy = spyClient({ playback: null, devices: [] });
    await engineWith(spy).tick();
    assert.equal(spy.find('playContext'), undefined);
    assert.equal(spy.find('transferPlayback'), undefined);
  });

  it('hands a request to Spotify as the current track ends', async () => {
    const id = enqueue(1);
    const spy = spyClient({
      playback: {
        device: ourDevice,
        isPlaying: true,
        progressMs: 295_000,
        repeatState: 'context',
        contextUri: FALLBACK,
        track: track(),
      },
    });

    await engineWith(spy).tick();

    assert.equal(spy.find('addToQueue')?.args[0], 'spotify:track:req1');
    assert.ok(queue.byId(id)?.pushed_at, 'the hand-off must be recorded');
    assert.equal(queue.byId(id)?.state, 'queued', 'handed over is not yet playing');
  });

  it('marks a request playing once it is audible, and logs it', async () => {
    const id = enqueue(1);
    queue.markPushed(id);
    const spy = spyClient({
      playback: {
        device: ourDevice,
        isPlaying: true,
        progressMs: 5_000,
        repeatState: 'context',
        contextUri: FALLBACK,
        track: track({ uri: 'spotify:track:req1' }),
      },
    });

    await engineWith(spy).tick();

    assert.equal(queue.byId(id)?.state, 'playing');
    assert.ok(events.recent().some((e) => e.kind === 'request_started' && e.request_id === id));
  });

  it('completes a request when the next track begins', async () => {
    const id = enqueue(1);
    queue.markPushed(id);
    queue.markPlaying(id);

    const spy = spyClient({
      playback: {
        device: ourDevice,
        isPlaying: true,
        progressMs: 1_000,
        repeatState: 'context',
        contextUri: FALLBACK,
        track: track(),
      },
    });

    await engineWith(spy).tick();
    assert.equal(queue.byId(id)?.state, 'played');
    assert.ok(events.recent().some((e) => e.kind === 'request_played'));
  });

  it('retargets playback when librespot comes back under a new id', async () => {
    const spy = spyClient({
      devices: [{ ...ourDevice, id: 'librespot-2', is_active: false }],
      playback: {
        device: { ...ourDevice, id: 'phone', name: "Henry's iPhone", is_active: true },
        isPlaying: true,
        progressMs: 1_000,
        repeatState: 'context',
        contextUri: FALLBACK,
        track: track(),
      },
    });

    await engineWith(spy).tick();
    assert.equal(spy.find('transferPlayback')?.args[0], 'librespot-2');
  });
});

describe('failure handling', () => {
  it('survives a failed poll and records nothing', async () => {
    const spy = spyClient({ failures: { getPlaybackState: new SpotifyError('server', 'boom') } });
    await engineWith(spy).tick(); // must not throw
    assert.equal(queue.listQueued().length, 0);
  });

  it('retries a hand-off that failed transiently', async () => {
    const id = enqueue(1);
    const spy = spyClient({
      playback: {
        device: ourDevice,
        isPlaying: true,
        progressMs: 295_000,
        repeatState: 'context',
        contextUri: FALLBACK,
        track: track(),
      },
      failures: { addToQueue: new SpotifyError('rate_limited', 'slow down') },
    });

    await engineWith(spy).tick();

    const row = queue.byId(id);
    assert.equal(row?.pushed_at, null, 'a failed hand-off must not look successful');
    assert.equal(row?.state, 'queued', 'and the request must stay in the queue');
  });

  it('fails a request Spotify permanently refuses', async () => {
    const id = enqueue(1);
    const spy = spyClient({
      playback: {
        device: ourDevice,
        isPlaying: true,
        progressMs: 295_000,
        repeatState: 'context',
        contextUri: FALLBACK,
        track: track(),
      },
      failures: { addToQueue: new SpotifyError('bad_request', 'Invalid track uri') },
    });

    await engineWith(spy).tick();

    assert.equal(queue.byId(id)?.state, 'failed', 'retrying a rejected uri forever would wedge the queue');
    assert.match(queue.byId(id)?.failure_reason ?? '', /Invalid track uri/);
  });

  it('keeps a request queued when the device vanishes mid-hand-off', async () => {
    const id = enqueue(1);
    const spy = spyClient({
      playback: {
        device: ourDevice,
        isPlaying: true,
        progressMs: 295_000,
        repeatState: 'context',
        contextUri: FALLBACK,
        track: track(),
      },
      failures: { addToQueue: new SpotifyError('no_active_device', 'No active device found') },
    });

    await engineWith(spy).tick();
    assert.equal(queue.byId(id)?.state, 'queued', 'librespot restarting must not lose the request');
  });

  it('starts the fallback even when shuffle and repeat are refused', async () => {
    // The music being on matters more than the two settings that decorate it.
    const spy = spyClient({
      playback: null,
      failures: {
        setShuffle: new SpotifyError('server', 'boom'),
        setRepeat: new SpotifyError('server', 'boom'),
      },
    });
    const engine = engineWith(spy);
    await engine.tick();
    await engine.tick(); // must not throw
    assert.equal(spy.find('playContext')?.args[0], FALLBACK);
  });

  it('does not overlap ticks', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let polls = 0;

    const client = {
      getPlaybackState: async () => {
        polls++;
        await gate;
        return null;
      },
      getDevices: async () => [ourDevice],
      getPlaylist: async () => ({ id: 'x', name: 'x', trackCount: 10 }),
      playContext: async () => {},
      setRepeat: async () => {},
    } as unknown as SpotifyClient;

    const engine = new PlaybackEngine({ spotify: client, auth: connectedAuth, queue, settings, events });

    const first = engine.tick();
    await engine.tick(); // arrives while the first is still in flight
    release();
    await first;

    assert.equal(polls, 1, 'a slow Spotify must not let ticks stack up');
  });

  it('counts consecutive failures and widens the tick interval', async () => {
    const spy = spyClient({ failures: { getPlaybackState: new SpotifyError('network', 'unreachable') } });
    const engine = engineWith(spy);

    assert.equal(engine.stats().consecutiveFailures, 0);

    await engine.tick();
    assert.equal(engine.stats().backingOff, false, 'one blip is not an outage');

    await engine.tick();
    await engine.tick();

    const stats = engine.stats();
    assert.equal(stats.consecutiveFailures, 3);
    assert.equal(stats.backingOff, true, 'stop hammering an API that is not answering');
    assert.ok(stats.tickMs > 3_000);
  });

  it('returns to the normal interval as soon as a tick succeeds', async () => {
    const failing = new SpotifyError('network', 'unreachable');
    const failures: Record<string, Error> = { getPlaybackState: failing };
    const spy = spyClient({ playback: null, failures });
    const engine = engineWith(spy);

    await engine.tick();
    await engine.tick();
    await engine.tick();
    assert.equal(engine.stats().backingOff, true);

    delete failures['getPlaybackState']; // Spotify comes back
    await engine.tick();
    await engine.tick(); // dead air must persist before it takes over

    assert.equal(engine.stats().consecutiveFailures, 0);
    assert.equal(engine.stats().backingOff, false);
    assert.ok(spy.find('playContext'), 'and it picks the music back up');
  });

  it('never reads the playlist during a tick', async () => {
    // The API exposes no track count, so the engine has no reason to ask —
    // shuffle replaced the random start offset that used to need one.
    const spy = spyClient({ playback: null });
    const engine = engineWith(spy);
    await engine.tick();
    await engine.tick();
    assert.equal(spy.count('getPlaylist'), 0);
  });
});

describe('rate limiting', () => {
  it('stops calling Spotify entirely once it is rate limited', async () => {
    const limited = new SpotifyError('rate_limited', 'slow down', { retryAfterMs: 90_000 });
    const spy = spyClient({ failures: { getPlaybackState: limited } });
    const engine = engineWith(spy);

    await engine.tick();
    const callsAfterFirst = spy.calls.length;

    await engine.tick();
    await engine.tick();
    await engine.tick();

    assert.equal(
      spy.calls.length,
      callsAfterFirst,
      'knocking again is what turns a short penalty into a long one',
    );
  });

  it('reports how long it is sitting out', async () => {
    const limited = new SpotifyError('rate_limited', 'slow down', { retryAfterMs: 120_000 });
    const spy = spyClient({ failures: { getPlaybackState: limited } });
    const engine = engineWith(spy);

    await engine.tick();

    const stats = engine.stats();
    assert.ok(stats.rateLimitedForMs > 100_000, 'so the status page can say why');
  });

  it('waits at least a minute even when Spotify does not say how long', async () => {
    const limited = new SpotifyError('rate_limited', 'slow down');
    const spy = spyClient({ failures: { getPlaybackState: limited } });
    const engine = engineWith(spy);

    await engine.tick();
    assert.ok(engine.stats().rateLimitedForMs >= 59_000);
  });
});

describe('call rate', () => {
  it('does not re-read the device list on every tick', async () => {
    // Two calls per three-second tick was enough, with a second instance
    // running, to exhaust the account's Spotify rate limit.
    const spy = spyClient({
      playback: {
        device: ourDevice,
        isPlaying: true,
        progressMs: 1_000,
        repeatState: 'context',
        contextUri: FALLBACK,
        track: track(),
      },
    });
    const engine = engineWith(spy);

    await engine.tick();
    await engine.tick();
    await engine.tick();

    assert.equal(spy.count('getDevices'), 1, 'the device list barely changes');
    assert.equal(spy.count('getPlaybackState'), 3, 'playback state still every tick');
  });

  it('re-reads the device list at once when our device is missing', async () => {
    // librespot restarting changes the device id; waiting for the cache to
    // expire would be that many seconds of silence.
    const spy = spyClient({ devices: [], playback: null });
    const engine = engineWith(spy);

    await engine.tick();
    await engine.tick();

    assert.equal(spy.count('getDevices'), 2, 'a missing device must not be cached');
  });
});
