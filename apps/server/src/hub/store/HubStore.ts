/**
 * Hub persistence (ADR-020 §6, M24-4): operators, nodes, player/pool tokens, daily usage
 * aggregates, and the placeholder tables of the portal (M24-9) and spot-checks (M24-12) — one
 * SQLite file (`node:sqlite`, WAL, like the review store of ADR-017), versioned migrations.
 *
 * Rules:
 * - **Nothing secret leaves a read API.** `OperatorRecord`, `NodeRecord` and `TokenRecord` carry no
 *   hash; the hashes are only reachable through {@link HubStore.tokenAuth}/{@link HubStore.nodeAuth},
 *   which exist for the verifier in `hub/tokens.ts`. The store never sees a plaintext secret: the
 *   token service hashes before it writes.
 * - **No IP addresses**, e-mail addresses or positions anywhere.
 * - **Operator scoping:** every read/write that the portal will expose takes an optional
 *   `{ operatorId }` scope; with one, a row of another operator behaves exactly like a missing row
 *   (the portal answers 404 for both). Without one (hub internals, administrator) it is unscoped.
 * - All methods are synchronous (SQLite in-process); callers catch errors. {@link HubStore.open}
 *   rejects with a clear message when `node:sqlite` is missing (Node < 22.13), so a hub can refuse
 *   to start (the hub cannot route `dc1_` tokens without its store).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite';
import type { TokenTier } from '@daisychess/engine-core';
import type { PoolLogger } from '../../engines/EnginePool.js';
import { loadSqlite } from '../../review/ReviewStore.js';
import { HUB_MIGRATIONS, MIGRATIONS_TABLE, type Migration } from './schema.js';

type SqliteModule = { DatabaseSync: typeof DatabaseSync };
type Row = Record<string, SQLOutputValue>;

export interface HubStoreConfig {
  /** SQLite file; its directory is created. */
  path: string;
}

export interface HubStoreOpenOptions {
  /** Loader of `node:sqlite` (tests: simulate a Node without it). */
  loadSqlite?: () => Promise<SqliteModule | null>;
  /** Migrations to apply (tests); default {@link HUB_MIGRATIONS}. */
  migrations?: readonly Migration[];
}

/** Restricts a query to the rows of one operator. Omitted: unscoped (hub, administrator). */
export interface Scope {
  operatorId?: string;
}

/** `last_used_at` / `last_seen_at` are rewritten at most this often (keeps hot paths read-only). */
export const TOUCH_THROTTLE_MS = 5 * 60_000;

export const TOKEN_RECORD_KINDS = ['player', 'pool', 'anonymous'] as const;
/** `player`: private routing (nodeIds, optional pool fallback); `pool`: pool only; `anonymous`: reserved (`POOL_ANONYMOUS`). */
export type TokenRecordKind = (typeof TOKEN_RECORD_KINDS)[number];

export const NODE_STATES = ['normal', 'suspect', 'disabled'] as const;
export type NodeState = (typeof NODE_STATES)[number];

export interface OperatorRecord {
  id: string;
  lichessId: string;
  username: string;
  admin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  disabledAt: number | null;
  deletedAt: number | null;
}

export interface NodeRecord {
  id: string;
  operatorId: string;
  name: string;
  pool: boolean;
  /** Sessions of the node donated to the pool. */
  poolShare: number;
  state: NodeState;
  suspectCount: number;
  suspectUntil: number | null;
  maxSessionsSeen: number | null;
  lastVersion: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  /** While set and in the future, the previous credential is still accepted (rotation overlap). */
  prevExpiresAt: number | null;
}

