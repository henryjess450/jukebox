/** Admin page markup. */
import { asset } from '../../http/assets.js';
import { html, type SafeHtml } from '../../http/html.js';
import { page, notice } from '../../http/layout.js';
import {
  CURRENCIES,
  formatMoney,
  STRIPE_MINIMUM_CENTS,
  type Currency,
  type Settings,
} from '../../config/settings.js';

export function loginPage(opts: { error?: string }): string {
  return page({
    title: 'Admin — Jukebox',
    bodyClass: 'page-login',
    body: html`
      <main class="card card--narrow">
        <h1>Jukebox admin</h1>
        ${opts.error ? notice('error', opts.error) : ''}
        <form method="post" action="/admin/login" autocomplete="on">
          <label for="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autocomplete="current-password"
            required
            autofocus
          />
          <button type="submit" class="btn btn--primary">Sign in</button>
        </form>
      </main>
    `,
  });
}

function checkbox(name: string, label: string, checked: boolean, hint?: string): SafeHtml {
  return html`
    <div class="field field--check">
      <label>
        <input type="checkbox" name="${name}" value="true" ${checked ? html`checked` : ''} />
        <span>${label}</span>
      </label>
      ${hint ? html`<p class="hint">${hint}</p>` : ''}
    </div>
  `;
}

function numberField(
  name: string,
  label: string,
  /** Normally a number; a rejected submission may echo back the raw string. */
  value: number | string,
  attrs: { min?: number; max?: number; step?: number; hint?: string; error?: string } = {},
): SafeHtml {
  return html`
    <div class="field ${attrs.error ? 'field--error' : ''}">
      <label for="${name}">${label}</label>
      <input
        id="${name}"
        name="${name}"
        type="number"
        value="${String(value)}"
        ${attrs.min !== undefined ? html`min="${String(attrs.min)}"` : ''}
        ${attrs.max !== undefined ? html`max="${String(attrs.max)}"` : ''}
        step="${String(attrs.step ?? 1)}"
      />
      ${attrs.error ? html`<p class="hint hint--error">${attrs.error}</p>` : ''}
      ${attrs.hint && !attrs.error ? html`<p class="hint">${attrs.hint}</p>` : ''}
    </div>
  `;
}

function colourField(name: string, label: string, value: string, hint?: string): SafeHtml {
  return html`
    <div class="field field--colour">
      <label for="${name}">${label}</label>
      <div class="colour-row">
        <input type="color" id="${name}_picker" value="${value}" data-colour-for="${name}" />
        <input
          id="${name}"
          name="${name}"
          type="text"
          value="${value}"
          spellcheck="false"
          autocomplete="off"
        />
      </div>
      ${hint ? html`<p class="hint">${hint}</p>` : ''}
    </div>
  `;
}

function textField(
  name: string,
  label: string,
  value: string | number,
  attrs: { hint?: string; error?: string; placeholder?: string } = {},
): SafeHtml {
  return html`
    <div class="field ${attrs.error ? 'field--error' : ''}">
      <label for="${name}">${label}</label>
      <input
        id="${name}"
        name="${name}"
        type="text"
        value="${value}"
        ${attrs.placeholder ? html`placeholder="${attrs.placeholder}"` : ''}
      />
      ${attrs.error ? html`<p class="hint hint--error">${attrs.error}</p>` : ''}
      ${attrs.hint && !attrs.error ? html`<p class="hint">${attrs.hint}</p>` : ''}
    </div>
  `;
}

export interface SettingsPageOptions {
  settings: Readonly<Settings>;
  csrf: string;
  errors?: Record<string, string>;
  /** Raw form values from a rejected submission, redisplayed so the operator
   *  sees what they typed next to the error rather than the stored value. */
  submitted?: Record<string, unknown>;
  saved?: boolean;
  stripeReady: boolean;
}

