/**
 * Spot-checks and reputation of pool nodes (ADR-020 §5 "malicious or broken nodes", M24-12).
 *
 * The hub re-runs a random sample of finished **pool** searches of remote nodes on its own
 * built-in node `local` and compares the results. A node whose rolling disagreement rate gets
 * too high is marked `suspect` (out of the pool at once, cool-down 24 h, then back to `normal`
 * on probation); the third such episode bans it from the pool for good. Private routes are never
 * sampled nor affected — an operator may run whatever engine they like for their own tokens.
 *
 * Privacy: a sampled position lives only in memory for the duration of one check. The store
 * gets `(node_id, at, agreed)` per check and nothing else — no position, move, score or token.
 *
 * ## Comparison (tolerances, documented choices)
 *
 * Both the node's and the hub's search are Stockfish (same *family*; Maia/Lc0 and anything else
 * are never checked). Versions, thread counts and hash sizes differ, so neither the best move
 * nor the score is expected to be identical; the check asks "is the node's move a move the
 * hub's engine considers about as good as its own?":
 *
 * 1. The node's move must be legal in the position (chess.js) — else `disagree`
 *    (`illegal_move`) without spending engine time.
 * 2. `local` searches the position to depth `D = min(node depth, SPOTCHECK_MAX_DEPTH)` with one
 *    thread → best move `L`, score `S(L)`. Same move as the node → the move part agrees.
 * 3. Otherwise `local` searches again with `go depth D searchmoves <node move>` (same engine
 *    instance, warm hash) → `S(N)`. The move part agrees when `S(L) − S(N) ≤ SPOTCHECK_TOLERANCE_CP`
 *    (default 50 cp: two moves of a quiet position commonly differ by 10–40 cp between engine
 *    versions and thread counts at the same depth; ADR-020 §5 named 50 cp) **or** when both are
 *    decisive in the same direction (`≥ +500 cp`/mate for the side to move, or both `≤ −500`
 *    /mated): a still-winning move in a won position, or one losing move instead of another, is
 *    not evidence of a wrong engine and would make mates-vs-big-advantage flaky.
 * 4. Score sanity: the node's reported score must be within `SPOTCHECK_SCORE_TOLERANCE_CP`
 *    (default 200 cp — generous because the hub's depth may be capped below the node's and
 *    scores drift more than move choices) of `local`'s score of the node's move, or both decisive
 *    in the same direction. `0` turns the score check off. This catches a node that plays the
 *    right moves but fakes evaluations.
 *
 * Mate scores map onto one scale: `mate +n` → `100000 − n`, `mate −n` / `mate 0` → `−100000 + n`
 * (shorter wins rank higher, longer losses rank higher), centipawns stay as they are.
 *
 * A check is **inconclusive** (not recorded) when `local` cannot reach depth `D` within
 * `SPOTCHECK_MOVETIME_MS`, a player search started on `local` meanwhile (the check yields), the
 * engine failed, or the position cannot be parsed. Inconclusive checks never count against a
 * node.
 *
 * ## Reputation
 *
 * Window: the node's latest `window` (50) recorded checks of the last 24 h (the store's
 * retention) since the end of its last episode (`suspect_until`). With at least `minChecks`
 * (10) and a disagreement rate above `maxDisagreeRate` (20 %) the node becomes `suspect`:
 * `suspect_count + 1`, `suspect_until = now + cooldown` (24 h), `NodeRegistry.applySettings`
 * drops it from the pool. After the cool-down it returns to `normal` automatically; the window
 * then starts empty, so it stays `normal` as long as its next checks agree. The
 * `maxEpisodes`-th (3rd) episode is a permanent **pool ban** instead (`pool_banned_at`,
 * reason `spot-check failures`, logged at warn): the state stays `normal`, the link and the
 * operator's private tokens keep working, the operator's pool switch cannot lift it, only the
 * administrator can (portal admin node-state route). `disabled` is never set automatically.
 * Whenever a node becomes suspect or pool-banned, its existing **shared** relay connections end
 * like a node loss (terminal per search, then 1012) so those players reconnect to another pool
 * node; private connections stay. An administrator's manual `normal` also restarts the window
 * (`HubTokenService.setNodeState`).
 */
