/**
 * Versioned, forward-only schema of the hub store (ADR-020 §6). Each migration runs once, in its
 * own transaction, and is recorded in `schema_migrations`; a database written by a newer server
 * (a version above the last one known here) is refused instead of being guessed at.
 *
 * Privacy: no table has an IP address, e-mail address, position or secret. Secrets are stored as
 * `sha256` hex of the secret part of a token (`secret_hash`), portal session ids likewise.
 */
export interface Migration {
  version: number;
  /** Short name, recorded with the version. */
  name: string;
  sql: string;
}

const V1 = `
CREATE TABLE operators (
  id            TEXT PRIMARY KEY,
  lichess_id    TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  admin         INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER,
  disabled_at   INTEGER,
  deleted_at    INTEGER
);

CREATE TABLE nodes (
  id                TEXT PRIMARY KEY,
  operator_id       TEXT NOT NULL REFERENCES operators(id),
  name              TEXT NOT NULL,
  secret_hash       TEXT NOT NULL,
  secret_hash_prev  TEXT,
  prev_expires_at   INTEGER,
  pool              INTEGER NOT NULL DEFAULT 0,
  pool_share        INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL DEFAULT 'normal' CHECK (state IN ('normal', 'suspect', 'disabled')),
  suspect_count     INTEGER NOT NULL DEFAULT 0,
  suspect_until     INTEGER,
  max_sessions_seen INTEGER,
  last_version      TEXT,
  created_at        INTEGER NOT NULL,
  last_seen_at      INTEGER,
  revoked_at        INTEGER
);
CREATE INDEX nodes_operator ON nodes(operator_id);

CREATE TABLE tokens (
  id            TEXT PRIMARY KEY,
  operator_id   TEXT NOT NULL REFERENCES operators(id),
  kind          TEXT NOT NULL CHECK (kind IN ('player', 'pool', 'anonymous')),
  secret_hash   TEXT NOT NULL,
  label         TEXT NOT NULL DEFAULT '',
  node_ids      TEXT NOT NULL DEFAULT '[]',
  pool_fallback INTEGER NOT NULL DEFAULT 0,
  tier          TEXT NOT NULL CHECK (tier IN ('small', 'standard', 'full')),
  expires_at    INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX tokens_operator ON tokens(operator_id);

CREATE TABLE usage_daily (
  day       TEXT NOT NULL,
  token_id  TEXT NOT NULL,
  node_id   TEXT NOT NULL DEFAULT '',
  sessions  INTEGER NOT NULL DEFAULT 0,
  searches  INTEGER NOT NULL DEFAULT 0,
  engine_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, token_id, node_id)
);
CREATE INDEX usage_daily_token ON usage_daily(token_id, day);

CREATE TABLE portal_sessions (
  id_hash     TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX portal_sessions_expiry ON portal_sessions(expires_at);

CREATE TABLE spotchecks (
  id      INTEGER PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  agreed  INTEGER NOT NULL
);
CREATE INDEX spotchecks_node ON spotchecks(node_id, at);
`;

/**
 * M24-12: permanent pool exclusion after repeated spot-check failures. Distinct from `state`
 * (`disabled` stops the node entirely; a pool ban keeps the link and private tokens working)
 * and from `pool` (the operator's own setting, which cannot lift the ban).
 */
const V2 = `
ALTER TABLE nodes ADD COLUMN pool_banned_at INTEGER;
ALTER TABLE nodes ADD COLUMN pool_ban_reason TEXT;
`;

export const HUB_MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'initial', sql: V1 },
  { version: 2, name: 'pool ban', sql: V2 },
]);

/** Bookkeeping table; created outside the versioned migrations. */
export const MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
`;
