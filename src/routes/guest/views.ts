/**
 * The guest page.
 *
 * Server-rendered shell; search results and the live queue arrive as JSON and
 * SSE. Written for a phone held at arm's length in a dark room: big targets,
 * high contrast, no navigation between steps.
 *
 * Colours, emoji and the header photo all come from settings, so an operator
 * can make it look like their event without touching the code.
 */
import { asset } from '../../http/assets.js';
import { html, jsonForScript, raw, type SafeHtml } from '../../http/html.js';
import { page } from '../../http/layout.js';

export interface GuestPageOptions {
  venueName: string;
  venueEmoji: string;
  queueEmoji: string;
  headerImageUrl: string;
  priceLabel: string;
  isPaid: boolean;
  accepting: boolean;
  fundraiserName: string;
  fundraiserBlurb: string;
  theme: { accent: string; background: string; surface: string; text: string };
  closedMessage: string | null;
}

/**
 * Operator-chosen colours, injected as the same custom properties the
 * stylesheet already uses. Every value is a validated hex colour, so it cannot
 * carry anything but six hex digits into the stylesheet.
 */
function themeStyle(theme: GuestPageOptions['theme']): SafeHtml {
  return raw(`<style>
      .page-guest {
        --bg: ${theme.background};
        --surface: ${theme.surface};
        --surface-2: color-mix(in srgb, ${theme.surface} 80%, ${theme.text} 8%);
        --border: color-mix(in srgb, ${theme.surface} 70%, ${theme.text} 18%);
        --text: ${theme.text};
        --text-dim: color-mix(in srgb, ${theme.text} 62%, ${theme.background});
        --accent: ${theme.accent};
        --accent-ink: color-mix(in srgb, ${theme.accent} 18%, #000);
        background: ${theme.background};
        color: ${theme.text};
      }
    </style>`);
}

export function guestPage(opts: GuestPageOptions): string {
  const config = {
    isPaid: opts.isPaid,
    priceLabel: opts.priceLabel,
    accepting: opts.accepting,
    queueEmoji: opts.queueEmoji,
    fundraiserName: opts.fundraiserName,
  };

  const title = opts.venueEmoji ? `${opts.venueEmoji} ${opts.venueName}` : opts.venueName;

  return page({
    title: `${opts.venueName} — pick a song`,
    bodyClass: 'page-guest',
    head: html`${themeStyle(opts.theme)}
      <script type="application/json" id="jb-config">${jsonForScript(config)}</script>
      <script src="${asset('guest.js')}" defer></script>`,
    body: html`
      <header class="guest-header ${opts.headerImageUrl ? 'guest-header--photo' : ''}">
        ${opts.headerImageUrl
          ? html`<img class="guest-header__photo" src="${opts.headerImageUrl}" alt="" />`
          : ''}
        <div class="guest-header__text">
          <h1>${title}</h1>
          <p class="guest-tagline">
            ${opts.accepting
              ? opts.isPaid
                ? opts.fundraiserName
                  ? html`Pick a song — <strong>${opts.priceLabel}</strong> to
                      ${opts.fundraiserName}`
                  : html`Pick a song — <strong>${opts.priceLabel}</strong>`
                : 'Pick a song. It plays next.'
              : 'Requests are closed right now.'}
          </p>
          ${opts.fundraiserBlurb && opts.accepting
            ? html`<p class="guest-blurb">${opts.fundraiserBlurb}</p>`
            : ''}
        </div>
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
          <h2 class="queue__title">${opts.queueEmoji ? `${opts.queueEmoji} ` : ''}Playing now</h2>
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
              <div><dt>${opts.fundraiserName ? 'Donation' : 'Price'}</dt><dd id="sheet-price"></dd></div>
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