export interface TokenRecord {
  id: string;
  /** Null only for the synthetic legacy `ACCESS_TOKEN` record (never stored). */
  operatorId: string | null;
  kind: TokenRecordKind;
  label: string;
  /** Ordered preference of private nodes; empty for a pool token. */
  nodeIds: string[];
  poolFallback: boolean;
  tier: TokenTier;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface UsageRow {
  /** UTC day `YYYY-MM-DD`. */
  day: string;
  tokenId: string;
  /** `''` when not attributed to a node. */
  nodeId: string;
  sessions: number;
  searches: number;
  engineMs: number;
}

/** Credential material of a token, for the verifier only. */
export interface TokenAuth {
  record: TokenRecord;
  secretHash: string;
  operatorDisabled: boolean;
}

/** Credential material of a node, for the verifier only. */
export interface NodeAuth {
  record: NodeRecord;
  secretHash: string;
  secretHashPrev: string | null;
  operatorDisabled: boolean;
}

export interface NewNodeRow {
  id: string;
  operatorId: string;
  name: string;
  secretHash: string;
  pool: boolean;
  poolShare: number;
  createdAt: number;
}

export interface NewTokenRow {
  id: string;
  operatorId: string;
  kind: TokenRecordKind;
  secretHash: string;
  label: string;
  nodeIds: readonly string[];
  poolFallback: boolean;
  tier: TokenTier;
  expiresAt: number | null;
  createdAt: number;
}

export interface NodePatch {
  name?: string;
  pool?: boolean;
  poolShare?: number;
  state?: NodeState;
}

export interface TokenPatch {
  label?: string;
  nodeIds?: readonly string[];
  poolFallback?: boolean;
  tier?: TokenTier;
  expiresAt?: number | null;
}

export interface UsageDelta {
  day: string;
  tokenId: string;
  nodeId?: string;
  sessions?: number;
  searches?: number;
  engineMs?: number;
}

/** A portal login session (cookie); only the hash of the id is stored. */
export interface PortalSessionRow {
  idHash: string;
  operatorId: string;
  createdAt: number;
  expiresAt: number;
}

export interface PurgeResult {
  usage: number;
  portalSessions: number;
  spotchecks: number;
}

/** Spot-check rows are only needed for the last 24 h (ADR-020 §6). */
export const SPOTCHECK_RETENTION_MS = 24 * 3_600_000;

const DAY_MS = 86_400_000;

/** UTC calendar day of `ms` as `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Start (ms) of the UTC day containing `ms`. */
export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

const num = (v: SQLOutputValue | undefined): number => Number(v ?? 0);
const numOrNull = (v: SQLOutputValue | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);
const strOrNull = (v: SQLOutputValue | undefined): string | null =>
  v === null || v === undefined ? null : String(v);

function parseNodeIds(raw: SQLOutputValue | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toOperator(r: Row): OperatorRecord {
  return {
    id: String(r.id),
    lichessId: String(r.lichess_id),
    username: String(r.username),
    admin: num(r.admin) === 1,
    createdAt: num(r.created_at),
    lastLoginAt: numOrNull(r.last_login_at),
    disabledAt: numOrNull(r.disabled_at),
    deletedAt: numOrNull(r.deleted_at),
  };
}

function toNode(r: Row): NodeRecord {
  return {
    id: String(r.id),
    operatorId: String(r.operator_id),
    name: String(r.name),
    pool: num(r.pool) === 1,
    poolShare: num(r.pool_share),
    state: String(r.state) as NodeState,
    suspectCount: num(r.suspect_count),
    suspectUntil: numOrNull(r.suspect_until),
    maxSessionsSeen: numOrNull(r.max_sessions_seen),
    lastVersion: strOrNull(r.last_version),
    createdAt: num(r.created_at),
    lastSeenAt: numOrNull(r.last_seen_at),
    revokedAt: numOrNull(r.revoked_at),
    prevExpiresAt: numOrNull(r.prev_expires_at),
  };
}

function toToken(r: Row): TokenRecord {
  return {
    id: String(r.id),
    operatorId: String(r.operator_id),
    kind: String(r.kind) as TokenRecordKind,
    label: String(r.label),
    nodeIds: parseNodeIds(r.node_ids),
    poolFallback: num(r.pool_fallback) === 1,
    tier: String(r.tier) as TokenTier,
    expiresAt: numOrNull(r.expires_at),
    revokedAt: numOrNull(r.revoked_at),
    createdAt: num(r.created_at),
    lastUsedAt: numOrNull(r.last_used_at),
  };
}

/** Columns of the public records (no hashes). */
const NODE_COLS = `id, operator_id, name, pool, pool_share, state, suspect_count, suspect_until,
  max_sessions_seen, last_version, created_at, last_seen_at, revoked_at, prev_expires_at`;
const TOKEN_COLS = `id, operator_id, kind, label, node_ids, pool_fallback, tier, expires_at,
  revoked_at, created_at, last_used_at`;
const OPERATOR_COLS = `id, lichess_id, username, admin, created_at, last_login_at, disabled_at,
  deleted_at`;

const b = (v: boolean): number => (v ? 1 : 0);

export class HubStore {
  private readonly stmts: Record<string, StatementSync> = {};
  private closed = false;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly cfg: HubStoreConfig,
  ) {}

  /**
   * Opens (creating directory and file) the store and applies pending migrations. Rejects when
   * `node:sqlite` is unavailable, the file cannot be opened, a migration fails (rolled back) or
   * the file was written by a newer schema.
   */
  static async open(
    cfg: HubStoreConfig,
    log: PoolLogger,
    opts: HubStoreOpenOptions = {},
  ): Promise<HubStore> {
    const sqlite = await (opts.loadSqlite ?? loadSqlite)();
    if (!sqlite) {
      throw new Error(
        `hub store: node:sqlite is not available (Node >= 22.13 required, running ${process.version})`,
      );
    }
    mkdirSync(path.dirname(cfg.path), { recursive: true });
    const db = new sqlite.DatabaseSync(cfg.path);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA busy_timeout = 5000');
      const applied = migrate(db, opts.migrations ?? HUB_MIGRATIONS);
      const store = new HubStore(db, cfg);
      log.info(
        { path: cfg.path, schemaVersion: store.schemaVersion(), applied },
        'hub store opened',
      );
      return store;
    } catch (err) {
      db.close();
      throw err;
    }
  }

