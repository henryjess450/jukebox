/** Admin queue management: what is playing, what is next, and the log. */
import { asset } from '../../http/assets.js';
import { html, type SafeHtml } from '../../http/html.js';
import { notice, page } from '../../http/layout.js';
import { formatMoney, type Currency, type Settings } from '../../config/settings.js';
import type { RequestRow } from '../../queue/repository.js';
import type { BlocklistEntry } from '../../queue/blocklist.js';
import { formatDuration } from '../../spotify/types.js';

export interface QueuePageOptions {
  settings: Readonly<Settings>;
  csrf: string;
  playing: RequestRow | null;
  queue: RequestRow[];
  /** What the player reports, for when the fallback playlist is on. */
  fallbackTrack: { name: string; artist: string } | null;
  isPlaying: boolean;
  recent: RequestRow[];
  blocklist: BlocklistEntry[];
  flash?: { tone: 'ok' | 'error' | 'info'; message: string };
  engine: { running: boolean; consecutiveFailures: number; backingOff: boolean };
}

function action(
  csrf: string,
  path: string,
  label: string,
  opts: { danger?: boolean; fields?: Record<string, string>; confirm?: string } = {},
): SafeHtml {
  return html`
    <form method="post" action="${path}" class="inline-form">
      <input type="hidden" name="csrf" value="${csrf}" />
      ${Object.entries(opts.fields ?? {}).map(
        ([k, v]) => html`<input type="hidden" name="${k}" value="${v}" />`,
      )}
      <button
        type="submit"
        class="btn btn--small ${opts.danger ? 'btn--danger' : ''}"
        ${opts.confirm ? html`data-confirm="${opts.confirm}"` : ''}
      >
        ${label}
      </button>
    </form>
  `;
}

function money(row: RequestRow): string {
  return row.amount_cents === 0 ? 'free' : formatMoney(row.amount_cents, row.currency as Currency);
}

