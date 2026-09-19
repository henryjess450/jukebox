/**
 * Entrypoint. Boots in a fixed order — environment, database, settings, HTTP —
 * and fails loudly and immediately if configuration is wrong, so systemd
 * surfaces the reason instead of restart-looping a half-built process.
 */
import { loadEnv, stripeConfigured } from './config/env.js';
import { SettingsStore } from './config/settings.js';
import { openDatabase } from './db/index.js';
import { EventLog } from './db/events.js';
import { log, setLogLevel } from './log.js';
import { SpotifyAuth } from './spotify/auth.js';
import { SpotifyClient } from './spotify/client.js';
import { SpotifyHttp } from './spotify/http.js';
import { QueueRepository } from './queue/repository.js';
import { BlocklistRepository } from './queue/blocklist.js';
import { PlaybackEngine } from './engine/loop.js';
import { StripeGateway } from './payments/gateway.js';
import { PaymentService } from './payments/service.js';
import { buildServer } from './server.js';
import type { AppContext } from './context.js';

async function main(): Promise<void> {
  const env = loadEnv();
  setLogLevel(env.LOG_LEVEL);

  const db = openDatabase(env.DATABASE_PATH);
  const settings = new SettingsStore(db);
  const events = new EventLog(db);
  // The auth store owns the tokens; the HTTP layer asks it for one on every
  // call and asks it to refresh on a 401. Nothing else touches a token.
  const spotifyAuth = new SpotifyAuth({
    db,
    clientId: env.SPOTIFY_CLIENT_ID,
    clientSecret: env.SPOTIFY_CLIENT_SECRET,
    redirectUri: `${env.PUBLIC_URL}/admin/spotify/callback`,
    stateSecret: env.COOKIE_SECRET,
  });
  const spotify = new SpotifyClient(
    new SpotifyHttp({
      getAccessToken: () => spotifyAuth.getAccessToken(),
      refreshAccessToken: () => spotifyAuth.refresh(),
      ...(env.SPOTIFY_API_BASE ? { baseUrl: env.SPOTIFY_API_BASE } : {}),
    }),
  );

  const queue = new QueueRepository(db);
  const blocklist = new BlocklistRepository(db);
  const engine = new PlaybackEngine({ spotify, auth: spotifyAuth, queue, settings, events });

  const ctx: AppContext = {
    env,
    db,
    settings,
    events,
    spotifyAuth,
    spotify,
    queue,
    blocklist,
    engine,
  };

  engine.start();

  // Unpaid rows from abandoned checkouts otherwise occupy a guest's slot
  // forever. Hourly is often enough for a 30-minute expiry.
  const sweeper = setInterval(
    () => {
      const expired = queue.expireAbandonedPayments(30 * 60_000);
      if (expired > 0) log.info('expired abandoned checkouts', { count: expired });
    },
    15 * 60_000,
  );
  sweeper.unref();

  if (env.STRIPE_SECRET_KEY) {
    const gateway = new StripeGateway(
      env.STRIPE_SECRET_KEY,
      env.STRIPE_WEBHOOK_SECRET,
      env.STRIPE_API_BASE,
    );
    ctx.paymentGateway = gateway;
    ctx.payments = new PaymentService({
      gateway,
      queue,
      events,
      publicUrl: env.PUBLIC_URL,
      onQueued: () => ctx.queueStream?.publish(),
    });

    // A paid request that never plays must be refunded without anyone
    // noticing it. Transient refund failures are retried by the next sweep.
    const refundSweeper = setInterval(
      () => {
        void ctx.payments?.sweepRefunds().catch((err: unknown) => {
          log.error('refund sweep failed', { err });
        });
      },
      5 * 60_000,
    );
    refundSweeper.unref();
  } else if (!settings.get('free_mode') && settings.get('price_cents') > 0) {
    log.warn('paid mode is configured but STRIPE_SECRET_KEY is not set; guests cannot pay');
  }

  const app = await buildServer(ctx);
  await app.listen({ host: env.HOST, port: env.PORT });

  log.info('jukebox started', {
    host: env.HOST,
    port: env.PORT,
    public_url: env.PUBLIC_URL,
    stripe_configured: stripeConfigured(env),
    spotify_connected: spotifyAuth.isConnected(),
    free_mode: settings.get('free_mode'),
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    engine.stop();
    ctx.queueStream?.closeAll();
    clearInterval(sweeper);
    void app
      .close()
      .catch((err) => log.error('error during shutdown', { err }))
      .finally(() => {
        db.close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Never die silently on an unhandled rejection; log it and keep serving.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', { err: reason });
  });
  process.on('uncaughtException', (err) => {
    log.error('uncaught exception', { err });
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\n${message}\n\n`);
  process.exit(1);
});
