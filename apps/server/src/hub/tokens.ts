/**
 * Hub token service (ADR-020 §2, M24-2 clarifications, M24-4): minting, verification, rotation
 * and revocation of player/pool tokens (`dc1_`) and node credentials (`dcn_`), the legacy
 * `ACCESS_TOKEN` route, and the daily engine-time budget of pool tokens (owner answer 4).
 *
 * - A secret is generated here (160 random bits), returned **once** inside the plaintext token,
 *   and stored only as `sha256(secret)` hex — the secret has full entropy, so a fast hash is the
 *   right choice (no KDF). Lookups go by the public id; the hash is compared with
 *   `timingSafeEqual` ({@link secretHashMatches}).
 * - The legacy `ACCESS_TOKEN` is never stored: a matching `hello.token` (constant-time,
 *   `tokenMatches` of ADR-010) yields a synthetic `full`-tier token bound to node `local`.
 * - Token format parsing is `@daisychess/engine-core` (`parseToken`, `isLegacyToken`,
 *   `formatToken`); nothing here re-implements it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  TOKEN_ID_LENGTH,
  TOKEN_PATTERNS,
  TOKEN_SECRET_LENGTH,
  TOKEN_TIERS,
  formatToken,
  hasReservedPrefix,
  isLegacyToken,
  parseToken,
  type TokenTier,
} from '@daisychess/engine-core';
import { tokenMatches } from '../ws/token.js';
import { cryptoRandom, randomBase32, type RandomSource } from './store/ids.js';
import {
  NODE_STATES,
  utcDay,
  utcDayStart,
  type HubStore,
  type NodeState,
  type NodeRecord,
  type OperatorRecord,
  type Scope,
  type TokenRecord,
  type TokenRecordKind,
} from './store/HubStore.js';

/** `tokenId` of the synthetic legacy token (logs: `tokenId: 'legacy'`, ADR-020 §2). */
export const LEGACY_TOKEN_ID = 'legacy';
/** The hub's built-in node (its own engine pool). */
export const LOCAL_NODE_ID = 'local';
/** How long the previous node credential stays valid after a rotation. */
export const ROTATION_OVERLAP_MS = 24 * 3_600_000;
/** Default lifetime of a pool token (ADR-020 §2: pool tokens expire by default). */
export const POOL_TOKEN_DEFAULT_TTL_MS = 90 * 86_400_000;
export const MAX_TOKEN_NODE_IDS = 8;
export const MAX_LABEL_LENGTH = 64;
export const MAX_NODE_NAME_LENGTH = 32;
/** Upper bound of a node's `poolShare` (sessions), = the protocol's session bound. */
export const MAX_POOL_SHARE = 256;
/** A single `addEngineTime` call never accounts more than this (guards the day split). */
export const MAX_ENGINE_TIME_PER_CALL_MS = 2 * 86_400_000;

const DAY_MS = 86_400_000;
const ID_ATTEMPTS = 5;

export type VerifyError = 'bad_token' | 'expired' | 'revoked' | 'unknown';

export type VerifyResult =
  /** A stored `dc1_` token; `record.kind` says `player | pool | anonymous`. */
  | { kind: 'token'; record: TokenRecord }
  /** The legacy `ACCESS_TOKEN` (synthetic record, never stored). */
  | { kind: 'legacy'; record: TokenRecord }
  /** A `dcn_` node credential. */
  | { kind: 'node'; record: NodeRecord }
  | { error: VerifyError };

export type PlayerVerifyResult = Exclude<VerifyResult, { kind: 'node' }>;
export type NodeVerifyResult = Extract<VerifyResult, { kind: 'node' }> | { error: VerifyError };

/** Invalid input to a minting/management call (the portal maps `code` to 400 / 404). */
export class HubInputError extends Error {
  constructor(
    readonly code: 'invalid' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'HubInputError';
  }
}

export interface HubTokenServiceOptions {
  /** Legacy shared token (`ACCESS_TOKEN`, ADR-010), or null. Must not carry a `dc1_`/`dcn_` prefix. */
  accessToken: string | null;
  /** `POOL_DAILY_BUDGET_MIN`; 0 = no budget. */
  poolDailyBudgetMin: number;
  /** `USAGE_RETENTION_DAYS`. */
  usageRetentionDays: number;
  random?: RandomSource;
}