  get path(): string {
    return this.cfg.path;
  }

  /** Highest applied migration version (0 for an empty file). */
  schemaVersion(): number {
    return num(this.stmt('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get()?.v);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ---------------------------------------------------------------------------------- operators

  /**
   * Login (M24-9): creates the operator of `lichessId` or updates its username and
   * `last_login_at`. `newId` is used only when the row is created.
   */
  upsertOperator(
    input: { lichessId: string; username: string; newId: string },
    now: number,
  ): OperatorRecord {
    this.stmt(
      `INSERT INTO operators (id, lichess_id, username, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(lichess_id) DO UPDATE SET username = excluded.username,
         last_login_at = excluded.last_login_at`,
    ).run(input.newId, input.lichessId, input.username, now, now);
    return this.getOperatorByLichessId(input.lichessId) as OperatorRecord;
  }

  getOperator(id: string): OperatorRecord | undefined {
    const r = this.stmt(`SELECT ${OPERATOR_COLS} FROM operators WHERE id = ?`).get(id);
    return r ? toOperator(r) : undefined;
  }

  getOperatorByLichessId(lichessId: string): OperatorRecord | undefined {
    const r = this.stmt(`SELECT ${OPERATOR_COLS} FROM operators WHERE lichess_id = ?`).get(
      lichessId,
    );
    return r ? toOperator(r) : undefined;
  }

  setOperatorAdmin(id: string, admin: boolean): boolean {
    return changed(this.stmt('UPDATE operators SET admin = ? WHERE id = ?').run(b(admin), id));
  }

  /** Ban (administrator) or lift it. A disabled operator's tokens and nodes stop verifying. */
  setOperatorDisabled(id: string, disabled: boolean, now: number): boolean {
    return changed(
      this.stmt('UPDATE operators SET disabled_at = ? WHERE id = ?').run(disabled ? now : null, id),
    );
  }

  /** Every operator (administrator view), oldest first. */
  listOperators(): OperatorRecord[] {
    return this.stmt(`SELECT ${OPERATOR_COLS} FROM operators ORDER BY created_at, id`)
      .all()
      .map(toOperator);
  }

  // ---------------------------------------------------------------------------- portal sessions

  /** Stores a portal session by the `sha256` of its id (the id itself is never stored). */
  insertPortalSession(row: PortalSessionRow): void {
    this.stmt(
      'INSERT INTO portal_sessions (id_hash, operator_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(row.idHash, row.operatorId, row.createdAt, row.expiresAt);
  }

  /** The unexpired session with this id hash. */
  getPortalSession(idHash: string, now: number): PortalSessionRow | undefined {
    const r = this.stmt(
      'SELECT id_hash, operator_id, created_at, expires_at FROM portal_sessions WHERE id_hash = ? AND expires_at > ?',
    ).get(idHash, now);
    if (!r) return undefined;
    return {
      idHash: String(r.id_hash),
      operatorId: String(r.operator_id),
      createdAt: num(r.created_at),
      expiresAt: num(r.expires_at),
    };
  }

  deletePortalSession(idHash: string): boolean {
    return changed(this.stmt('DELETE FROM portal_sessions WHERE id_hash = ?').run(idHash));
  }

  /** Ends every portal session of an operator (ban, account changes). Returns the count. */
  deletePortalSessionsOf(operatorId: string): number {
    return count(this.stmt('DELETE FROM portal_sessions WHERE operator_id = ?').run(operatorId));
  }

  // -------------------------------------------------------------------------------------- nodes

  /** Inserts a node; throws on a duplicate id (the token service retries with a new id). */
  insertNode(row: NewNodeRow): NodeRecord {
    this.stmt(
      `INSERT INTO nodes (id, operator_id, name, secret_hash, pool, pool_share, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.operatorId,
      row.name,
      row.secretHash,
      b(row.pool),
      row.poolShare,
      row.createdAt,
    );
    return this.getNode(row.id) as NodeRecord;
  }

  getNode(id: string, scope: Scope = {}): NodeRecord | undefined {
    const r = this.stmt(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`).get(id);
    if (!r || !inScope(r, scope)) return undefined;
    return toNode(r);
  }

  /** Nodes of one operator, or all nodes (unscoped), oldest first. */
  listNodes(scope: Scope = {}): NodeRecord[] {
    const rows =
      scope.operatorId === undefined
        ? this.stmt(`SELECT ${NODE_COLS} FROM nodes ORDER BY created_at, id`).all()
        : this.stmt(
            `SELECT ${NODE_COLS} FROM nodes WHERE operator_id = ? ORDER BY created_at, id`,
          ).all(scope.operatorId);
    return rows.map(toNode);
  }

  updateNode(id: string, patch: NodePatch, scope: Scope = {}): NodeRecord | undefined {
    const current = this.getNode(id, scope);
    if (!current) return undefined;
    this.stmt('UPDATE nodes SET name = ?, pool = ?, pool_share = ?, state = ? WHERE id = ?').run(
      patch.name ?? current.name,
      b(patch.pool ?? current.pool),
      patch.poolShare ?? current.poolShare,
      patch.state ?? current.state,
      id,
    );
    return this.getNode(id);
  }

  /** Replaces the credential, keeping the previous hash until `prevExpiresAt` (rotation). */
  setNodeCredential(
    id: string,
    cred: { secretHash: string; secretHashPrev: string | null; prevExpiresAt: number | null },
    scope: Scope = {},
  ): NodeRecord | undefined {
    if (!this.getNode(id, scope)) return undefined;
    this.stmt(
      'UPDATE nodes SET secret_hash = ?, secret_hash_prev = ?, prev_expires_at = ? WHERE id = ?',
    ).run(cred.secretHash, cred.secretHashPrev, cred.prevExpiresAt, id);
    return this.getNode(id);
  }

  /** Immediate revocation; idempotent (keeps the first `revoked_at`). */
  revokeNode(id: string, now: number, scope: Scope = {}): boolean {
    if (!this.getNode(id, scope)) return false;
    this.stmt(
      'UPDATE nodes SET revoked_at = COALESCE(revoked_at, ?), secret_hash_prev = NULL, prev_expires_at = NULL WHERE id = ?',
    ).run(now, id);
    return true;
  }

  /** Nodes of an operator that are not revoked (the portal's `PORTAL_MAX_NODES`). */
  countActiveNodes(operatorId: string): number {
    return num(
      this.stmt('SELECT COUNT(*) AS n FROM nodes WHERE operator_id = ? AND revoked_at IS NULL').get(
        operatorId,
      )?.n,
    );
  }

  /**
   * Deletes a node: its id is removed from every token's `node_ids` (a token left without nodes
   * routes by its pool fallback or is denied `node_offline`), spot-checks go with it (cascade).
   * Usage aggregates keep the id as a plain string. False when not found in `scope`.
   */
  deleteNode(id: string, scope: Scope = {}): boolean {
    const node = this.getNode(id, scope);
    if (!node) return false;
    this.transaction(() => {
      for (const token of this.listTokens({ operatorId: node.operatorId })) {
        if (!token.nodeIds.includes(id)) continue;
        this.stmt('UPDATE tokens SET node_ids = ? WHERE id = ?').run(
          JSON.stringify(token.nodeIds.filter((n) => n !== id)),
          token.id,
        );
      }
      this.stmt('DELETE FROM nodes WHERE id = ?').run(id);
    });
    return true;
  }

  /**
   * Records a sign of life of a node link (M24-5). Writes at most every
   * {@link TOUCH_THROTTLE_MS}, except when the reported version or session count changed.
   * Returns whether a row was written.
   */
  markNodeSeen(
    id: string,
    now: number,
    info: { version?: string; maxSessions?: number } = {},
  ): boolean {
    return changed(
      this.stmt(
        `UPDATE nodes SET last_seen_at = ?,
           last_version = COALESCE(?, last_version),
           max_sessions_seen = COALESCE(?, max_sessions_seen)
         WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at <= ?
           OR (? IS NOT NULL AND last_version IS NOT ?)
           OR (? IS NOT NULL AND max_sessions_seen IS NOT ?))`,
      ).run(
        now,
        info.version ?? null,
        info.maxSessions ?? null,
        id,
        now - TOUCH_THROTTLE_MS,
        info.version ?? null,
        info.version ?? null,
        info.maxSessions ?? null,
        info.maxSessions ?? null,
      ),
    );
  }

  /** Credential material for the verifier (`hub/tokens.ts`); not for any read API. */
  nodeAuth(id: string): NodeAuth | undefined {
    const r = this.stmt(
      `SELECT ${NODE_COLS.replace(/(\w+)/g, 'n.$1')}, n.secret_hash, n.secret_hash_prev,
         o.disabled_at AS operator_disabled_at
       FROM nodes n JOIN operators o ON o.id = n.operator_id WHERE n.id = ?`,
    ).get(id);
    if (!r) return undefined;
    return {
      record: toNode(r),
      secretHash: String(r.secret_hash),
      secretHashPrev: strOrNull(r.secret_hash_prev),
      operatorDisabled: r.operator_disabled_at !== null,
    };
  }

  // ------------------------------------------------------------------------------------- tokens

  /** Inserts a token; throws on a duplicate id (the token service retries with a new id). */
  insertToken(row: NewTokenRow): TokenRecord {
    this.stmt(
      `INSERT INTO tokens (id, operator_id, kind, secret_hash, label, node_ids, pool_fallback, tier,
         expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.operatorId,
      row.kind,
      row.secretHash,
      row.label,
      JSON.stringify(row.nodeIds),
      b(row.poolFallback),
      row.tier,
      row.expiresAt,
      row.createdAt,
    );
    return this.getToken(row.id) as TokenRecord;
  }

  getToken(id: string, scope: Scope = {}): TokenRecord | undefined {
    const r = this.stmt(`SELECT ${TOKEN_COLS} FROM tokens WHERE id = ?`).get(id);
    if (!r || !inScope(r, scope)) return undefined;
    return toToken(r);
  }

  /** Tokens of one operator, or all tokens (unscoped), oldest first. */
  listTokens(scope: Scope = {}): TokenRecord[] {
    const rows =
      scope.operatorId === undefined
        ? this.stmt(`SELECT ${TOKEN_COLS} FROM tokens ORDER BY created_at, id`).all()
        : this.stmt(
            `SELECT ${TOKEN_COLS} FROM tokens WHERE operator_id = ? ORDER BY created_at, id`,
          ).all(scope.operatorId);
    return rows.map(toToken);
  }

  /** Number of live (not revoked, not expired) tokens of `kind` an operator holds. */
  countLiveTokens(operatorId: string, kind: TokenRecordKind, now: number): number {
    return num(
      this.stmt(
        `SELECT COUNT(*) AS n FROM tokens WHERE operator_id = ? AND kind = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      ).get(operatorId, kind, now)?.n,
    );
  }

  /** Live (not revoked, not expired) tokens of an operator, every kind (`PORTAL_MAX_TOKENS`). */
  countAllLiveTokens(operatorId: string, now: number): number {
    return num(
      this.stmt(
        `SELECT COUNT(*) AS n FROM tokens WHERE operator_id = ? AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > ?)`,
      ).get(operatorId, now)?.n,
    );
  }

  updateToken(id: string, patch: TokenPatch, scope: Scope = {}): TokenRecord | undefined {
    const current = this.getToken(id, scope);
    if (!current) return undefined;
    this.stmt(
      'UPDATE tokens SET label = ?, node_ids = ?, pool_fallback = ?, tier = ?, expires_at = ? WHERE id = ?',
    ).run(
      patch.label ?? current.label,
      JSON.stringify(patch.nodeIds ?? current.nodeIds),
      b(patch.poolFallback ?? current.poolFallback),
      patch.tier ?? current.tier,
      patch.expiresAt === undefined ? current.expiresAt : patch.expiresAt,
      id,
    );
    return this.getToken(id);
  }

  /** Immediate revocation; idempotent (keeps the first `revoked_at`). */
  revokeToken(id: string, now: number, scope: Scope = {}): boolean {
    if (!this.getToken(id, scope)) return false;
    this.stmt('UPDATE tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(now, id);
    return true;
  }

  /**
   * Sets `last_used_at` at most every {@link TOUCH_THROTTLE_MS} (a reconnect storm must not turn
   * every `hello` into a write). Returns whether a row was written.
   */
  touchToken(id: string, now: number): boolean {
    return changed(
      this.stmt(
        'UPDATE tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)',
      ).run(now, id, now - TOUCH_THROTTLE_MS),
    );
  }

  /** Credential material for the verifier (`hub/tokens.ts`); not for any read API. */
  tokenAuth(id: string): TokenAuth | undefined {
    const r = this.stmt(
      `SELECT ${TOKEN_COLS.replace(/(\w+)/g, 't.$1')}, t.secret_hash,
         o.disabled_at AS operator_disabled_at
       FROM tokens t JOIN operators o ON o.id = t.operator_id WHERE t.id = ?`,
    ).get(id);
    if (!r) return undefined;
    return {
      record: toToken(r),
      secretHash: String(r.secret_hash),
      operatorDisabled: r.operator_disabled_at !== null,
    };
  }

  // -------------------------------------------------------------------------------------- usage

  /** Adds to the `(day, token, node)` aggregate (creating it). Values must be ≥ 0 integers. */
  addUsage(delta: UsageDelta): void {
    const values = [delta.sessions ?? 0, delta.searches ?? 0, delta.engineMs ?? 0];
    for (const v of values) {
      if (!Number.isSafeInteger(v) || v < 0)
        throw new RangeError('usage values must be integers >= 0');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(delta.day)) throw new RangeError('day must be YYYY-MM-DD');
    this.stmt(
      `INSERT INTO usage_daily (day, token_id, node_id, sessions, searches, engine_ms)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(day, token_id, node_id) DO UPDATE SET sessions = sessions + excluded.sessions,
         searches = searches + excluded.searches, engine_ms = engine_ms + excluded.engine_ms`,
    ).run(delta.day, delta.tokenId, delta.nodeId ?? '', ...(values as SQLInputValue[]));
  }

  /** Engine time of a token on one UTC day, summed over its nodes. */
  engineMsOn(tokenId: string, day: string): number {
    return num(
      this.stmt(
        'SELECT COALESCE(SUM(engine_ms), 0) AS ms FROM usage_daily WHERE token_id = ? AND day = ?',
      ).get(tokenId, day)?.ms,
    );
  }

  /** Usage rows from `sinceDay` (inclusive), optionally of some tokens or nodes only. */
  listUsage(filter: {
    sinceDay: string;
    tokenIds?: readonly string[];
    nodeIds?: readonly string[];
  }): UsageRow[] {
    const where = ['day >= ?'];
    const params: SQLInputValue[] = [filter.sinceDay];
    for (const [col, ids] of [
      ['token_id', filter.tokenIds],
      ['node_id', filter.nodeIds],
    ] as const) {
      if (ids === undefined) continue;
      if (ids.length === 0) return [];
      where.push(`${col} IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    }
    return this.db
      .prepare(
        `SELECT day, token_id, node_id, sessions, searches, engine_ms FROM usage_daily
         WHERE ${where.join(' AND ')} ORDER BY day, token_id, node_id`,
      )
      .all(...params)
      .map((r) => ({
        day: String(r.day),
        tokenId: String(r.token_id),
        nodeId: String(r.node_id),
        sessions: num(r.sessions),
        searches: num(r.searches),
        engineMs: num(r.engine_ms),
      }));
  }

  /**
   * Retention: usage aggregates older than `usageRetentionDays` full UTC days (the current day is
   * day 1), expired portal sessions, spot-checks older than 24 h.
   */
  purgeExpired(now: number, usageRetentionDays: number): PurgeResult {
    if (!Number.isInteger(usageRetentionDays) || usageRetentionDays < 1) {
      throw new RangeError('usageRetentionDays must be an integer >= 1');
    }
    const cutoffDay = utcDay(utcDayStart(now) - (usageRetentionDays - 1) * DAY_MS);
    let result: PurgeResult = { usage: 0, portalSessions: 0, spotchecks: 0 };
    this.transaction(() => {
      result = {
        usage: count(this.stmt('DELETE FROM usage_daily WHERE day < ?').run(cutoffDay)),
        portalSessions: count(
          this.stmt('DELETE FROM portal_sessions WHERE expires_at <= ?').run(now),
        ),
        spotchecks: count(
          this.stmt('DELETE FROM spotchecks WHERE at < ?').run(now - SPOTCHECK_RETENTION_MS),
        ),
      };
    });
    return result;
  }

  // ------------------------------------------------------------------------------------ helpers

  private stmt(sql: string): StatementSync {
    let s = this.stmts[sql];
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts[sql] = s;
    }
    return s;
  }

  /** Runs `fn` in one immediate transaction (rolled back on a throw). */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

function inScope(r: Row, scope: Scope): boolean {
  return scope.operatorId === undefined || String(r.operator_id) === scope.operatorId;
}

function count(res: { changes: number | bigint }): number {
  return Number(res.changes);
}

function changed(res: { changes: number | bigint }): boolean {
  return Number(res.changes) > 0;
}

/**
 * Applies every migration above the recorded version, each in its own transaction. Returns the
 * versions applied. Throws when the file is newer than the known migrations or a migration fails.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): number[] {
  const sorted = [...migrations].sort((x, y) => x.version - y.version);
  sorted.forEach((m, i) => {
    if (!Number.isInteger(m.version) || m.version !== i + 1) {
      throw new Error('hub store: migrations must be numbered 1, 2, 3, … without gaps');
    }
  });
  db.exec(MIGRATIONS_TABLE);
  const current = num(
    db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get()?.v,
  );
  const latest = sorted.length;
  if (current > latest) {
    throw new Error(
      `hub store: schema version ${current} is newer than this server supports (${latest}); refusing to open`,
    );
  }
  const applied: number[] = [];
  for (const m of sorted) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(
        `hub store: migration ${m.version} (${m.name}) failed: ${(err as Error).message}`,
      );
    }
    applied.push(m.version);
  }
  return applied;
}