export function settingsPage({
  settings,
  csrf,
  errors = {},
  submitted,
  saved = false,
  stripeReady,
}: SettingsPageOptions): string {
  /** Prefer the rejected input over the stored value, for fields that failed. */
  const shown = <K extends keyof Settings>(key: K): Settings[K] => {
    const raw = submitted?.[key as string];
    return (errors[key as string] !== undefined && raw !== undefined
      ? (raw as Settings[K])
      : settings[key]);
  };
  const minimum = formatMoney(STRIPE_MINIMUM_CENTS[settings.currency], settings.currency);
  const paidActive = !settings.free_mode && settings.price_cents > 0;

  return page({
    title: 'Settings — Jukebox admin',
    bodyClass: 'page-admin',
    head: html`<script src="${asset('admin.js')}" defer></script>`,
    body: html`
      <header class="admin-header">
        <h1>Jukebox admin</h1>
        <nav class="admin-nav">
          <a href="/admin" class="is-current">Settings</a>
          <a href="/admin/queue">Queue</a>
          <a href="/status">Status</a>
          <form method="post" action="/admin/logout" class="inline">
            <input type="hidden" name="csrf" value="${csrf}" />
            <button type="submit" class="btn btn--quiet">Sign out</button>
          </form>
        </nav>
      </header>

      <main class="admin-main">
        ${saved ? notice('ok', 'Settings saved. They apply immediately.') : ''}
        ${Object.keys(errors).length > 0
          ? notice('error', 'Nothing was saved — fix the highlighted fields.')
          : ''}
        ${!settings.accepting_requests
          ? notice('info', 'Kill switch is on: new requests are being refused.')
          : ''}
        ${paidActive && !stripeReady
          ? notice(
              'error',
              'Paid mode is on but STRIPE_SECRET_KEY is not set, so checkout will fail. Set it in .env and restart, or turn on free mode.',
            )
          : ''}

        <form method="post" action="/admin/settings" class="settings-form">
          <input type="hidden" name="csrf" value="${csrf}" />

          <section class="card">
            <h2>Pricing</h2>
            ${checkbox(
              'free_mode',
              'Free mode',
              settings.free_mode,
              'When on, nobody is charged and Stripe is bypassed entirely.',
            )}
            ${numberField('price_cents', 'Price (cents)', shown('price_cents'), {
              min: 0,
              max: 10000,
              hint: `0 is free. Otherwise at least ${minimum} — Stripe cannot charge less.`,
              ...(errors['price_cents'] ? { error: errors['price_cents'] } : {}),
            })}
            <div class="field">
              <label for="currency">Currency</label>
              <select id="currency" name="currency">
                ${CURRENCIES.map(
                  (c: Currency) =>
                    html`<option value="${c}" ${c === settings.currency ? html`selected` : ''}>
                      ${c}
                    </option>`,
                )}
              </select>
            </div>
            <p class="hint">
              Currently: <strong>${paidActive ? formatMoney(settings.price_cents, settings.currency) : 'free'}</strong>
              per request.
            </p>
          </section>

          <section class="card">
            <h2>Playback</h2>
            ${textField('fallback_playlist_uri', 'Fallback playlist URI', shown('fallback_playlist_uri'), {
              placeholder: 'spotify:playlist:...',
              hint: 'Loops whenever the request queue is empty.',
              ...(errors['fallback_playlist_uri'] ? { error: errors['fallback_playlist_uri'] } : {}),
            })}
            ${textField('device_name', 'Connect device name', shown('device_name'), {
              hint: 'Must match the --name passed to librespot.',
              ...(errors['device_name'] ? { error: errors['device_name'] } : {}),
            })}
            ${numberField('volume_percent', 'Volume (%)', shown('volume_percent'), { min: 0, max: 100 })}
            ${textField('market', 'Market', shown('market'), {
              hint: 'Two-letter country code used for search and availability.',
              ...(errors['market'] ? { error: errors['market'] } : {}),
            })}
            ${checkbox(
              'interrupt_current',
              'Interrupt the current track',
              settings.interrupt_current,
              'Skip straight to a new request. Never interrupts another guest’s paid track.',
            )}
            ${numberField('push_lead_ms', 'Hand-off lead time (ms)', shown('push_lead_ms'), {
              min: 3000,
              max: 60000,
              step: 1000,
              hint: 'How long before a track ends we hand the next request to Spotify.',
            })}
          </section>

          <section class="card">
            <h2>Requests</h2>
            ${checkbox(
              'accepting_requests',
              'Accepting new requests',
              settings.accepting_requests,
              'Turn off as a kill switch. Playback continues; the guest page explains why.',
            )}
            ${numberField('cooldown_seconds', 'Per-guest cooldown (seconds)', shown('cooldown_seconds'), {
              min: 0,
              max: 3600,
            })}
            ${numberField(
              'ip_requests_per_minute',
              'Requests per minute, per IP',
              settings.ip_requests_per_minute,
              { min: 1, max: 600, hint: 'Venue-wide burst limit — guests usually share one IP.' },
            )}
            ${numberField('max_pending_per_guest', 'Max pending per guest', shown('max_pending_per_guest'), {
              min: 1,
              max: 20,
            })}
            ${numberField('max_queue_length', 'Max queue length', shown('max_queue_length'), { min: 1, max: 200 })}
            ${numberField(
              'max_track_duration_ms',
              'Max track length (ms)',
              settings.max_track_duration_ms,
              { min: 30000, max: 3600000, step: 30000, hint: '600000 ms = 10 minutes.' },
            )}
            ${checkbox('block_duplicates', 'Block duplicate tracks', settings.block_duplicates)}
            ${checkbox('explicit_filter', 'Hide explicit tracks', settings.explicit_filter)}
          </section>

          <section class="card">
            <h2>Fundraising</h2>
            ${checkbox(
              'fundraiser_enabled',
              'Run this as a fundraiser',
              settings.fundraiser_enabled,
              'Presents every paid request as a donation, on the guest page and on the card statement.',
            )}
            ${textField('fundraiser_name', 'Raising money for', shown('fundraiser_name'), {
              placeholder: 'e.g. the Grade 8 trip',
              hint: 'Appears on the Stripe checkout as “DONATION to …: <song>”, so it is what shows on their statement.',
              ...(errors['fundraiser_name'] ? { error: errors['fundraiser_name'] } : {}),
            })}
            ${textField('fundraiser_blurb', 'One-line explanation', shown('fundraiser_blurb'), {
              placeholder: 'e.g. Every song pays for a seat on the bus.',
              hint: 'Shown under the header on the guest page. Optional.',
              ...(errors['fundraiser_blurb'] ? { error: errors['fundraiser_blurb'] } : {}),
            })}
            ${settings.fundraiser_enabled && settings.free_mode
              ? notice('info', 'Free mode is on, so nobody is being charged and nothing is being raised.')
              : ''}
          </section>

          <section class="card">
            <h2>Look and feel</h2>
            ${textField('venue_name', 'Venue name', shown('venue_name'), {
              hint: 'Shown at the top of the guest page.',
              ...(errors['venue_name'] ? { error: errors['venue_name'] } : {}),
            })}
            ${textField('venue_emoji', 'Emoji beside the name', shown('venue_emoji'), {
              placeholder: '🎃',
              hint: 'Optional. Paste one or two.',
              ...(errors['venue_emoji'] ? { error: errors['venue_emoji'] } : {}),
            })}
            ${textField('queue_emoji', 'Emoji for the queue', shown('queue_emoji'), {
              placeholder: '💀',
              hint: 'Optional. Decorates the now-playing row.',
              ...(errors['queue_emoji'] ? { error: errors['queue_emoji'] } : {}),
            })}
            ${textField('header_image_url', 'Header photo URL', shown('header_image_url'), {
              placeholder: 'https://…/banner.jpg',
              hint: 'Shown across the top of the guest page. Leave empty for just the name. Must be a public https URL — paste a link, not a file.',
              ...(errors['header_image_url'] ? { error: errors['header_image_url'] } : {}),
            })}

            <div class="colour-grid">
              ${colourField('theme_accent', 'Accent', settings.theme_accent, 'Buttons and highlights.')}
              ${colourField('theme_background', 'Background', settings.theme_background)}
              ${colourField('theme_surface', 'Cards', settings.theme_surface)}
              ${colourField('theme_text', 'Text', settings.theme_text)}
            </div>
            ${errors['theme_accent'] ? html`<p class="hint hint--error">${errors['theme_accent']}</p>` : ''}
            <p class="hint">
              <a href="/" target="_blank" rel="noopener">Open the guest page</a> in another tab to see
              changes — they apply as soon as you save.
            </p>
          </section>

          <div class="form-actions">
            <button type="submit" class="btn btn--primary">Save settings</button>
          </div>
        </form>
      </main>
    `,
  });
}
