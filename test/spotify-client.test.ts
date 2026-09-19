/** Response normalization and the client's endpoint contracts. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SpotifyClient, playlistIdFromUri } from '../src/spotify/client.js';
import { SpotifyHttp, type FetchLike } from '../src/spotify/http.js';
import { formatDuration, toTrack, type SpotifyTrack } from '../src/spotify/types.js';
import { findDevice } from '../src/routes/admin/spotify.js';
import { applySearchFilters } from '../src/routes/search.js';
import { SpotifyError } from '../src/spotify/errors.js';
import { setLogLevel } from '../src/log.js';

setLogLevel('error');

function rawTrack(over: Partial<SpotifyTrack> = {}): SpotifyTrack {
  return {
    id: '4cOdK2wGLETKBW3PvgPWqT',
    uri: 'spotify:track:4cOdK2wGLETKBW3PvgPWqT',
    name: 'Never Gonna Give You Up',
    duration_ms: 213_573,
    explicit: false,
    artists: [{ id: '0gxyHStUsqpMadRV0Di1Qt', name: 'Rick Astley' }],
    album: {
      id: '6eUW0wxWtzkFdaEFsTJto6',
      name: 'Whenever You Need Somebody',
      images: [
        { url: 'https://i.scdn.co/640.jpg', width: 640, height: 640 },
        { url: 'https://i.scdn.co/300.jpg', width: 300, height: 300 },
        { url: 'https://i.scdn.co/64.jpg', width: 64, height: 64 },
      ],
    },
    ...over,
  };
}

/** A client whose transport replays one scripted response. */
function clientFor(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new SpotifyClient(
    new SpotifyHttp({
      fetchImpl,
      getAccessToken: async () => 'token',
      refreshAccessToken: async () => 'token',
      sleep: async () => {},
    }),
  );
  return { client, calls };
}

describe('toTrack', () => {
  it('flattens Spotify’s shape into ours', () => {
    const track = toTrack(rawTrack());
    assert.equal(track.name, 'Never Gonna Give You Up');
    assert.equal(track.artist, 'Rick Astley');
    assert.equal(track.album, 'Whenever You Need Somebody');
    assert.equal(track.durationMs, 213_573);
    assert.deepEqual(track.artistIds, ['0gxyHStUsqpMadRV0Di1Qt']);
  });

  it('joins collaborating artists', () => {
    const track = toTrack(
      rawTrack({ artists: [{ id: 'a', name: 'Flume' }, { id: 'b', name: 'Chet Faker' }] }),
    );
    assert.equal(track.artist, 'Flume, Chet Faker');
    assert.deepEqual(track.artistIds, ['a', 'b']);
  });

  it('picks the smallest art at least 160px, to spare venue Wi-Fi', () => {
    assert.equal(toTrack(rawTrack()).albumArtUrl, 'https://i.scdn.co/300.jpg');
  });

  it('falls back to the largest image when every option is tiny', () => {
    const track = toTrack(
      rawTrack({
        album: {
          id: 'x',
          name: 'EP',
          images: [{ url: 'https://i.scdn.co/64.jpg', width: 64, height: 64 }],
        },
      }),
    );
    assert.equal(track.albumArtUrl, 'https://i.scdn.co/64.jpg');
  });

  it('survives a track with no art at all', () => {
    const track = toTrack(rawTrack({ album: { id: null, name: 'Untitled', images: [] } }));
    assert.equal(track.albumArtUrl, null);
  });

  it('drops null artist ids from local files rather than storing them', () => {
    const track = toTrack(rawTrack({ artists: [{ id: null, name: 'Unknown' }] }));
    assert.deepEqual(track.artistIds, []);
    assert.equal(track.artist, 'Unknown');
  });

  it('names an artistless track rather than rendering an empty string', () => {
    assert.equal(toTrack(rawTrack({ artists: [] })).artist, 'Unknown artist');
  });
});

describe('formatDuration', () => {
  it('renders minutes and padded seconds', () => {
    assert.equal(formatDuration(213_573), '3:34');
    assert.equal(formatDuration(65_000), '1:05');
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(600_000), '10:00');
  });
});

