/**
 * The set of long-lived singletons every route needs. Constructed once in
 * `main`, passed explicitly rather than imported as module globals so tests can
 * build one against a temp database.
 */
import type { Env } from './config/env.js';
import type { SettingsStore } from './config/settings.js';
import type { Db } from './db/index.js';
import type { EventLog } from './db/events.js';
import type { SpotifyAuth } from './spotify/auth.js';
import type { SpotifyClient } from './spotify/client.js';
import type { QueueRepository } from './queue/repository.js';
import type { BlocklistRepository } from './queue/blocklist.js';
import type { PlaybackEngine } from './engine/loop.js';
import type { SseHub } from './http/sse.js';
import type { PaymentService } from './payments/service.js';
import type { PaymentGateway } from './payments/gateway.js';
import type { QueueSnapshot } from './routes/guest/index.js';

export interface AppContext {
  env: Env;
  db: Db;
  settings: SettingsStore;
  events: EventLog;
  /** OAuth tokens and the connect/disconnect lifecycle. */
  spotifyAuth: SpotifyAuth;
  /** Typed endpoint wrappers. Every call is already retried and timed out. */
  spotify: SpotifyClient;
  /** The request queue — the source of truth, not Spotify's queue. */
  queue: QueueRepository;
  /** Blocked tracks and artists, cached in memory. */
  blocklist: BlocklistRepository;
  /** The poll loop. Routes read its state; only `main` starts and stops it. */
  engine: PlaybackEngine;
  /** Set by the guest routes once the live-queue hub exists, so other routes
   *  can push an update after changing the queue. */
  queueStream?: SseHub<QueueSnapshot>;
  /** Present only when Stripe is configured. Absent means free mode is the
   *  only mode this box can serve. */
  payments?: PaymentService;
  paymentGateway?: PaymentGateway;
}
