# Deploying to the EliteDesk

There is no image to flash. You flash the **Ubuntu installer** to a USB stick,
install Ubuntu once, then deploy this repository with Docker over SSH.

**This box has to run Linux.** The audio path is librespot writing to ALSA,
with `/dev/snd` passed into a container. Docker Desktop on Windows or macOS
runs containers in a VM with no access to the sound card, so the jukebox can
serve pages there but can never play a note. Windows is fine for looking at
the app (`scripts/setup.ps1`); it is not a deployment target.

---

## 1. Get Ubuntu onto the box

On your Mac:

1. Download **Ubuntu Server 24.04 LTS** (not Desktop) from
   <https://ubuntu.com/download/server>.
2. Flash the `.iso` to a USB stick with [balenaEtcher](https://etcher.balena.io)
   or, from the terminal, `dd`. Etcher is harder to get wrong.
3. Boot the EliteDesk from the USB stick — tap `F9` at the HP logo for the boot
   menu, `F10` for BIOS if USB boot is disabled.
4. Install. When asked, **tick "Install OpenSSH server"** — this is the only
   choice in the installer that matters, because the box is headless
   afterwards. Give it a fixed hostname you will remember, e.g. `jukebox`.
5. Set the BIOS to power on after a power loss (`F10` → Advanced → Power-On
   Options → After Power Loss: **Power On**). A venue will unplug this box.

From here on, everything is over SSH: `ssh you@jukebox.local`.

## 2. Install Docker

```bash
sudo apt update && sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"   # log out and back in for this to take effect
```

## 3. Get the code and configure it

```bash
git clone <your-repo-url> jukebox && cd jukebox
cp .env.example .env
```

Now fill in `.env`. Section 6 below says where each value comes from.

Two of them you generate on the box itself:

```bash
openssl rand -base64 48                       # -> COOKIE_SECRET
docker run --rm node:20-slim sh -c \
  'npm i -s bcryptjs >/dev/null 2>&1 && node -e "console.log(require(\"bcryptjs\").hashSync(process.argv[1],12))" "your admin password"'
                                              # -> ADMIN_PASSWORD_HASH
```

**Put the hash in single quotes:**

```
ADMIN_PASSWORD_HASH='$2b$12$....'
```

A bcrypt hash is full of `$`, and Docker Compose treats an unquoted `$NAME` in
`.env` as a variable to substitute. Without the quotes the container receives a
mangled hash and refuses to start, reporting that the hash is malformed. The
same applies to any other value containing a `$`.

And one you read off the host:

```bash
getent group audio | cut -d: -f3              # -> AUDIO_GID
```

## 4. Find the right sound card

The EliteDesk's analog line-out is usually card 0, but check rather than
assume:

```bash
aplay -l                      # lists cards and devices
speaker-test -c 2 -t sine -D default   # ctrl-c to stop
```

If `default` is silent, try each card explicitly — `-D hw:0,0`, `-D hw:1,0` —
and put the one that makes noise in `ALSA_DEVICE`. If nothing makes noise,
the output is probably muted at the mixer:

```bash
amixer scontrols              # list controls
amixer sset Master 70% unmute
amixer sset 'Auto-Mute Mode' Disabled   # HP boxes mute line-out when headphones are "detected"
sudo alsactl store            # persist across reboots
```

## 5. Bring it up

On the EliteDesk, bring up the app **and** the audio layer:

```bash
docker compose -f docker-compose.yml -f docker-compose.audio.yml up -d --build
docker compose logs -f
```

The first run compiles librespot from source; allow 5-15 minutes.

`docker compose up -d --build` on its own starts the app without librespot,
which is how you run it on a machine with no sound card — a laptop, or this
box before the audio is wired up. Compose merges list fields rather than
replacing them, so audio access has to be *added* by the second file; it
cannot be subtracted by one.

Then, **once**, from a phone or laptop **on the same Wi-Fi as the box**: open
Spotify, tap the Connect (speaker) icon, and pick **Jukebox**. This hands
librespot the credentials it needs.

This step is not optional and cannot be done from the admin panel. Spotify
removed username/password login from the protocol, so a headless device gets
its credentials either this way or through an OAuth flow — there is no
`--username --password` to put in a config file any more. The credentials are
written to the `librespot-cache` volume and survive restarts; if you ever
`docker compose down -v`, you must do this again.

## 6. Where each key comes from

**Do not send any of these to anyone, including in a chat window.** Every one
is generated or fetched by you, directly, and typed into `.env` on the box.

| Variable | Where you get it |
| --- | --- |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | <https://developer.spotify.com/dashboard> → **Create app**. See "Creating the Spotify app" below — the redirect URI has rules that will bite you. |
| Spotify **Premium** | The account you will authorize in the admin panel must have it. The Web API refuses playback control on a free account, and librespot will connect but never play. Family/Duo count. |
| `STRIPE_SECRET_KEY` | <https://dashboard.stripe.com/apikeys>. Use the **test** key (`sk_test_…`) until the whole flow works; switch to live (`sk_live_…`) when you are ready to take real money. Never the publishable key — this app uses hosted Checkout and needs the secret key server-side. |
| `STRIPE_WEBHOOK_SECRET` | <https://dashboard.stripe.com/webhooks> → **Add endpoint** → URL `https://driftwood-digital.season.henryjess.ca/webhooks/stripe`, event `checkout.session.completed`. The signing secret (`whsec_…`) is shown on the endpoint's page. Only needed once the tunnel is up; the primary confirmation path does not use it. |
| `TUNNEL_TOKEN` | Only for Option B. <https://one.dash.cloudflare.com> → **Networks → Tunnels → Create a tunnel** → Cloudflared. Copy the token from the install command, then add a **public hostname** pointing at `http://localhost:8080`. Requires the domain to be on Cloudflare's nameservers. |
| `COOKIE_SECRET` | `openssl rand -base64 48` on the box. Yours alone; rotating it just signs everyone out. |
| `ADMIN_PASSWORD_HASH` | `npm run hash-password`, or the Docker one-liner in section 3. The plaintext password never leaves your head; only the hash goes in `.env`. |
| `AUDIO_GID` | `getent group audio \| cut -d: -f3` on the box. |

For this deployment:

```
PUBLIC_URL=https://driftwood-digital.season.henryjess.ca
```

It has to be decided before you register the Spotify redirect URI, because the
two must match exactly.

## 6b. Exposing the box to guests — pick one

Guests are on venue Wi-Fi and cannot reach the box directly, and both Spotify
and Stripe require **HTTPS**. There are two ways to get there. Pick one before
registering the Spotify app, because the redirect URI has to be final.

### Option A — nginx + Let's Encrypt (no Cloudflare needed)

Right for you if DNS already points at the venue's IP and you can forward
ports on the router. `driftwood-digital.season.henryjess.ca` already resolves
and already has an nginx answering on port 80, so most of this may be done.

What has to be true:

- Router forwards **80 and 443** to the box.
- The venue's public IP is stable, or you run a dynamic-DNS updater.
- Port 80 stays reachable, because Let's Encrypt renews through it.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo certbot --nginx -d driftwood-digital.season.henryjess.ca
```

Then make the site config proxy to the app. The SSE stream needs its own
block — with nginx's default buffering the live queue silently never updates:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name driftwood-digital.season.henryjess.ca;

    ssl_certificate     /etc/letsencrypt/live/driftwood-digital.season.henryjess.ca/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/driftwood-digital.season.henryjess.ca/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    # Server-sent events: buffering here would stall the live queue forever.
    location /api/queue/stream {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_buffering    off;
        proxy_cache        off;
        proxy_read_timeout 1h;
        chunked_transfer_encoding off;
    }
}

server {
    listen 80;
    server_name driftwood-digital.season.henryjess.ca;
    return 301 https://$host$request_uri;
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The app binds `127.0.0.1:8080` and trusts `X-Forwarded-For`, so per-IP limits
see the guest's address rather than nginx's.

### Option B — Cloudflare Tunnel

Right if you would rather not forward ports or manage certificates. **It
requires the domain's nameservers to be Cloudflare's.** `henryjess.ca`
currently uses Wix nameservers (`ns8.wixdns.net`), so this option means either:

- moving `henryjess.ca` to Cloudflare DNS — every existing record, including
  whatever points at the Wix site, must be recreated there first; or
- putting a different domain on Cloudflare and using that for the jukebox.

A `trycloudflare.com` quick tunnel is not usable here: the URL changes on every
restart, which breaks both the printed QR code and the registered Spotify
redirect URI.

Once the zone is on Cloudflare, `docker-compose.tunnel.yml` and `TUNNEL_TOKEN`
do the rest, and no router ports need opening.

## 6a. Creating the Spotify app

There is no separate "API" to sign up for. Creating an app on
<https://developer.spotify.com/dashboard> **is** how you get API access, and
the Client ID and Client Secret it gives you are the only credentials this
project needs.

1. Log in with the **Premium account that will play the music**.
2. **Create app**. Name and description can be anything — this app is private
   to you and never goes through review.
3. **Redirect URI** — the part that goes wrong. It must be your public URL
   followed by `/admin/spotify/callback`, matching character for character,
   including the scheme and any port. You can add more than one, so add both:

   | Purpose | Redirect URI |
   | --- | --- |
   | This deployment | `https://driftwood-digital.season.henryjess.ca/admin/spotify/callback` |
   | Testing before HTTPS works | `http://127.0.0.1:8080/admin/spotify/callback` |

   **Do not use `localhost`.** Since February 2025 Spotify rejects the
   hostname outright — you must write the literal `127.0.0.1`. Plain HTTP is
   allowed *only* for loopback addresses (`127.0.0.1` or `[::1]`); anything
   else has to be HTTPS. This app refuses to start on a `PUBLIC_URL` that
   breaks either rule, so you will find out at boot rather than at a Spotify
   error page.
4. Under **Which API/SDKs are you planning to use?** tick **Web API**.
5. Save, then open the app's **Settings**. The **Client ID** is shown; the
   secret is behind **View client secret**. Put both in `.env`.

`PUBLIC_URL` in `.env` must match the redirect URI you are using, minus the
`/admin/spotify/callback` part. Change one and you must change the other.

Nothing else on that dashboard matters. You do not need a quota extension:
this app only ever authorizes one account — yours — and guests never log in
to Spotify at all.

## 7. Day-to-day

```bash
docker compose ps                    # what is running
docker compose logs -f jukebox       # app logs (JSON, one line per event)
docker compose logs -f librespot     # audio / Connect logs
docker compose -f docker-compose.yml -f docker-compose.audio.yml up -d --build   # update after a git pull
docker compose restart librespot     # if the Connect device goes missing
```

The database lives in the `jukebox-data` volume. To back it up:

```bash
docker compose exec jukebox sh -c 'cat /data/jukebox.db' > jukebox-backup.db
```

`docker compose down` stops everything and keeps your data.
`docker compose down -v` **deletes the database and the Spotify credentials**.

---

## Why Docker here, and where it bites

Running this in containers buys you a repeatable deploy and a one-command
update, which is worth a lot on a box you will not be sitting in front of.
The costs are real but small, and all of them are in the audio path:

- **librespot needs the host network**, because Spotify Connect discovery is
  mDNS and mDNS does not cross Docker's bridge. That is why `network_mode:
  host` is set on that service and only that service.
- **Both containers need `/dev/snd` and the host's `audio` group** — librespot
  to play, the app to run `amixer`. If `AUDIO_GID` is wrong, librespot starts
  and then fails to open the device; the logs say so plainly.
- **The credentials cache must be a volume.** Without it librespot forgets who
  it is on every restart and the jukebox goes quiet until someone picks it from
  a phone again.

If you would rather not containerise the audio, run librespot natively from
`systemd/librespot.service` (milestone 6) and keep only the app in Docker; the
compose file works with the `librespot` service commented out.