import { Chess } from 'chess.js';
import type { EngineDescriptor, EngineInfo, Score } from '@daisychess/engine-core';
import type { EnginePool, Lease, PoolLogger } from '../engines/EnginePool.js';
import type { PoolSearchSample, PoolSearchSink } from './Router.js';
import {
  POOL_BAN_SPOTCHECK,
  SPOTCHECK_RETENTION_MS,
  type NodeRecord,
  type NodeState,
} from './store/HubStore.js';
import { LOCAL_NODE_ID } from './tokens.js';

// ---------------------------------------------------------------------------------- scoring

/** Engine families the hub can check. Only Stockfish today (Maia/Lc0 are never checked). */
export type EngineFamily = 'stockfish';

/**
 * Family of an engine descriptor: `stockfish` for a strength engine whose id or name says
 * Stockfish (any version), excluding Fairy-Stockfish (variants). Null = never checked.
 */
export function engineFamily(
  d: Pick<EngineDescriptor, 'id' | 'name' | 'style'> | null | undefined,
): EngineFamily | null {
  if (!d || d.style === 'human') return null;
  const s = `${d.id} ${d.name}`.toLowerCase();
  if (s.includes('fairy')) return null;
  return s.includes('stockfish') ? 'stockfish' : null;
}

/** Mate scores sit beyond every centipawn score on one scale (see the module comment). */
export const MATE_VALUE = 100_000;
/** At or beyond this many centipawns a position counts as decided for the comparison. */
export const DECISIVE_CP = 500;

/** A side-to-move score on one comparable scale. */
export function scoreValue(score: Score): number {
  if ('mate' in score) {
    const n = Math.abs(score.mate);
    return score.mate > 0 ? MATE_VALUE - n : -MATE_VALUE + n;
  }
  return Math.max(-MATE_VALUE + 1_000, Math.min(MATE_VALUE - 1_000, score.cp));
}

/** Both scores decided in the same direction (winning, or lost, for the side to move). */
export function sameDecisive(a: Score, b: Score): boolean {
  const va = scoreValue(a);
  const vb = scoreValue(b);
  return (va >= DECISIVE_CP && vb >= DECISIVE_CP) || (va <= -DECISIVE_CP && vb <= -DECISIVE_CP);
}

export interface SpotCheckTolerance {
  /** Max centipawns the node's move may be worse than `local`'s best. */
  moveCp: number;
  /** Max |reported − local| centipawns for the node's score; 0 = no score check. */
  scoreCp: number;
}

export type SpotCheckReason =
  | 'same_move'
  | 'within_tolerance'
  | 'both_decisive'
  | 'illegal_move'
  | 'move_loss'
  | 'score_mismatch';

export interface SpotCheckVerdict {
  agreed: boolean;
  reason: SpotCheckReason;
}

export interface SpotCheckComparison {
  /** The node's move is `local`'s best move. */
  sameMove: boolean;
  /** `local`'s score of its own best move. */
  localBest: Score;
  /** `local`'s score of the node's move (= `localBest` when `sameMove`). */
  nodeMoveLocal: Score;
  /** The score the node reported with its move. */
  nodeReported: Score;
}

/** The comparison rule of the module comment (steps 2–4). All scores side-to-move. */
export function judgeSpotCheck(c: SpotCheckComparison, tol: SpotCheckTolerance): SpotCheckVerdict {
  let reason: SpotCheckReason = 'same_move';
  if (!c.sameMove) {
    const loss = scoreValue(c.localBest) - scoreValue(c.nodeMoveLocal);
    if (loss <= tol.moveCp) reason = 'within_tolerance';
    else if (sameDecisive(c.localBest, c.nodeMoveLocal)) reason = 'both_decisive';
    else return { agreed: false, reason: 'move_loss' };
  }
  if (tol.scoreCp > 0) {
    const diff = Math.abs(scoreValue(c.nodeReported) - scoreValue(c.nodeMoveLocal));
    if (diff > tol.scoreCp && !sameDecisive(c.nodeReported, c.nodeMoveLocal)) {
      return { agreed: false, reason: 'score_mismatch' };
    }
  }
  return { agreed: true, reason };
}

