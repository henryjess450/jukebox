-- Jukebox schema. Applied idempotently at boot by src/db/index.ts.

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,          -- JSON-encoded scalar
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,

  track_uri           TEXT NOT NULL,  -- spotify:track:...
  track_id            TEXT NOT NULL,
  track_name          TEXT NOT NULL,
  artist_name         TEXT NOT NULL,
  album_name          TEXT NOT NULL,
  album_art_url       TEXT,
  duration_ms         INTEGER NOT NULL,
  explicit            INTEGER NOT NULL DEFAULT 0,

  session_id          TEXT NOT NULL,  -- browser cookie identity
  ip_hash             TEXT NOT NULL,  -- salted hash; we never store raw IPs

  -- pending_payment -> queued -> playing -> played
  --                 \-> failed / refunded / cancelled
  state               TEXT NOT NULL,

  -- Ordering within the queue. Sparse (gaps of 1000) so a reorder is a single
  -- UPDATE rather than a rewrite of every following row.
  position            REAL,

  amount_cents        INTEGER NOT NULL DEFAULT 0,
  currency            TEXT NOT NULL DEFAULT 'CAD',
  stripe_session_id   TEXT UNIQUE,
  stripe_payment_intent TEXT,
  refund_id           TEXT,

  failure_reason      TEXT,

  created_at          TEXT NOT NULL,
  paid_at             TEXT,
  queued_at           TEXT,
  pushed_at           TEXT,           -- when handed to Spotify's queue
  started_at          TEXT,
  finished_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_state_position ON requests (state, position);
CREATE INDEX IF NOT EXISTS idx_requests_session ON requests (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_created ON requests (created_at);
CREATE INDEX IF NOT EXISTS idx_requests_track_state ON requests (track_uri, state);

CREATE TABLE IF NOT EXISTS blocklist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,          -- 'track' | 'artist'
  spotify_id  TEXT NOT NULL,
  label       TEXT NOT NULL,          -- human-readable, for the admin table
  created_at  TEXT NOT NULL,
  UNIQUE (kind, spotify_id)
);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  request_id  INTEGER REFERENCES requests (id),
  detail      TEXT,                   -- JSON object
  actor       TEXT NOT NULL DEFAULT 'system'  -- 'system' | 'admin' | 'guest'
);

CREATE INDEX IF NOT EXISTS idx_events_at ON events (at);

-- Spotify OAuth tokens. Exactly one row (id = 1). Refresh token is a secret,
-- but it must survive restarts and is scoped to this box, so it lives here.
CREATE TABLE IF NOT EXISTS spotify_auth (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  scope          TEXT NOT NULL,
  account_name   TEXT,
  updated_at     TEXT NOT NULL
);