export interface MintTokenInput {
  operatorId: string;
  /** `player`: routed to `nodeIds` (with optional pool fallback); `pool`: pool only. */
  kind: Extract<TokenRecordKind, 'player' | 'pool'>;
  label?: string;
  nodeIds?: readonly string[];
  poolFallback?: boolean;
  /** Default `full` for player tokens, `standard` for pool tokens. */
  tier?: TokenTier;
  /** Absolute ms; undefined = default (none for player, 90 days for pool); null = never. */
  expiresAt?: number | null;
}

export interface MintNodeInput {
  operatorId: string;
  name: string;
  pool?: boolean;
  poolShare?: number;
}

/** Result of a mint/rotate: the plaintext token exists only in this object. */
export interface Minted<R> {
  token: string;
  record: R;
}

/** `sha256(secret)` as lowercase hex — the at-rest form of every secret. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Constant-time check of `secret` against a stored {@link hashSecret} value. A malformed stored
 * value (not 64 hex characters) never matches, but is still compared so the work is the same.
 */
export function secretHashMatches(secret: string, storedHex: string): boolean {
  const given = createHash('sha256').update(secret, 'utf8').digest();
  const stored = /^[0-9a-f]{64}$/.test(storedHex) ? Buffer.from(storedHex, 'hex') : null;
  const ok = timingSafeEqual(given, stored ?? Buffer.alloc(given.length));
  return ok && stored !== null;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Trims and collapses whitespace; strips control characters. */
function normaliseText(raw: string): string {
  return raw.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
}

function isUniqueIdViolation(err: unknown, table: string): boolean {
  return err instanceof Error && err.message.includes(`UNIQUE constraint failed: ${table}.id`);
}

export class HubTokenService {
  private readonly random: RandomSource;
  private readonly accessToken: string | null;
  private readonly legacyRecord: TokenRecord;

  constructor(
    private readonly store: HubStore,
    private readonly opts: HubTokenServiceOptions,
  ) {
    this.random = opts.random ?? cryptoRandom;
    const access = opts.accessToken === '' ? null : opts.accessToken;
    if (access !== null && hasReservedPrefix(access)) {
      // ADR-020 M24-2 clarification 6: such a token could never be told from a dc1_/dcn_ token.
      throw new TypeError('ACCESS_TOKEN must not start with dc1_ or dcn_');
    }
    this.accessToken = access;
    if (!Number.isInteger(opts.poolDailyBudgetMin) || opts.poolDailyBudgetMin < 0) {
      throw new RangeError('poolDailyBudgetMin must be an integer >= 0');
    }
    this.legacyRecord = Object.freeze({
      id: LEGACY_TOKEN_ID,
      operatorId: null,
      kind: 'player',
      label: 'ACCESS_TOKEN',
      nodeIds: Object.freeze([LOCAL_NODE_ID]) as string[],
      poolFallback: false,
      tier: 'full',
      expiresAt: null,
      revokedAt: null,
      createdAt: 0,
      lastUsedAt: null,
    }) as TokenRecord;
  }

  // -------------------------------------------------------------------------------- minting

  /** Portal login (M24-9): the operator of a lichess account, created on first login. */
  upsertOperator(
    input: { lichessId: string; username: string },
    now: number = Date.now(),
  ): OperatorRecord {
    const lichessId = input.lichessId.trim().toLowerCase();
    const username = normaliseText(input.username);
    if (!lichessId || lichessId.length > 64 || !username || username.length > 64) {
      throw new HubInputError('invalid', 'lichess id and username are required (≤ 64 characters)');
    }
    return this.withFreshId('operators', (newId) =>
      this.store.upsertOperator({ lichessId, username, newId }, now),
    );
  }

  /** Mints a player or pool token. The returned `token` is the only copy of the secret. */
  mintToken(input: MintTokenInput, now: number = Date.now()): Minted<TokenRecord> {
    const operator = this.liveOperator(input.operatorId);
    if (input.kind !== 'player' && input.kind !== 'pool') {
      throw new HubInputError('invalid', 'kind must be player or pool');
    }
    const tier = input.tier ?? (input.kind === 'pool' ? 'standard' : 'full');
    if (!TOKEN_TIERS.includes(tier)) throw new HubInputError('invalid', 'unknown tier');
    const label = normaliseText(input.label ?? '');
    if (label.length > MAX_LABEL_LENGTH) {
      throw new HubInputError('invalid', `label must be at most ${MAX_LABEL_LENGTH} characters`);
    }
    const nodeIds = this.checkNodeIds(input.nodeIds ?? [], operator.id, operator.admin);
    let poolFallback = input.poolFallback ?? false;
    if (input.kind === 'pool') {
      if (nodeIds.length > 0) throw new HubInputError('invalid', 'a pool token lists no nodes');
      poolFallback = false;
    } else if (nodeIds.length === 0) {
      throw new HubInputError(
        'invalid',
        'a player token needs at least one node (or use a pool token)',
      );
    }
    let expiresAt: number | null;
    if (input.expiresAt === undefined) {
      expiresAt = input.kind === 'pool' ? now + POOL_TOKEN_DEFAULT_TTL_MS : null;
    } else {
      expiresAt = input.expiresAt;
      if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now)) {
        throw new HubInputError('invalid', 'expiresAt must lie in the future');
      }
    }
    const secret = randomBase32(TOKEN_SECRET_LENGTH, this.random);
    const secretHash = hashSecret(secret);
    const record = this.withFreshId('tokens', (id) =>
      this.store.insertToken({
        id,
        operatorId: operator.id,
        kind: input.kind,
        secretHash,
        label,
        nodeIds,
        poolFallback,
        tier,
        expiresAt,
        createdAt: now,
      }),
    );
    return { token: formatToken('player', record.id, secret), record };
  }

  /** Creates a node and its `dcn_` credential. The returned `token` is the only copy. */
  mintNode(input: MintNodeInput, now: number = Date.now()): Minted<NodeRecord> {
    const operator = this.liveOperator(input.operatorId);
    const name = this.checkNodeName(input.name);
    const poolShare = this.checkPoolShare(input.poolShare ?? 0);
    const secret = randomBase32(TOKEN_SECRET_LENGTH, this.random);
    const secretHash = hashSecret(secret);
    const record = this.withFreshId('nodes', (id) =>
      this.store.insertNode({
        id,
        operatorId: operator.id,
        name,
        secretHash,
        pool: input.pool ?? false,
        poolShare,
        createdAt: now,
      }),
    );
    return { token: formatToken('node', record.id, secret), record };
  }

  /**
   * Issues a new node credential; the current one stays valid for {@link ROTATION_OVERLAP_MS}
   * (only the immediately previous one: rotating twice drops the oldest). Undefined when the node
   * does not exist in `scope`; a revoked node cannot be rotated.
   */
  rotateNodeCredential(
    nodeId: string,
    now: number = Date.now(),
    scope: Scope = {},
  ): Minted<NodeRecord> | undefined {
    const auth = this.store.nodeAuth(nodeId);
    if (!auth || (scope.operatorId !== undefined && auth.record.operatorId !== scope.operatorId)) {
      return undefined;
    }
    if (auth.record.revokedAt !== null) throw new HubInputError('invalid', 'node is revoked');
    const secret = randomBase32(TOKEN_SECRET_LENGTH, this.random);
    const record = this.store.setNodeCredential(nodeId, {
      secretHash: hashSecret(secret),
      secretHashPrev: auth.secretHash,
      prevExpiresAt: now + ROTATION_OVERLAP_MS,
    }) as NodeRecord;
    return { token: formatToken('node', nodeId, secret), record };
  }

  /**
   * Portal edit of a node (rename, pool switch, pool share), validated like {@link mintNode}.
   * Undefined when the node does not exist in `scope`; a revoked node cannot be edited.
   */
  updateNode(
    id: string,
    patch: { name?: string; pool?: boolean; poolShare?: number },
    scope: Scope = {},
  ): NodeRecord | undefined {
    const node = this.store.getNode(id, scope);
    if (!node) return undefined;
    if (node.revokedAt !== null) throw new HubInputError('invalid', 'node is revoked');
    const next: { name?: string; pool?: boolean; poolShare?: number } = {};
    if (patch.name !== undefined) next.name = this.checkNodeName(patch.name);
    if (patch.pool !== undefined) next.pool = patch.pool;
    if (patch.poolShare !== undefined) next.poolShare = this.checkPoolShare(patch.poolShare);
    return this.store.updateNode(id, next, scope);
  }

  /**
   * Portal edit of a player/pool token (label, nodes, pool fallback, tier, expiry) without
   * re-issuing it (ADR-020 §2), validated like {@link mintToken}. Undefined when the token does
   * not exist in `scope`; a revoked token cannot be edited.
   */
  updateToken(
    id: string,
    patch: {
      label?: string;
      nodeIds?: readonly string[];
      poolFallback?: boolean;
      tier?: TokenTier;
      expiresAt?: number | null;
    },
    now: number = Date.now(),
    scope: Scope = {},
  ): TokenRecord | undefined {
    const token = this.store.getToken(id, scope);
    if (!token || token.operatorId === null) return undefined;
    if (token.revokedAt !== null) throw new HubInputError('invalid', 'token is revoked');
    const operator = this.liveOperator(token.operatorId);
    const next: {
      label?: string;
      nodeIds?: string[];
      poolFallback?: boolean;
      tier?: TokenTier;
      expiresAt?: number | null;
    } = {};
    if (patch.label !== undefined) {
      const label = normaliseText(patch.label);
      if (label.length > MAX_LABEL_LENGTH) {
        throw new HubInputError('invalid', `label must be at most ${MAX_LABEL_LENGTH} characters`);
      }
      next.label = label;
    }
    if (patch.tier !== undefined) {
      if (!TOKEN_TIERS.includes(patch.tier)) throw new HubInputError('invalid', 'unknown tier');
      next.tier = patch.tier;
    }
    if (patch.nodeIds !== undefined) {
      next.nodeIds = this.checkNodeIds(patch.nodeIds, operator.id, operator.admin);
    }
    if (patch.poolFallback !== undefined) next.poolFallback = patch.poolFallback;
    if (token.kind === 'pool') {
      if ((next.nodeIds?.length ?? 0) > 0) {
        throw new HubInputError('invalid', 'a pool token lists no nodes');
      }
      if (next.poolFallback)
        throw new HubInputError('invalid', 'a pool token has no pool fallback');
    } else if (next.nodeIds !== undefined && next.nodeIds.length === 0) {
      throw new HubInputError('invalid', 'a player token needs at least one node');
    }
    if (patch.expiresAt !== undefined) {
      if (
        patch.expiresAt !== null &&
        (!Number.isSafeInteger(patch.expiresAt) || patch.expiresAt <= now)
      ) {
        throw new HubInputError('invalid', 'expiresAt must lie in the future');
      }
      next.expiresAt = patch.expiresAt;
    }
    return this.store.updateToken(id, next, scope);
  }

  /** Administrator: node state `normal | suspect | disabled` (a disabled node stops verifying). */
  setNodeState(id: string, state: NodeState): NodeRecord | undefined {
    if (!NODE_STATES.includes(state)) throw new HubInputError('invalid', 'unknown node state');
    return this.store.updateNode(id, { state });
  }

  /** Deletes a node (see `HubStore.deleteNode`); its credential dies with the row. */
  deleteNode(id: string, scope: Scope = {}): boolean {
    return this.store.deleteNode(id, scope);
  }

  revokeToken(id: string, now: number = Date.now(), scope: Scope = {}): boolean {
    return this.store.revokeToken(id, now, scope);
  }

  /** Revokes a node; the previous credential of a pending rotation dies with it. */
  revokeNode(id: string, now: number = Date.now(), scope: Scope = {}): boolean {
    return this.store.revokeNode(id, now, scope);
  }

  // ---------------------------------------------------------------------------- verification

  /**
   * Verifies any token. Order: format → lookup by public id (`unknown`) → constant-time secret
   * check (`bad_token`, before anything about the row's state is revealed) → `revoked` (token,
   * node, operator ban, disabled node) → `expired`. A verified player/pool token gets its
   * `last_used_at` touched (throttled).
   */
  verify(raw: unknown, now: number = Date.now()): VerifyResult {
    if (typeof raw !== 'string' || raw.length === 0) return { error: 'bad_token' };
    if (isLegacyToken(raw)) return this.verifyLegacy(raw);
    const parsed = parseToken(raw);
    if (!parsed) return { error: 'bad_token' };
    return parsed.kind === 'player'
      ? this.verifyStoredToken(parsed.id, parsed.secret, now)
      : this.verifyNode(parsed.id, parsed.secret, now);
  }

  /** {@link verify} for `hello.token`: a node credential is `bad_token` there. */
  verifyPlayerToken(raw: unknown, now: number = Date.now()): PlayerVerifyResult {
    const r = this.verify(raw, now);
    return 'kind' in r && r.kind === 'node' ? { error: 'bad_token' } : (r as PlayerVerifyResult);
  }

  /** {@link verify} for `node.hello.nodeToken`: only `dcn_` credentials. */
  verifyNodeToken(raw: unknown, now: number = Date.now()): NodeVerifyResult {
    const parsed = parseToken(raw);
    if (!parsed || parsed.kind !== 'node') return { error: 'bad_token' };
    return this.verifyNode(parsed.id, parsed.secret, now);
  }

  /** The synthetic legacy record (for routing code and tests); never stored. */
  get legacyToken(): TokenRecord {
    return this.legacyRecord;
  }

  private verifyLegacy(raw: string): VerifyResult {
    if (this.accessToken === null) return { error: 'bad_token' };
    return tokenMatches(raw, this.accessToken)
      ? { kind: 'legacy', record: this.legacyRecord }
      : { error: 'bad_token' };
  }

  private verifyStoredToken(id: string, secret: string, now: number): VerifyResult {
    const auth = this.store.tokenAuth(id);
    if (!auth) {
      // Same hashing work as for a known id; the id itself is public, so this is hygiene.
      secretHashMatches(secret, '');
      return { error: 'unknown' };
    }
    if (!secretHashMatches(secret, auth.secretHash)) return { error: 'bad_token' };
    const { record } = auth;
    if (record.revokedAt !== null || auth.operatorDisabled) return { error: 'revoked' };
    if (record.expiresAt !== null && record.expiresAt <= now) return { error: 'expired' };
    if (this.store.touchToken(id, now)) record.lastUsedAt = now;
    return { kind: 'token', record };
  }

  private verifyNode(id: string, secret: string, now: number): NodeVerifyResult {
    const auth = this.store.nodeAuth(id);
    if (!auth) {
      secretHashMatches(secret, '');
      return { error: 'unknown' };
    }
    // Both comparisons always run: which credential matched must not show in the timing.
    const current = secretHashMatches(secret, auth.secretHash);
    const prevValid =
      auth.secretHashPrev !== null &&
      auth.record.prevExpiresAt !== null &&
      auth.record.prevExpiresAt > now;
    const previous = secretHashMatches(secret, auth.secretHashPrev ?? '') && prevValid;
    if (!current && !previous) return { error: 'bad_token' };
    const { record } = auth;
    if (record.revokedAt !== null || record.state === 'disabled' || auth.operatorDisabled) {
      return { error: 'revoked' };
    }
    return { kind: 'node', record };
  }

  // ---------------------------------------------------------------------------------- budget

  /**
   * Accounts `ms` of engine time that ended at `now` (a search's `bestmove`), split across UTC
   * days when the search straddled midnight, and counts one search on the day it ended. Applies
   * to every token (usage statistics); the budget only reads it for pool tokens.
   */
  addEngineTime(tokenId: string, ms: number, opts: { nodeId?: string; now?: number } = {}): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('ms must be a finite number >= 0');
    const end = opts.now ?? Date.now();
    const total = Math.min(Math.round(ms), MAX_ENGINE_TIME_PER_CALL_MS);
    const nodeId = opts.nodeId ?? '';
    this.store.transaction(() => {
      if (total === 0) {
        this.store.addUsage({ day: utcDay(end), tokenId, nodeId, searches: 1 });
        return;
      }
      // Forward over [end - total, end), one segment per UTC day.
      for (let t = end - total; t < end;) {
        const segEnd = Math.min(utcDayStart(t) + DAY_MS, end);
        this.store.addUsage({
          day: utcDay(t),
          tokenId,
          nodeId,
          searches: segEnd === end ? 1 : 0,
          engineMs: segEnd - t,
        });
        t = segEnd;
      }
    });
  }

  /** Counts one opened engine session (`client.open` / `session` on a node) for usage. */
  recordSession(tokenId: string, nodeId: string, now: number = Date.now()): void {
    this.store.addUsage({ day: utcDay(now), tokenId, nodeId, sessions: 1 });
  }

  /** The daily budget in ms, or null when off (`POOL_DAILY_BUDGET_MIN=0`). */
  get dailyBudgetMs(): number | null {
    return this.opts.poolDailyBudgetMin === 0 ? null : this.opts.poolDailyBudgetMin * 60_000;
  }

  /**
   * Engine time left today (UTC) for a pool token, ≥ 0. Null = no budget applies (budget off,
   * player token, legacy token). An unknown token has 0 (fail closed).
   */
  remainingBudgetMs(tokenId: string, now: number = Date.now()): number | null {
    const budget = this.dailyBudgetMs;
    if (budget === null || tokenId === LEGACY_TOKEN_ID) return null;
    const token = this.store.getToken(tokenId);
    if (!token) return 0;
    if (token.kind === 'player') return null;
    return Math.max(0, budget - this.store.engineMsOn(tokenId, utcDay(now)));
  }

  /**
   * Engine time left today (UTC) for a connection routed **through the pool** (ADR-020
   * implementation notes M24-3/4: the budget applies to pool tokens and to player tokens while
   * they use the pool via `poolFallback`), ≥ 0. A pool token: as {@link remainingBudgetMs}. A
   * player token: the budget minus today's engine time on nodes it does not list (its pool use;
   * time on its own nodes is free). Null = no budget (off, legacy). Unknown token: 0.
   */
  remainingPoolBudgetMs(tokenId: string, now: number = Date.now()): number | null {
    const budget = this.dailyBudgetMs;
    if (budget === null || tokenId === LEGACY_TOKEN_ID) return null;
    const token = this.store.getToken(tokenId);
    if (!token) return 0;
    if (token.kind !== 'player') return this.remainingBudgetMs(tokenId, now);
    const own = new Set(token.nodeIds);
    const day = utcDay(now);
    let used = 0;
    for (const row of this.store.listUsage({ sinceDay: day, tokenIds: [tokenId] })) {
      if (row.day === day && !own.has(row.nodeId)) used += row.engineMs;
    }
    return Math.max(0, budget - used);
  }

  /** Retention (`USAGE_RETENTION_DAYS`) plus the other expiring rows; see `HubStore.purgeExpired`. */
  purge(now: number = Date.now()): ReturnType<HubStore['purgeExpired']> {
    return this.store.purgeExpired(now, this.opts.usageRetentionDays);
  }

  // --------------------------------------------------------------------------------- helpers

  private liveOperator(operatorId: string): { id: string; admin: boolean } {
    const op = this.store.getOperator(operatorId);
    if (!op || op.deletedAt !== null) throw new HubInputError('not_found', 'operator not found');
    if (op.disabledAt !== null) throw new HubInputError('invalid', 'operator is disabled');
    return op;
  }

  private checkNodeIds(ids: readonly string[], operatorId: string, admin: boolean): string[] {
    if (ids.length > MAX_TOKEN_NODE_IDS) {
      throw new HubInputError('invalid', `at most ${MAX_TOKEN_NODE_IDS} nodes per token`);
    }
    if (new Set(ids).size !== ids.length) throw new HubInputError('invalid', 'duplicate node id');
    for (const id of ids) {
      if (id === LOCAL_NODE_ID) {
        // The built-in node belongs to the hub administrator.
        if (!admin) throw new HubInputError('not_found', `node ${id} not found`);
        continue;
      }
      if (!TOKEN_PATTERNS.id.test(id)) throw new HubInputError('invalid', 'malformed node id');
      const node = this.store.getNode(id, { operatorId });
      if (!node || node.revokedAt !== null) {
        throw new HubInputError('not_found', `node ${id} not found`);
      }
    }
    return [...ids];
  }

  private checkNodeName(raw: string): string {
    const name = normaliseText(raw);
    if (name.length === 0 || name.length > MAX_NODE_NAME_LENGTH) {
      throw new HubInputError('invalid', `name must be 1–${MAX_NODE_NAME_LENGTH} characters`);
    }
    return name;
  }

  private checkPoolShare(share: number): number {
    if (!Number.isInteger(share) || share < 0 || share > MAX_POOL_SHARE) {
      throw new HubInputError('invalid', `poolShare must be an integer 0–${MAX_POOL_SHARE}`);
    }
    return share;
  }

  /** Runs `insert` with fresh random ids until one is not taken (40-bit ids rarely collide). */
  private withFreshId<R>(table: 'tokens' | 'nodes' | 'operators', insert: (id: string) => R): R {
    for (let attempt = 1; ; attempt++) {
      const id = randomBase32(TOKEN_ID_LENGTH, this.random);
      try {
        return insert(id);
      } catch (err) {
        if (attempt < ID_ATTEMPTS && isUniqueIdViolation(err, table)) continue;
        throw err;
      }
    }
  }
}