describe('search', () => {
  it('normalizes results and asks for the configured market', async () => {
    const { client, calls } = clientFor({ tracks: { items: [rawTrack()], total: 1 } });
    const results = await client.search('rick astley', 'CA');

    assert.equal(results.length, 1);
    assert.equal(results[0]?.name, 'Never Gonna Give You Up');

    const url = new URL(calls[0]!.url);
    assert.equal(url.searchParams.get('market'), 'CA');
    assert.equal(url.searchParams.get('type'), 'track');
    assert.equal(url.searchParams.get('q'), 'rick astley');
  });

  it('drops nulls, which Spotify returns for unavailable items', async () => {
    const { client } = clientFor({ tracks: { items: [rawTrack(), null, rawTrack()], total: 3 } });
    assert.equal((await client.search('x', 'CA')).length, 2);
  });

  it('hides tracks that cannot play in this market', async () => {
    const { client } = clientFor({
      tracks: {
        items: [rawTrack({ is_playable: false }), rawTrack({ id: 'ok', is_playable: true })],
        total: 2,
      },
    });
    const results = await client.search('x', 'CA');
    assert.equal(results.length, 1, 'an unplayable track would queue and silently never play');
    assert.equal(results[0]?.id, 'ok');
  });

  it('keeps tracks that simply omit is_playable', async () => {
    const { client } = clientFor({ tracks: { items: [rawTrack()], total: 1 } });
    assert.equal((await client.search('x', 'CA')).length, 1);
  });

  it('short-circuits an empty query without calling Spotify', async () => {
    const { client, calls } = clientFor({ tracks: { items: [], total: 0 } });
    assert.deepEqual(await client.search('   ', 'CA'), []);
    assert.equal(calls.length, 0);
  });

  it('rejects a response missing the fields we depend on', async () => {
    const { client } = clientFor({ tracks: { items: [{ id: 'x', name: 'No uri here' }], total: 1 } });
    await assert.rejects(
      () => client.search('x', 'CA'),
      (err: SpotifyError) => err.code === 'malformed',
    );
  });
});

describe('getPlaybackState', () => {
  it('flattens a playing snapshot', async () => {
    const { client } = clientFor({
      device: { id: 'dev1', is_active: true, is_restricted: false, name: 'Jukebox', type: 'Speaker', volume_percent: 70 },
      repeat_state: 'context',
      shuffle_state: false,
      context: { uri: 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M', type: 'playlist' },
      progress_ms: 30_000,
      is_playing: true,
      item: rawTrack(),
    });

    const snapshot = await client.getPlaybackState();
    assert.equal(snapshot?.isPlaying, true);
    assert.equal(snapshot?.device?.name, 'Jukebox');
    assert.equal(snapshot?.contextUri, 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
    assert.equal(snapshot?.repeatState, 'context');
    assert.equal(snapshot?.track?.name, 'Never Gonna Give You Up');
    assert.equal(snapshot?.progressMs, 30_000);
  });

  it('reads 204 as "nothing is playing" rather than an error', async () => {
    const { client } = clientFor(null, 204);
    assert.equal(await client.getPlaybackState(), null);
  });

  it('handles a podcast episode, where item is null', async () => {
    const { client } = clientFor({
      device: null,
      repeat_state: 'off',
      shuffle_state: false,
      context: null,
      progress_ms: null,
      is_playing: false,
      item: null,
    });
    const snapshot = await client.getPlaybackState();
    assert.equal(snapshot?.track, null);
    assert.equal(snapshot?.contextUri, null);
  });
});

describe('playback commands', () => {
  it('queues by uri on the given device', async () => {
    const { client, calls } = clientFor(null, 204);
    await client.addToQueue('spotify:track:abc', 'dev1');

    const url = new URL(calls[0]!.url);
    assert.equal(calls[0]?.init.method, 'POST');
    assert.equal(url.pathname, '/v1/me/player/queue');
    assert.equal(url.searchParams.get('uri'), 'spotify:track:abc');
    assert.equal(url.searchParams.get('device_id'), 'dev1');
  });

  it('starts a context with an offset, so the playlist does not always open the same way', async () => {
    const { client, calls } = clientFor(null, 204);
    await client.playContext('spotify:playlist:abc', 'dev1', 17);

    assert.equal(calls[0]?.init.method, 'PUT');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      context_uri: 'spotify:playlist:abc',
      offset: { position: 17 },
    });
  });

  it('omits the offset when none is given', async () => {
    const { client, calls } = clientFor(null, 204);
    await client.playContext('spotify:playlist:abc', 'dev1');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { context_uri: 'spotify:playlist:abc' });
  });

  it('resumes without a body, so nothing reloads', async () => {
    const { client, calls } = clientFor(null, 204);
    await client.resume('dev1');
    assert.equal(calls[0]?.init.body, undefined);
  });

  it('clamps volume into range instead of letting Spotify reject it', async () => {
    for (const [input, expected] of [[150, '100'], [-10, '0'], [70.6, '71']] as const) {
      const { client, calls } = clientFor(null, 204);
      await client.setVolume(input, 'dev1');
      assert.equal(new URL(calls[0]!.url).searchParams.get('volume_percent'), expected);
    }
  });

  it('transfers playback and resumes by default', async () => {
    const { client, calls } = clientFor(null, 204);
    await client.transferPlayback('dev2');
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { device_ids: ['dev2'], play: true });
  });

  it('reports "no active device" when the player endpoint 404s', async () => {
    const { client } = clientFor({ error: { message: 'No active device found' } }, 404);
    await assert.rejects(
      () => client.skipToNext('dev1'),
      (err: SpotifyError) => err.code === 'no_active_device',
    );
  });
});

