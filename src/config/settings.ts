/**
 * Runtime settings: the single `settings` table, read through an in-memory
 * cache so a change in the admin panel applies to the next request with no
 * restart and no per-read SQL.
 *
 * Every key is declared once below with its Zod schema and default. Nothing
 * secret is ever stored here — secrets live in the environment.
 */
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { now } from '../db/index.js';
import { log } from '../log.js';

/** Stripe's documented minimum charge, in the smallest currency unit. */
export const STRIPE_MINIMUM_CENTS: Record<Currency, number> = { CAD: 50, USD: 50 };

export const CURRENCIES = ['CAD', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * Empty is allowed and is the shipped default: there is no playlist that works
 * for everyone. Spotify's own editorial playlists — the obvious choice — are
 * unreadable by apps created after November 2024, so the operator has to pick
 * one of their own.
 */
const spotifyPlaylistUri = z.union([
  z.literal(''),
  z
    .string()
    .regex(/^spotify:playlist:[A-Za-z0-9]{22}$/, 'must look like spotify:playlist:<22 chars>'),
]);

/**
 * The setting registry. Adding a key here is the only step needed to make it
 * readable, writable and editable in the admin form.
 */
export const SETTING_DEFS = {
  // --- pricing -------------------------------------------------------------
  /** 0 means free regardless of `free_mode`. Above 0 it must clear the Stripe
   *  minimum; `validatePrice` is the single enforcement point. */
  price_cents: { schema: z.number().int().min(0).max(100_00), default: 100 },
  currency: { schema: z.enum(CURRENCIES), default: 'CAD' as Currency },
  /** Master switch: when true, nobody is charged whatever `price_cents` says. */
  free_mode: { schema: z.boolean(), default: true },

  // --- playback ------------------------------------------------------------
  fallback_playlist_uri: { schema: spotifyPlaylistUri, default: '' },
  /** librespot's advertised Connect device name; how we re-find it on restart. */
  device_name: { schema: z.string().min(1).max(64), default: 'Jukebox' },
  volume_percent: { schema: z.number().int().min(0).max(100), default: 70 },
  /** Skip the current track the moment a request arrives, rather than letting
   *  it finish. Never applies when the current track is itself a paid request. */
  interrupt_current: { schema: z.boolean(), default: false },
  /** How long before the current track ends we hand the next request to
   *  Spotify. Large enough to absorb a missed poll, small enough that an admin
   *  reorder stays possible for as long as we can manage. */
  push_lead_ms: { schema: z.number().int().min(3_000).max(60_000), default: 15_000 },
  market: { schema: z.string().regex(/^[A-Z]{2}$/), default: 'CA' },

  // --- abuse controls ------------------------------------------------------
  /** Kill switch. False = we stop accepting new requests, playback continues. */
  accepting_requests: { schema: z.boolean(), default: true },
  cooldown_seconds: { schema: z.number().int().min(0).max(3600), default: 120 },
  /** Venue-wide burst limit: guests share one NAT'd IP, so this is deliberately
   *  loose and exists to stop a script, not to ration one person. */
  ip_requests_per_minute: { schema: z.number().int().min(1).max(600), default: 20 },
  max_pending_per_guest: { schema: z.number().int().min(1).max(20), default: 2 },
  max_queue_length: { schema: z.number().int().min(1).max(200), default: 25 },
  block_duplicates: { schema: z.boolean(), default: true },
  explicit_filter: { schema: z.boolean(), default: false },
  max_track_duration_ms: { schema: z.number().int().min(30_000).max(3_600_000), default: 600_000 },

  // --- presentation --------------------------------------------------------
  venue_name: { schema: z.string().min(1).max(60), default: 'Jukebox' },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTING_DEFS)[K]['schema']> };

const KEYS = Object.keys(SETTING_DEFS) as SettingKey[];

export class SettingsStore {
  readonly #db: Db;
  #cache: Settings;