export function queuePage(opts: QueuePageOptions): string {
  const { settings, csrf, playing, queue, fallbackTrack, isPlaying, recent, blocklist, flash, engine } =
    opts;

  return page({
    title: 'Queue — Jukebox admin',
    bodyClass: 'page-admin',
    head: html`<script src="${asset('admin.js')}" defer></script>`,
    body: html`
      <header class="admin-header">
        <h1>Jukebox admin</h1>
        <nav class="admin-nav">
          <a href="/admin">Settings</a>
          <a href="/admin/queue" class="is-current">Queue</a>
          <a href="/status">Status</a>
          <form method="post" action="/admin/logout" class="inline">
            <input type="hidden" name="csrf" value="${csrf}" />
            <button type="submit" class="btn btn--quiet">Sign out</button>
          </form>
        </nav>
      </header>

      <main class="admin-main">
        ${flash ? notice(flash.tone, flash.message) : ''}
        ${!engine.running ? notice('error', 'The playback engine is not running.') : ''}
        ${engine.backingOff
          ? notice(
              'error',
              `Spotify is not responding (${engine.consecutiveFailures} failures in a row). Polling has slowed down; it will speed up on its own when Spotify recovers.`,
            )
          : ''}
        ${!settings.accepting_requests
          ? notice('info', 'Kill switch is on: new requests are being refused.')
          : ''}

        <section class="card">
          <h2>Playing now</h2>
          ${playing
            ? html`
                <div class="now-row">
                  ${playing.album_art_url
                    ? html`<img class="art" src="${playing.album_art_url}" alt="" width="56" height="56" />`
                    : html`<div class="art art--empty"></div>`}
                  <div class="now-row__body">
                    <strong>${playing.track_name}</strong>
                    <span class="hint">${playing.artist_name}</span>
                    <span class="hint">requested · ${money(playing)}</span>
                  </div>
                </div>
              `
            : fallbackTrack
              ? html`
                  <div class="now-row">
                    <div class="art art--empty"></div>
                    <div class="now-row__body">
                      <strong>${fallbackTrack.name}</strong>
                      <span class="hint">${fallbackTrack.artist}</span>
                      <span class="hint">from the fallback playlist</span>
                    </div>
                  </div>
                `
              : html`<p class="hint">Nothing playing.</p>`}

          <div class="button-row">
            ${action(csrf, '/admin/playback/skip', 'Skip')}
            ${isPlaying
              ? action(csrf, '/admin/playback/pause', 'Pause')
              : action(csrf, '/admin/playback/resume', 'Resume')}
            ${action(csrf, '/admin/playback/restart', 'Restart playlist')}
          </div>
        </section>

        <section class="card">
          <h2>Up next <span class="count">${String(queue.length)}</span></h2>
          ${queue.length === 0
            ? html`<p class="hint">Nothing queued — the fallback playlist is running.</p>`
            : html`
                <ol class="admin-queue">
                  ${queue.map(
                    (row, index) => html`
                      <li class="admin-queue__item ${row.pushed_at ? 'is-handed-over' : ''}">
                        <span class="admin-queue__pos">${String(index + 1)}</span>
                        ${row.album_art_url
                          ? html`<img class="art" src="${row.album_art_url}" alt="" width="40" height="40" />`
                          : html`<div class="art art--empty art--small"></div>`}
                        <span class="admin-queue__body">
                          <span class="admin-queue__name">${row.track_name}</span>
                          <span class="hint">${row.artist_name} · ${formatDuration(row.duration_ms)} · ${money(row)}</span>
                          ${row.pushed_at
                            ? html`<span class="hint hint--muted">
                                handed to Spotify — too late to reorder
                              </span>`
                            : ''}
                        </span>
                        <span class="admin-queue__actions">
                          ${index > 0 && !row.pushed_at
                            ? action(csrf, '/admin/queue/move', '↑', {
                                fields: { id: String(row.id), direction: 'up' },
                              })
                            : ''}
                          ${index < queue.length - 1 && !row.pushed_at
                            ? action(csrf, '/admin/queue/move', '↓', {
                                fields: { id: String(row.id), direction: 'down' },
                              })
                            : ''}
                          ${action(csrf, '/admin/queue/remove', 'Remove', {
                            danger: true,
                            fields: { id: String(row.id) },
                            confirm:
                              row.amount_cents > 0
                                ? `Remove “${row.track_name}”? ${money(row)} will be refunded.`
                                : `Remove “${row.track_name}”?`,
                          })}
                        </span>
                      </li>
                    `,
                  )}
                </ol>
              `}
        </section>

        <section class="card">
          <h2>Blocked</h2>
          <form method="post" action="/admin/blocklist/add" class="blocklist-form">
            <input type="hidden" name="csrf" value="${csrf}" />
            <div class="field">
              <label for="block_query">Block a track or artist</label>
              <input
                id="block_query"
                name="query"
                type="text"
                placeholder="Search by name…"
                autocomplete="off"
              />
              <p class="hint">
                Blocks by Spotify id, so covers and live versions are separate entries.
              </p>
            </div>
            <div class="field field--check">
              <label>
                <input type="radio" name="kind" value="track" checked />
                <span>Track</span>
              </label>
              <label>
                <input type="radio" name="kind" value="artist" />
                <span>Artist — blocks everything by them</span>
              </label>
            </div>
            <button type="submit" class="btn">Block</button>
          </form>

          ${blocklist.length === 0
            ? html`<p class="hint">Nothing blocked.</p>`
            : html`
                <ul class="blocklist">
                  ${blocklist.map(
                    (entry) => html`
                      <li>
                        <span><strong>${entry.label}</strong> <span class="hint">${entry.kind}</span></span>
                        ${action(csrf, '/admin/blocklist/remove', 'Unblock', {
                          fields: { id: String(entry.id) },
                        })}
                      </li>
                    `,
                  )}
                </ul>
              `}
        </section>

        <section class="card">
          <h2>Request log</h2>
          ${recent.length === 0
            ? html`<p class="hint">No requests yet.</p>`
            : html`
                <div class="log-scroll">
                  <table class="log">
                    <thead>
                      <tr>
                        <th>When</th>
                        <th>Track</th>
                        <th>State</th>
                        <th>Amount</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${recent.map(
                        (row) => html`
                          <tr>
                            <td class="log__when">${row.created_at.slice(11, 16)}</td>
                            <td>
                              ${row.track_name}
                              <span class="hint">${row.artist_name}</span>
                            </td>
                            <td><span class="state state--${row.state}">${row.state}</span></td>
                            <td>${money(row)}</td>
                            <td class="log__actions">
                              ${row.stripe_payment_intent && !row.refund_id
                                ? action(csrf, '/admin/requests/refund', 'Refund', {
                                    fields: { id: String(row.id) },
                                    confirm: `Refund ${money(row)} for “${row.track_name}”?`,
                                  })
                                : row.refund_id
                                  ? html`<span class="hint">refunded</span>`
                                  : ''}
                            </td>
                          </tr>
                        `,
                      )}
                    </tbody>
                  </table>
                </div>
              `}
        </section>
      </main>
    `,
  });
}
