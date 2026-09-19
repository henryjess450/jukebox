#!/usr/bin/env bash
#
# Bootstrap the jukebox on a fresh Ubuntu Server box.
#
#   ./scripts/setup.sh
#
# Installs Docker if missing, generates the secrets that must not be guessable,
# writes .env, checks the sound card, and brings the stack up. Safe to re-run:
# anything already done is left alone, and an existing .env is never
# overwritten.

set -euo pipefail

cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m    %s\033[0m\n' "$*"; }
die()  { printf '\033[31m    %s\033[0m\n' "$*" >&2; exit 1; }

# --- Docker ----------------------------------------------------------------

say "Docker"
if command -v docker >/dev/null 2>&1; then
  ok "already installed ($(docker --version))"
else
  warn "installing Docker; this needs sudo"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  warn "you have been added to the docker group — log out and back in, then re-run this"
  exit 0
fi

docker info >/dev/null 2>&1 || die "Docker is installed but not reachable. Is the daemon running, and are you in the docker group?"

# --- audio -----------------------------------------------------------------

say "Sound card"
AUDIO_GID="$(getent group audio | cut -d: -f3 || true)"
if [ -z "$AUDIO_GID" ]; then
  warn "no 'audio' group on this host; librespot will not be able to open the device"
  AUDIO_GID=29
else
  ok "audio group id: $AUDIO_GID"
fi

if [ -d /dev/snd ]; then
  ok "/dev/snd present"
  if command -v aplay >/dev/null 2>&1; then
    aplay -l 2>/dev/null | grep -E '^card' | sed 's/^/    /' || warn "aplay listed no cards"
  else
    warn "alsa-utils not installed; run: sudo apt install -y alsa-utils"
  fi
else
  warn "/dev/snd is missing — this box has no sound card, or you are not on Linux."
  warn "The app will still run; librespot will not."
fi

# --- .env ------------------------------------------------------------------

say "Configuration"
if [ -f .env ]; then
  ok ".env already exists; leaving it alone"
else
  command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets"

  COOKIE_SECRET="$(openssl rand -base64 48 | tr -d '\n')"

  # A password you can actually read out, rather than one nobody will use.
  ADMIN_PASSWORD="jukebox-$(openssl rand -hex 4)"
  ADMIN_HASH="$(docker run --rm node:20-slim sh -c \
    "npm i -s bcryptjs >/dev/null 2>&1 && node -e \"console.log(require('bcryptjs').hashSync(process.argv[1], 12))\" '$ADMIN_PASSWORD'")"

  cp .env.example .env
  # Single quotes on the hash: it contains '$', which Docker Compose would
  # otherwise read as a variable to substitute.
  sed -i "s|^COOKIE_SECRET=.*|COOKIE_SECRET='${COOKIE_SECRET}'|" .env
  sed -i "s|^ADMIN_PASSWORD_HASH=.*|ADMIN_PASSWORD_HASH='${ADMIN_HASH}'|" .env
  sed -i "s|^AUDIO_GID=.*|AUDIO_GID=${AUDIO_GID}|" .env
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=http://127.0.0.1:8080|" .env
  sed -i "s|^SPOTIFY_CLIENT_ID=.*|SPOTIFY_CLIENT_ID=replace-me-from-spotify-dashboard|" .env
  sed -i "s|^SPOTIFY_CLIENT_SECRET=.*|SPOTIFY_CLIENT_SECRET=replace-me-from-spotify-dashboard|" .env

  ok "wrote .env"
  printf '\n\033[1m    ADMIN PASSWORD: %s\033[0m\n' "$ADMIN_PASSWORD"
  printf '    Write this down — it is not stored anywhere in plain text.\n'
fi

# --- start -----------------------------------------------------------------

say "Starting"
COMPOSE_FILES=(-f docker-compose.yml)
if [ -d /dev/snd ]; then
  COMPOSE_FILES+=(-f docker-compose.audio.yml)
  warn "building librespot from source — the first run takes 5-15 minutes"
fi

docker compose "${COMPOSE_FILES[@]}" up -d --build

say "Done"
PORT="$(sed -n 's/^PORT=//p' .env | tr -d "\"'" | head -1)"
PORT="${PORT:-8080}"
ok "guest page:  http://127.0.0.1:${PORT}/"
ok "admin:       http://127.0.0.1:${PORT}/admin"
echo
echo "    Next:"
echo "      1. Put your Spotify client id and secret in .env, then restart:"
echo "           docker compose ${COMPOSE_FILES[*]} up -d"
echo "      2. Open /admin and connect Spotify."
echo "      3. From a phone on this network, open Spotify -> Connect -> pick the"
echo "         jukebox device once, so librespot gets its credentials."
echo
echo "    Logs:  docker compose ${COMPOSE_FILES[*]} logs -f"
