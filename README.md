# Jukebox

Self-hosted public jukebox for an HP EliteDesk running Ubuntu Server 24.04.
A fallback Spotify playlist loops over the 3.5 mm line-out; guests scan a QR
code, search, and put a track next in the queue.

> **Status: milestone 5 of 6.** Configuration, admin auth, Spotify OAuth and
> search, the playback engine, the guest page, and Stripe Checkout with
> refunds are all working. Remaining: the full admin panel (queue management,
> blocklist UI, request log), systemd units, the setup script, and the
> complete README.

## How it fits together

- **Spotify's Web API cannot emit audio.** `librespot` runs on the box as a
  headless Spotify Connect endpoint with ALSA output to the line-out jack;
  this app drives that device over the Web API using the owner's Premium
  account (Authorization Code flow, refresh token persisted).
- **The database is the queue.** Requests live in SQLite; exactly one track is
  handed to Spotify's own queue just before the current track ends. Spotify's
  queue cannot be reordered or emptied through the API, so holding the line
  here is what makes the admin panel's reorder and remove work at all.
- **Free mode bypasses Stripe entirely.** Stripe cannot charge less than
  $0.50, so a price is either 0 (free) or at least the minimum; anything in
  between is rejected with an explicit message.
- **Payment is confirmed server-side, not by the browser.** The box sits
  behind NAT, so a webhook may never arrive. When a guest returns from
  Checkout we ask Stripe directly whether that session was paid. The
  `checkout.session.completed` webhook is a secondary path; both converge on
  the same idempotent function, and the database — a `UNIQUE` constraint on
  the Stripe session id, plus a state transition that only fires from
  `pending_payment` — is what guarantees one payment buys one play.
- **Anything paid for that never plays is refunded automatically.** A sweeper
  runs every five minutes, so a guest owed money does not depend on someone
  noticing.

## Deploying to the box

See **[DEPLOY.md](DEPLOY.md)** — Ubuntu install, Docker, ALSA, and a table of
exactly where every key and secret comes from.

```bash
docker compose up -d --build
```

## Running it locally

```bash
npm install
cp .env.example .env
npm run hash-password            # paste the result into .env
openssl rand -base64 48          # paste as COOKIE_SECRET
npm run dev
```

Then open <http://127.0.0.1:8080/admin>.

`SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` must be present for the process
to start, but nothing uses them until milestone 2 — any placeholder will do for
now. Stripe keys are optional until milestone 5.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Run from TypeScript with reload |
| `npm test` | Unit tests (`node:test`, no network) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |
| `npm run hash-password` | Generate `ADMIN_PASSWORD_HASH` |

## Layout

```
src/
  main.ts            boot order, signal handling
  server.ts          Fastify assembly, static files, error handling
  context.ts         the singletons every route receives
  config/env.ts      environment validation — refuses to boot if wrong
  config/settings.ts the settings registry, cached accessor, pricing rules
  db/                connection, schema.sql, audit log
  http/              HTML templating (escaped by default), layout, CSRF, SSE
  spotify/           OAuth + tokens, HTTP layer, typed client
  engine/            reconciler (pure) and the poll loop that acts on it
  queue/             the request queue and the blocklist
  guest/             guest identity, rate limiting, request validation
  payments/          Stripe gateway and the payment flow
  routes/            guest page, admin, search, payments
```

## Testing without Spotify or Stripe

Two environment variables redirect the app at local mocks, so the whole thing
can be exercised end to end with no accounts and no network:

```
SPOTIFY_API_BASE=http://localhost:4010/v1
STRIPE_API_BASE=http://localhost:4020
```

Both are **ignored when `NODE_ENV=production`**, so a stray value can never
point a live box — or a real payment — somewhere it should not go.

## Configuration split

Secrets and deployment facts live in `.env` and are never written to the
database or logged. Everything an operator changes day to day lives in the
`settings` table and is editable at `/admin` with no restart — the store keeps
an in-memory cache that is refreshed on write, so a change applies to the very
next request.