/**
 * Whether `uci` is a legal move in `fen` (chess.js). Null when chess.js cannot parse the FEN
 * (the protocol's FEN check is looser) — the check is then inconclusive, not the node's fault.
 */
export function isLegalUciMove(fen: string, uci: string): boolean | null {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  return chess
    .moves({ verbose: true })
    .some((m) => `${m.from}${m.to}${m.promotion ?? ''}` === uci.toLowerCase());
}

// ---------------------------------------------------------------------------------- local engine

export interface LocalSearchParams {
  depth: number;
  /** Hard cap: the search stops after this long (then it usually misses `depth`). */
  movetimeMs: number;
  searchmoves?: readonly string[];
}

export interface LocalSearchResult {
  /** Null for `bestmove (none)`. */
  bestMove: string | null;
  /** Score of the last multipv-1 `info`; null when none came. */
  score: Score | null;
  /** Depth of that `info` (0 when none). */
  depth: number;
}

/** One leased `local` engine for the searches of one check. */
export interface LocalEngineSession {
  /** Null when the search failed or was aborted (`shouldAbort` turned true). */
  search(
    fen: string,
    params: LocalSearchParams,
    shouldAbort: () => boolean,
  ): Promise<LocalSearchResult | null>;
  close(): void;
}

/** What the spot-checker needs from `local`. */
export interface LocalChecker {
  /** `local` has spare capacity for a check on `engineId` right now (never delay players). */
  canStart(engineId: string): boolean;
  /** A player search is running on `local`: a running check yields (inconclusive). */
  playerActive(): boolean;
  /** Leases an engine; null when none is free. */
  open(engineId: string): Promise<LocalEngineSession | null>;
}

export interface PoolCheckerOptions {
  /** `MAX_SESSIONS` of the hub's pool. */
  maxSessions: number;
  /** Instance cap of a local engine (`engines.json` `maxInstances`). */
  maxInstances: (engineId: string) => number;
  /** Player searches currently running on `local` (`HubRouter.localSearches`). */
  playerSearches: () => number;
  /** UCI options of a check (bounded CPU; deterministic-ish single-threaded search). */
  threads?: number;
  hashMb?: number;
  /** How often a running check polls for abort. Default 50 ms. */
  pollMs?: number;
  logger?: PoolLogger;
}

/**
 * {@link LocalChecker} over the hub's {@link EnginePool}. A check may start only when no player
 * search runs on `local`, and taking one lease still leaves a free session and a free instance
 * of the engine for the next player (so a player is never refused because of a check); a
 * player search starting meanwhile stops the check within `pollMs`.
 */
export function createPoolChecker(pool: EnginePool, opts: PoolCheckerOptions): LocalChecker {
  const threads = opts.threads ?? 1;
  const hash = opts.hashMb ?? 16;
  const pollMs = opts.pollMs ?? 50;
  const busyOf = (engineId: string): number =>
    pool.stats().find((e) => e.id === engineId)?.busy ?? 0;
  return {
    canStart: (engineId) =>
      !pool.isClosed &&
      opts.playerSearches() === 0 &&
      pool.sessions + 1 < opts.maxSessions &&
      busyOf(engineId) + 1 < opts.maxInstances(engineId),
    playerActive: () => opts.playerSearches() > 0,
    open: async (engineId) => {
      const acquired = await pool.acquire(engineId);
      if (!acquired.ok) return null;
      return poolSession(pool, acquired.lease, { threads, hash, pollMs, logger: opts.logger });
    },
  };
}