describe('playlistIdFromUri', () => {
  it('accepts the URI form', () => {
    assert.equal(
      playlistIdFromUri('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'),
      '37i9dQZF1DXcBWIGoYBM5M',
    );
  });

  it('accepts a pasted share link, with or without tracking parameters', () => {
    assert.equal(
      playlistIdFromUri('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123'),
      '37i9dQZF1DXcBWIGoYBM5M',
    );
  });

  it('accepts a bare id', () => {
    assert.equal(playlistIdFromUri('37i9dQZF1DXcBWIGoYBM5M'), '37i9dQZF1DXcBWIGoYBM5M');
  });

  it('rejects an album or track uri, which would fail confusingly later', () => {
    assert.equal(playlistIdFromUri('spotify:album:37i9dQZF1DXcBWIGoYBM5M'), null);
    assert.equal(playlistIdFromUri('spotify:track:37i9dQZF1DXcBWIGoYBM5M'), null);
    assert.equal(playlistIdFromUri('nonsense'), null);
  });
});

describe('findDevice', () => {
  const devices = [
    { id: 'a', is_active: false, is_restricted: false, name: 'Henry’s iPhone', type: 'Smartphone', volume_percent: 50 },
    { id: 'b', is_active: true, is_restricted: false, name: 'Jukebox', type: 'Speaker', volume_percent: 70 },
  ];

  it('matches the configured name', () => {
    assert.equal(findDevice(devices, 'Jukebox')?.id, 'b');
  });

  it('ignores case and surrounding whitespace, since the name is typed twice', () => {
    assert.equal(findDevice(devices, '  jukebox ')?.id, 'b');
  });

  it('returns null when librespot is not there', () => {
    assert.equal(findDevice(devices, 'Back Bar'), null);
    assert.equal(findDevice([], 'Jukebox'), null);
  });
});

describe('applySearchFilters', () => {
  const clean = toTrack(rawTrack({ id: 'clean', explicit: false, duration_ms: 200_000 }));
  const explicit = toTrack(rawTrack({ id: 'explicit', explicit: true, duration_ms: 200_000 }));
  const epic = toTrack(rawTrack({ id: 'epic', explicit: false, duration_ms: 1_200_000 }));

  it('passes everything through when filters are off', () => {
    const out = applySearchFilters([clean, explicit, epic], {
      explicitFilter: false,
      maxDurationMs: 3_600_000,
    });
    assert.equal(out.length, 3);
  });

  it('hides explicit tracks when asked', () => {
    const out = applySearchFilters([clean, explicit], { explicitFilter: true, maxDurationMs: 3_600_000 });
    assert.deepEqual(out.map((t) => t.id), ['clean']);
  });

  it('hides anything over the length limit', () => {
    const out = applySearchFilters([clean, epic], { explicitFilter: false, maxDurationMs: 600_000 });
    assert.deepEqual(out.map((t) => t.id), ['clean']);
  });

  it('keeps a track exactly at the limit', () => {
    const exact = toTrack(rawTrack({ duration_ms: 600_000 }));
    assert.equal(
      applySearchFilters([exact], { explicitFilter: false, maxDurationMs: 600_000 }).length,
      1,
    );
  });
});