  constructor(db: Db) {
    this.#db = db;
    this.#cache = this.#loadAll();
  }

  /** Read one setting. Cheap — always served from cache. */
  get<K extends SettingKey>(key: K): Settings[K] {
    return this.#cache[key];
  }

  /** Snapshot of every setting, for templates and the reconciler. */
  all(): Readonly<Settings> {
    return this.#cache;
  }

  /**
   * Validate and persist a partial update, then refresh the cache atomically.
   * Returns per-key error messages instead of throwing, so the admin form can
   * re-render with the operator's input intact.
   */
  update(patch: Partial<Record<SettingKey, unknown>>): { ok: true } | { ok: false; errors: Record<string, string> } {
    const errors: Record<string, string> = {};
    const accepted: Array<[SettingKey, unknown]> = [];

    for (const [rawKey, rawValue] of Object.entries(patch)) {
      if (!KEYS.includes(rawKey as SettingKey)) {
        errors[rawKey] = 'unknown setting';
        continue;
      }
      const key = rawKey as SettingKey;
      const parsed = SETTING_DEFS[key].schema.safeParse(rawValue);
      if (!parsed.success) {
        errors[key] = parsed.error.issues[0]?.message ?? 'invalid value';
        continue;
      }
      accepted.push([key, parsed.data]);
    }

    // Cross-field rule: a non-zero price must be chargeable by Stripe.
    const candidate = { ...this.#cache, ...Object.fromEntries(accepted) } as Settings;
    const priceError = validatePrice(candidate.price_cents, candidate.currency);
    if (priceError && (patch.price_cents !== undefined || patch.currency !== undefined)) {
      errors['price_cents'] = priceError;
    }

    if (Object.keys(errors).length > 0) return { ok: false, errors };

    const stmt = this.#db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    const writeAll = this.#db.transaction((rows: Array<[SettingKey, unknown]>) => {
      for (const [key, value] of rows) stmt.run(key, JSON.stringify(value), now());
    });
    writeAll(accepted);

    this.#cache = this.#loadAll();
    log.info('settings updated', { keys: accepted.map(([k]) => k) });
    return { ok: true };
  }

  /** Read the table and overlay it on the defaults. Unknown or corrupt rows
   *  fall back to the default rather than taking the process down. */
  #loadAll(): Settings {
    const rows = this.#db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const stored = new Map(rows.map((r) => [r.key, r.value]));

    const out = {} as Record<SettingKey, unknown>;
    for (const key of KEYS) {
      const def = SETTING_DEFS[key];
      const raw = stored.get(key);
      if (raw === undefined) {
        out[key] = def.default;
        continue;
      }
      try {
        const parsed = def.schema.safeParse(JSON.parse(raw));
        out[key] = parsed.success ? parsed.data : def.default;
        if (!parsed.success) {
          log.warn('stored setting failed validation; using default', { key });
        }
      } catch {
        log.warn('stored setting is not valid JSON; using default', { key });
        out[key] = def.default;
      }
    }
    return out as Settings;
  }
}

/**
 * The pricing rule, in one place: free, or at least the Stripe minimum.
 * Anything strictly between 1 and the minimum is unchargeable and must be
 * rejected loudly rather than silently rounded up.
 */
export function validatePrice(cents: number, currency: Currency): string | null {
  if (!Number.isInteger(cents) || cents < 0) return 'price must be a whole number of cents, 0 or more';
  if (cents === 0) return null;
  const min = STRIPE_MINIMUM_CENTS[currency];
  if (cents < min) {
    return `Stripe cannot charge less than ${formatMoney(min, currency)}. Use 0 for free, or ${formatMoney(min, currency)} or more.`;
  }
  return null;
}

export function formatMoney(cents: number, currency: Currency): string {
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
}

/** Whether a guest is charged right now — both switches must allow it. */
export function isPaidMode(settings: Readonly<Settings>): boolean {
  return !settings.free_mode && settings.price_cents > 0;
}