function poolSession(
  pool: EnginePool,
  lease: Lease,
  o: { threads: number; hash: number; pollMs: number; logger: PoolLogger | undefined },
): LocalEngineSession {
  let closed = false;
  return {
    async search(fen, params, shouldAbort) {
      if (closed || lease.released) return null;
      const proc = lease.engine;
      let aborted = false;
      let poll: ReturnType<typeof setInterval> | null = null;
      let hard: ReturnType<typeof setTimeout> | null = null;
      try {
        await proc.setOptions({ Threads: o.threads, Hash: o.hash, MultiPV: 1 });
        if (shouldAbort()) return null;
        proc.position(fen);
        let last: EngineInfo | null = null;
        const go = proc.go(
          {
            depth: params.depth,
            movetime: params.movetimeMs,
            ...(params.searchmoves ? { searchmoves: params.searchmoves } : {}),
          },
          (info) => {
            if (info.multipv === 1) last = info;
          },
        );
        const stop = () => {
          aborted = true;
          void proc.stop().catch(() => undefined);
        };
        poll = setInterval(() => {
          if (shouldAbort()) stop();
        }, o.pollMs);
        poll.unref?.();
        // The engine honours `movetime`; this only guards against one that does not.
        hard = setTimeout(stop, params.movetimeMs + 2_000);
        hard.unref?.();
        const res = await go;
        if (aborted) return null;
        const info = last as EngineInfo | null;
        return {
          bestMove: res.bestMove?.move ?? null,
          score: info?.score ?? null,
          depth: info?.depth ?? 0,
        };
      } catch (err) {
        o.logger?.debug({ err: (err as Error).message }, 'spot-check: local search failed');
        return null;
      } finally {
        if (poll) clearInterval(poll);
        if (hard) clearTimeout(hard);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      void pool.release(lease);
    },
  };
}

// ---------------------------------------------------------------------------------- reputation

/** The store calls reputation needs (`HubStore` satisfies it). */
export interface ReputationStore {
  getNode(id: string): NodeRecord | undefined;
  listNodes(): NodeRecord[];
  insertSpotcheck(nodeId: string, at: number, agreed: boolean): void;
  recentSpotchecks(nodeId: string, since: number, limit: number): boolean[];
  setNodeReputation(
    id: string,
    rep: { state: NodeState; suspectCount: number; suspectUntil: number | null },
  ): NodeRecord | undefined;
  setPoolBan(id: string, ban: { at: number; reason: string } | null): NodeRecord | undefined;
}

/** Applying a reputation change to the live hub. */
export interface NodeModeration {
  /** Re-evaluate pool membership of the connected node (`NodeRegistry.applySettings`). */
  apply(node: NodeRecord): void;
  /** The node left the pool: end its shared (pool) player connections; private ones stay. */
  evictShared(node: NodeRecord): void;
}

export interface ReputationPolicy {
  /** Rolling window: the latest this many checks. Default 50. */
  window: number;
  /** No verdict below this many checks in the window. Default 10. */
  minChecks: number;
  /** `suspect` when the disagreement rate is above this (0…1). Default 0.2. */
  maxDisagreeRate: number;
  /** Cool-down of a `suspect` episode (ms). Default 24 h. */
  cooldownMs: number;
  /** The episode with this number bans the node from the pool instead. Default 3. */
  maxEpisodes: number;
}

export const DEFAULT_REPUTATION_POLICY: Readonly<ReputationPolicy> = Object.freeze({
  window: 50,
  minChecks: 10,
  maxDisagreeRate: 0.2,
  cooldownMs: 24 * 3_600_000,
  maxEpisodes: 3,
});

export interface ReputationStats {
  recorded: number;
  suspected: number;
  restored: number;
  poolBanned: number;
}

export type ReputationTransition = 'suspect' | 'pool_banned' | 'normal';

/**
 * Rolling-window reputation over the `spotchecks` table and the node's `state`,
 * `suspect_count`, `suspect_until` (see the module comment).
 */
export class Reputation {
  private readonly policy: ReputationPolicy;
  private readonly counters: ReputationStats = {
    recorded: 0,
    suspected: 0,
    restored: 0,
    poolBanned: 0,
  };

  constructor(
    private readonly store: ReputationStore,
    private readonly moderation: NodeModeration,
    private readonly log: PoolLogger,
    policy: Partial<ReputationPolicy> = {},
  ) {
    this.policy = { ...DEFAULT_REPUTATION_POLICY, ...policy };
  }

  /** Records one conclusive check and applies a resulting transition (returned). */
  record(nodeId: string, agreed: boolean, now: number): ReputationTransition | null {
    let node = this.store.getNode(nodeId);
    if (!node) return null;
    this.store.insertSpotcheck(nodeId, now, agreed);
    this.counters.recorded++;
    // The cool-down may have ended before the periodic sweep noticed: this check then counts.
    if (node.state === 'suspect' && this.restore(node, now)) {
      node = this.store.getNode(nodeId) ?? node;
    }
    // A check that finished while the node is suspect, disabled or pool-banned only adds to
    // the record.
    if (node.state !== 'normal' || node.poolBannedAt !== null) return null;
    const since = Math.max(now - SPOTCHECK_RETENTION_MS, node.suspectUntil ?? 0);
    const verdicts = this.store.recentSpotchecks(nodeId, since, this.policy.window);
    if (verdicts.length < this.policy.minChecks) return null;
    const disagreements = verdicts.filter((v) => !v).length;
    if (disagreements / verdicts.length <= this.policy.maxDisagreeRate) return null;
    return this.flag(node, now, disagreements, verdicts.length);
  }

  /** Returns every `suspect` node whose cool-down ended to `normal`. Returns how many. */
  expireCooldowns(now: number): number {
    let n = 0;
    for (const node of this.store.listNodes()) {
      if (node.state === 'suspect' && this.restore(node, now)) n++;
    }
    return n;
  }

  stats(): ReputationStats {
    return { ...this.counters };
  }

  private restore(node: NodeRecord, now: number): boolean {
    // A suspect flag set by hand (no `suspect_until`) stays until the administrator clears it.
    if (node.suspectUntil === null || node.suspectUntil > now) return false;
    const updated = this.store.setNodeReputation(node.id, {
      state: 'normal',
      suspectCount: node.suspectCount,
      // Kept: the window of the next verdict starts here.
      suspectUntil: node.suspectUntil,
    });
    if (!updated) return false;
    this.counters.restored++;
    this.log.info(
      { component: 'spotcheck', nodeId: node.id, episodes: node.suspectCount },
      'spot-check: cool-down over, node back in the pool',
    );
    this.safely(() => this.moderation.apply(updated));
    return true;
  }

  private flag(
    node: NodeRecord,
    now: number,
    disagreements: number,
    checks: number,
  ): ReputationTransition | null {
    const episodes = node.suspectCount + 1;
    const ban = episodes >= this.policy.maxEpisodes;
    let updated = this.store.setNodeReputation(node.id, {
      state: ban ? 'normal' : 'suspect',
      suspectCount: episodes,
      suspectUntil: ban ? now : now + this.policy.cooldownMs,
    });
    if (ban && updated)
      updated = this.store.setPoolBan(node.id, { at: now, reason: POOL_BAN_SPOTCHECK });
    if (!updated) return null;
    const out = updated;
    const ctx = { component: 'spotcheck', nodeId: node.id, episodes, disagreements, checks };
    if (ban) {
      this.counters.poolBanned++;
      this.log.warn(
        ctx,
        'spot-check: node permanently removed from the pool after repeated suspect episodes (private use unaffected; an administrator can lift it)',
      );
    } else {
      this.counters.suspected++;
      this.log.warn(ctx, 'spot-check: node marked suspect and removed from the pool');
    }
    this.safely(() => this.moderation.apply(out));
    this.safely(() => this.moderation.evictShared(out));
    return ban ? 'pool_banned' : 'suspect';
  }

  private safely(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log.warn(
        { component: 'spotcheck', err: (err as Error).message },
        'spot-check: moderation failed',
      );
    }
  }
}

