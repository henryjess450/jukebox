/** The status page: what an operator stares at when the music has stopped. */
import { html, type SafeHtml } from '../../http/html.js';
import { notice, page } from '../../http/layout.js';
import type { ConnectionStatus } from '../../spotify/auth.js';
import type { PlayerSnapshot } from '../../spotify/client.js';
import type { SpotifyDevice, UserProfile } from '../../spotify/types.js';
import { formatDuration } from '../../spotify/types.js';

export interface StatusView {
  auth: ConnectionStatus;
  csrf: string;
  deviceName: string;
  devices: SpotifyDevice[] | null;
  matchedDevice: SpotifyDevice | null;
  playback: PlayerSnapshot | null;
  playlist: { id: string; name: string } | null;
  account: UserProfile | null;
  errors: string[];
  flashError?: string;
  justConnected: boolean;
}

function check(ok: boolean, label: string, detail: SafeHtml | string): SafeHtml {
  return html`
    <li class="check ${ok ? 'check--ok' : 'check--bad'}">
      <span class="check__mark" aria-hidden="true">${ok ? '●' : '○'}</span>
      <span class="check__body">
        <strong>${label}</strong>
        <span class="check__detail">${detail}</span>
      </span>
    </li>
  `;
}

export function statusPage(view: StatusView): string {
  const {
    auth,
    csrf,
    deviceName,
    devices,
    matchedDevice,
    playback,
    playlist,
    account,
    errors,
    flashError,
    justConnected,
  } = view;

  const premiumKnown = account?.product !== undefined;
  const isPremium = account?.product === 'premium';

  return page({
    title: 'Status — Jukebox admin',
    bodyClass: 'page-admin',
    // Every reload costs four Spotify calls. Fifteen seconds was enough, left
    // open on a second screen, to help exhaust the account's rate limit.
    head: html`<meta http-equiv="refresh" content="60" />`,
    body: html`
      <header class="admin-header">
        <h1>Jukebox admin</h1>
        <nav class="admin-nav">
          <a href="/admin">Settings</a>
          <a href="/admin/queue">Queue</a>
          <a href="/status" class="is-current">Status</a>
          <form method="post" action="/admin/logout" class="inline">
            <input type="hidden" name="csrf" value="${csrf}" />
            <button type="submit" class="btn btn--quiet">Sign out</button>
          </form>
        </nav>
      </header>

      <main class="admin-main">
        ${justConnected ? notice('ok', 'Spotify connected.') : ''}
        ${flashError ? notice('error', flashError) : ''}
        ${errors.map((e) => notice('error', e))}

        ${!auth.connected
          ? html`
              <section class="card">
                <h2>Connect Spotify</h2>
                <p>
                  The jukebox needs a Spotify <strong>Premium</strong> account to control playback.
                  You authorize once; the connection then survives restarts on its own.
                </p>
                <p class="hint">
                  Before this will work, the redirect URI registered on your Spotify app must exactly
                  match this box's public URL followed by
                  <code>/admin/spotify/callback</code>.
                </p>
                <p><a class="btn btn--primary" href="/admin/spotify/connect">Connect Spotify</a></p>
              </section>
            `
          : html`
              <section class="card">
                <h2>Checks</h2>
                <ul class="checks">
                  ${check(
                    true,
                    'Authorized',
                    html`as <strong>${auth.accountName ?? 'unknown account'}</strong>`,
                  )}
                  ${check(
                    !premiumKnown || isPremium,
                    'Premium',
                    premiumKnown
                      ? isPremium
                        ? 'yes — playback control is available'
                        : html`<strong>${account?.product}</strong> — playback control will not work`
                      : 'could not read the account plan',
                  )}
                  ${check(
                    auth.missingScopes.length === 0,
                    'Permissions',
                    auth.missingScopes.length === 0
                      ? 'all required scopes granted'
                      : html`missing <code>${auth.missingScopes.join(', ')}</code> — reconnect to fix`,
                  )}
                  ${check(
                    matchedDevice !== null,
                    'Connect device',
                    matchedDevice
                      ? html`<strong>${matchedDevice.name}</strong> is visible${matchedDevice.is_active
                            ? ' and active'
                            : ' but not active'}`
                      : html`no device named <code>${deviceName}</code> — is librespot running, and has
                          the device been claimed once from a Spotify app on this network?`,
                  )}
                  ${check(
                    playlist !== null,
                    'Fallback playlist',
                    playlist
                      ? html`<strong>${playlist.name}</strong>`
                      : html`not set, or not readable. It must be a playlist your own account
                          owns or follows — Spotify no longer lets apps read its editorial
                          playlists such as Today&rsquo;s Top Hits.`,
                  )}
                </ul>
              </section>

              <section class="card">
                <h2>Playing now</h2>
                ${playback === null || playback.track === null
                  ? html`<p class="hint">Nothing is playing.</p>`
                  : html`
                      <div class="now">
                        ${playback.track.albumArtUrl
                          ? html`<img
                              class="now__art"
                              src="${playback.track.albumArtUrl}"
                              alt=""
                              width="64"
                              height="64"
                            />`
                          : ''}
                        <div class="now__text">
                          <strong>${playback.track.name}</strong>
                          <span class="hint">${playback.track.artist}</span>
                          <span class="hint">
                            ${playback.isPlaying ? 'playing' : 'paused'} ·
                            ${formatDuration(playback.progressMs ?? 0)} /
                            ${formatDuration(playback.track.durationMs)}
                            · repeat ${playback.repeatState}
                          </span>
                        </div>
                      </div>
                    `}
              </section>

              <section class="card">
                <h2>Devices Spotify can see</h2>
                ${devices === null
                  ? html`<p class="hint">Could not read the device list.</p>`
                  : devices.length === 0
                    ? html`<p class="hint">
                        None. librespot is not running, or has never been claimed from a Spotify
                        client on this network.
                      </p>`
                    : html`
                        <ul class="devices">
                          ${devices.map(
                            (d) => html`
                              <li>
                                <strong>${d.name}</strong>
                                <span class="hint">
                                  ${d.type}${d.is_active ? ' · active' : ''}${d.is_restricted
                                    ? ' · restricted'
                                    : ''}${d.volume_percent !== null
                                    ? ` · volume ${String(d.volume_percent)}%`
                                    : ''}
                                </span>
                              </li>
                            `,
                          )}
                        </ul>
                      `}
              </section>

              <section class="card">
                <h2>Connection</h2>
                <p class="hint">
                  Access token renews itself; the saved authorization does not expire unless it is
                  revoked from your Spotify account page.
                </p>
                <form method="post" action="/admin/spotify/disconnect">
                  <input type="hidden" name="csrf" value="${csrf}" />
                  <button type="submit" class="btn">Disconnect Spotify</button>
                </form>
              </section>
            `}
      </main>
    `,
  });
}
