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

```bash
git clone https://github.com/henryjess450/jukebox.git
cd jukebox
./scripts/setup.sh
```

The app listens on **port 4321**. To also serve it on port 80 — so a QR code
can point at a bare hostname with no port in it — add the overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.port80.yml up -d --build
```

Port 80 is deliberately not in the base file: it is often already taken by
nginx or IIS, and a clash there would stop the whole stack from starting.

For guests' phones to reach the box over the venue Wi-Fi, set `BIND_HOST=0.0.0.0`
in `.env`. The default, `127.0.0.1`, accepts connections only from the machine
itself, which is what you want when nginx or a tunnel fronts it.

`setup.sh` installs Docker if it is missing, generates the admin password and
cookie secret, checks the sound card, writes `.env`, and starts the stack. It
prints the admin password once — write it down. Re-running it is safe; an
existing `.env` is never overwritten.

Then put your Spotify client id and secret in `.env` and restart. See
**[DEPLOY.md](DEPLOY.md)** for the Ubuntu install, the Spotify app
registration (the redirect URI has rules that will bite you), Stripe keys,
HTTPS, and ALSA troubleshooting.

Without a sound card — a laptop, or the box before audio is wired up — the app
runs on its own:

```bash
docker compose up -d --build     # app only, no librespot
```

### Windows

Clone it, then **double-click `setup.bat`**.

```powershell
git clone https://github.com/henryjess450/jukebox.git
```

It asks for an admin password, your Spotify keys and (optionally) a Stripe
key, writes `.env`, builds, starts, and then checks the app actually answers —
printing the container's log if it does not. Re-run it any time; it offers to
keep the configuration you already have.

`setup.bat` exists because PowerShell refuses to run local scripts by default
and batch cannot prompt for a password without echoing it. The batch file only
launches `scripts/setup.ps1` past that policy, for that one process, changing
nothing on the machine.

**Windows runs the app, not the jukebox.** Docker Desktop's Linux VM has no
access to the sound card, so librespot cannot play anything. The admin panel,
guest page, search and the queue all work, and it is a fine way to look at the
thing — but making noise needs a Linux host.

## Running it locally

```bash
npm install
cp .env.example .env
npm run hash-password            # paste the result into .env
openssl rand -base64 48          # paste as COOKIE_SECRET
npm run dev
```

Then open <http://127.0.0.1:4321/admin>.

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