// ---------------------------------------------------------------------------------- sampler

export interface SpotCheckConfig {
  /** Fraction (0…1) of eligible pool searches that are checked. `SPOTCHECK_RATE`, default 0.02. */
  rate: number;
  /** Checks started per rolling hour. `SPOTCHECK_MAX_PER_HOUR`, default 20. */
  maxPerHour: number;
  /** `SPOTCHECK_TOLERANCE_CP`, default 50. */
  toleranceCp: number;
  /** `SPOTCHECK_SCORE_TOLERANCE_CP`, default 200; 0 = off. */
  scoreToleranceCp: number;
  /** Searches below this reported depth are not eligible. Default 10. */
  minDepth: number;
  /** `local` searches at most this deep (`SPOTCHECK_MAX_DEPTH`, default 16). */
  maxDepth: number;
  /** Time cap of one local search (`SPOTCHECK_MOVETIME_MS`, default 5 000). */
  movetimeMs: number;
  /** Checks running at once. Default 1. */
  maxConcurrent: number;
}

export const DEFAULT_SPOTCHECK_CONFIG: Readonly<SpotCheckConfig> = Object.freeze({
  rate: 0.02,
  maxPerHour: 20,
  toleranceCp: 50,
  scoreToleranceCp: 200,
  minDepth: 10,
  maxDepth: 16,
  movetimeMs: 5_000,
  maxConcurrent: 1,
});

