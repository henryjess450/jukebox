/**
 * The guest page.
 *
 * Server-rendered shell; search results and the live queue arrive as JSON and
 * SSE. Written for a phone held at arm's length in a dark room: big targets,
 * high contrast, no navigation between steps.
 */
import { html, jsonForScript } from '../../http/html.js';
import { page } from '../../http/layout.js';

export interface GuestPageOptions {
  venueName: string;
  priceLabel: string;
  isPaid: boolean;
  accepting: boolean;
  /** Shown in place of the search box when requests are switched off. */
  closedMessage: string | null;
}

export function guestPage(opts: GuestPageOptions): string {
  const config = {
    isPaid: opts.isPaid,
    priceLabel: opts.priceLabel,
    accepting: opts.accepting,
  };

  return page({
    title: `${opts.venueName} — pick a song`,
    bodyClass: 'page-guest',
    head: html`<script type="application/json" id="jb-config">${jsonForScript(config)}</script>
      <script src="/static/guest.js" defer></script>`,
    body: html`
      <header class="guest-header">
        <h1>${opts.venueName}</h1>
        <p class="guest-tagline">
          ${opts.accepting
            ? opts.isPaid
              ? html`Pick a song — <strong>${opts.priceLabel}</strong>`
              : 'Pick a song. It plays next.'
            : 'Requests are closed right now.'}
        </p>
      </header>

      <main class="guest-main">
        ${opts.accepting
          ? html`
              <section class="search" aria-label="Search for a song">
                <div class="search__box">
                  <input
                    id="q"
                    type="search"
                    inputmode="search"
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck="false"
                    placeholder="Song or artist"
                    aria-label="Song or artist"
                  />
                  <span class="search__spinner" id="spinner" hidden aria-hidden="true"></span>
                </div>
                <p class="hint" id="search-status" role="status" aria-live="polite"></p>
                <ul class="results" id="results"></ul>
              </section>
            `
          : html`<section class="card">
              <p>${opts.closedMessage ?? 'The jukebox is not taking requests right now.'}</p>
            </section>`}

        <section class="queue" aria-label="What is playing">
          <h2 class="queue__title">Playing now</h2>
          <div id="now-playing" class="now-playing">
            <p class="hint">Loading…</p>
          </div>

          <h2 class="queue__title">Up next</h2>
          <ol id="up-next" class="up-next">
            <li class="hint">Nothing queued — the playlist is running.</li>
          </ol>
        </section>
      </main>

      <!-- Confirmation. A sheet rather than a page, so nobody loses their search. -->
      <div class="sheet" id="sheet" hidden>
        <div class="sheet__backdrop" data-close></div>
        <div class="sheet__panel" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
          <div id="sheet-body">
            <h2 id="sheet-title">Play this next?</h2>
            <div class="sheet__track" id="sheet-track"></div>
            <dl class="sheet__facts">
              <div><dt>Price</dt><dd id="sheet-price"></dd></div>
              <div><dt>Position</dt><dd id="sheet-position"></dd></div>
            </dl>
            <p class="sheet__error" id="sheet-error" hidden role="alert"></p>
            <div class="sheet__actions">
              <button type="button" class="btn" data-close>Cancel</button>
              <button type="button" class="btn btn--primary" id="confirm">Yes, play it</button>
            </div>
          </div>
        </div>
      </div>
    `,
  });
}
