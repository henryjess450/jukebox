# Jukebox app image.
#
# Two stages: a builder that compiles TypeScript and the better-sqlite3 native
# addon, and a slim runtime that carries neither a compiler nor dev deps.
#
# Node 20 to match the target box. The native addon is compiled against this
# exact Node line, so builder and runtime must stay on the same major version.

# --- builder ---------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

# better-sqlite3 has no prebuilt binary for every platform; give node-gyp what
# it needs rather than hoping for a download.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Re-resolve to production dependencies only, keeping the compiled addon.
RUN npm prune --omit=dev

# --- runtime ---------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# alsa-utils provides amixer, which the volume control shells out to.
# tini reaps zombies and forwards SIGTERM so shutdown is clean under compose.
RUN apt-get update && apt-get install -y --no-install-recommends \
      alsa-utils tini ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY public ./public

# The database lives on a volume owned by this user; see compose.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV DATABASE_PATH=/data/jukebox.db \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

# Reads PORT rather than hardcoding it, so changing the port in one place is
# enough and the health check cannot drift out of step with the app.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||8080;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