/** `/health/detail.spotchecks`: counters only. */
export interface SpotCheckStats {
  rate: number;
  /** Pool searches offered (remote, shared routes). */
  offered: number;
  /** Offered and checkable (Stockfish family, depth, bestmove + score). */
  eligible: number;
  /** Eligible and drawn by the sampling rate. */
  sampled: number;
  started: number;
  running: number;
  /** Checks started in the last hour (against `maxPerHour`). */
  lastHour: number;
  agreed: number;
  disagreed: number;
  inconclusive: number;
  skipped: { engine: number; depth: number; busy: number; budget: number; concurrent: number };
  reasons: Partial<Record<SpotCheckReason, number>>;
  reputation: ReputationStats;
}

export interface SpotCheckerOptions {
  config?: Partial<SpotCheckConfig>;
  local: LocalChecker;
  /** `local`'s engines (enabled ones of the same family are candidates). */
  localEngines: readonly EngineDescriptor[];
  reputation: Reputation;
  logger: PoolLogger;
  random?: () => number;
  now?: () => number;
}

const HOUR_MS = 3_600_000;

/**
 * Samples finished pool searches ({@link PoolSearchSink}, fed by the router's
 * `AccountingChannel`s) and checks them on `local` (see the module comment). Never blocks the
 * caller: `offer` decides synchronously and the check runs in the background.
 */
export class SpotChecker implements PoolSearchSink {
  private readonly cfg: SpotCheckConfig;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly hourStarts: number[] = [];
  private readonly running = new Set<Promise<void>>();
  private closed = false;
  private readonly c = {
    offered: 0,
    eligible: 0,
    sampled: 0,
    started: 0,
    agreed: 0,
    disagreed: 0,
    inconclusive: 0,
  };
  private readonly skipped = { engine: 0, depth: 0, busy: 0, budget: 0, concurrent: 0 };
  private readonly reasons: Partial<Record<SpotCheckReason, number>> = {};

  constructor(private readonly opts: SpotCheckerOptions) {
    this.cfg = { ...DEFAULT_SPOTCHECK_CONFIG, ...opts.config };
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  get config(): Readonly<SpotCheckConfig> {
    return this.cfg;
  }

  offer(sample: PoolSearchSample): void {
    if (this.closed || sample.nodeId === LOCAL_NODE_ID) return;
    this.c.offered++;
    const family = engineFamily(sample.descriptor);
    const localEngine = family ? this.localEngineFor(family, sample.engine) : null;
    if (!family || !localEngine) {
      this.skipped.engine++;
      return;
    }
    if (sample.depth < this.cfg.minDepth) {
      this.skipped.depth++;
      return;
    }
    this.c.eligible++;
    if (this.cfg.rate <= 0 || this.random() >= this.cfg.rate) return;
    this.c.sampled++;
    if (this.running.size >= this.cfg.maxConcurrent) {
      this.skipped.concurrent++;
      return;
    }
    const now = this.now();
    this.pruneHour(now);
    if (this.hourStarts.length >= this.cfg.maxPerHour) {
      this.skipped.budget++;
      return;
    }
    if (!this.opts.local.canStart(localEngine)) {
      this.skipped.busy++;
      return;
    }
    this.hourStarts.push(now);
    this.c.started++;
    const p: Promise<void> = this.check(sample, localEngine)
      .catch((err: unknown) => {
        this.c.inconclusive++;
        this.opts.logger.warn(
          { component: 'spotcheck', node: sample.nodeId, err: (err as Error).message },
          'spot-check failed',
        );
      })
      .finally(() => this.running.delete(p));
    this.running.add(p);
  }

  /** Resolves when every running check has finished (stops them first). Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.running]);
  }

  /** Settles when the checks running now are done (tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.running]);
  }

  stats(): SpotCheckStats {
    this.pruneHour(this.now());
    return {
      rate: this.cfg.rate,
      ...this.c,
      running: this.running.size,
      lastHour: this.hourStarts.length,
      skipped: { ...this.skipped },
      reasons: { ...this.reasons },
      reputation: this.opts.reputation.stats(),
    };
  }

  // -------------------------------------------------------------------------------------------

  private localEngineFor(family: EngineFamily, preferId: string): string | null {
    const candidates = this.opts.localEngines.filter(
      (e) => e.enabled && engineFamily(e) === family,
    );
    return (candidates.find((e) => e.id === preferId) ?? candidates[0])?.id ?? null;
  }

  private pruneHour(now: number): void {
    while (this.hourStarts.length > 0 && now - this.hourStarts[0]! >= HOUR_MS) {
      this.hourStarts.shift();
    }
  }

  private async check(sample: PoolSearchSample, engineId: string): Promise<void> {
    const legal = isLegalUciMove(sample.fen, sample.bestMove);
    if (legal === null) return this.inconclusive(sample, 'unparsable position');
    if (!legal) return this.conclude(sample, { agreed: false, reason: 'illegal_move' });

    const session = await this.opts.local.open(engineId);
    if (!session) return this.inconclusive(sample, 'no local engine');
    try {
      const depth = Math.min(sample.depth, this.cfg.maxDepth);
      const abort = () => this.closed || this.opts.local.playerActive();
      const params = { depth, movetimeMs: this.cfg.movetimeMs };
      const best = await session.search(sample.fen, params, abort);
      if (!best || !best.bestMove || !best.score || best.depth < depth) {
        return this.inconclusive(sample, best ? 'local depth not reached' : 'local search aborted');
      }
      let nodeMoveLocal: Score = best.score;
      const sameMove = best.bestMove === sample.bestMove;
      if (!sameMove) {
        const restricted = await session.search(
          sample.fen,
          { ...params, searchmoves: [sample.bestMove] },
          abort,
        );
        if (!restricted || !restricted.score || restricted.depth < depth) {
          return this.inconclusive(
            sample,
            restricted ? 'local depth not reached' : 'local search aborted',
          );
        }
        if (restricted.bestMove !== null && restricted.bestMove !== sample.bestMove) {
          // The engine ignored the restriction; nothing to compare.
          return this.inconclusive(sample, 'searchmoves ignored');
        }
        nodeMoveLocal = restricted.score;
      }
      const verdict = judgeSpotCheck(
        { sameMove, localBest: best.score, nodeMoveLocal, nodeReported: sample.score },
        { moveCp: this.cfg.toleranceCp, scoreCp: this.cfg.scoreToleranceCp },
      );
      this.conclude(sample, verdict, depth);
    } finally {
      session.close();
    }
  }

  private conclude(sample: PoolSearchSample, verdict: SpotCheckVerdict, depth?: number): void {
    if (verdict.agreed) this.c.agreed++;
    else this.c.disagreed++;
    this.reasons[verdict.reason] = (this.reasons[verdict.reason] ?? 0) + 1;
    this.opts.logger.info(
      {
        component: 'spotcheck',
        node: sample.nodeId,
        agreed: verdict.agreed,
        reason: verdict.reason,
        ...(depth !== undefined ? { depth } : {}),
      },
      'spot-check done',
    );
    this.opts.reputation.record(sample.nodeId, verdict.agreed, this.now());
  }

  private inconclusive(sample: PoolSearchSample, why: string): void {
    this.c.inconclusive++;
    this.opts.logger.debug(
      { component: 'spotcheck', node: sample.nodeId, why },
      'spot-check inconclusive',
    );
  }
}
