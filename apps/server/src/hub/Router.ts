import {
  minLimits,
  type AnalysisDeniedReason,
  type EngineDescriptor,
  type HelloMessage,
  type Limits,
  type TokenTier,
  type WelcomeNode,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { AnalysisChannel } from '../sessions/AnalysisChannel.js';
import type {
  AnalysisRoute,
  AnalysisRouter,
  RoutePeer,
  RouteResult,
} from '../sessions/AnalysisRouter.js';
import type { Deliver, SessionLedger, SessionPeer } from '../sessions/ClientSessions.js';
import type { RateLimit } from '../sessions/rateLimit.js';
import {
  AccountingChannel,
  TokenSessionLedger,
  type BudgetSource,
  type UsageSink,
} from './AccountingChannel.js';
import type { RouteContext } from './HubNodeLink.js';
import type { NodeStatusSnapshot, OnlineNodeState } from './NodeRegistry.js';
import type { TokenRecord } from './store/HubStore.js';
import { LEGACY_TOKEN_ID, LOCAL_NODE_ID, type PlayerVerifyResult } from './tokens.js';

// ---------------------------------------------------------------------------------- tiers

/**
 * Hub policy of the token tiers (ADR-020 §2; not part of the protocol): `small` = 1 session /
 * 2 threads / 60 s movetime, `standard` = 2 sessions / the node's threads / 10 min, `full` =
 * the node's limits. `sessions` is the cap across all connections of one token
 * (`TokenSessionLedger`); `caps` are combined with the node's limits element-wise (`minLimits`).
 */
export const TIER_POLICY: Readonly<
  Record<TokenTier, { readonly sessions: number; readonly caps: Readonly<Partial<Limits>> }>
> = Object.freeze({
  small: {
    sessions: 1,
    caps: { maxSessionsPerConnection: 1, maxThreads: 2, maxMovetimeMs: 60_000 },
  },
  standard: { sessions: 2, caps: { maxSessionsPerConnection: 2, maxMovetimeMs: 600_000 } },
  full: { sessions: Number.POSITIVE_INFINITY, caps: {} },
});

/** `welcome.limits` of a route: the node's limits capped by the token's tier. */
export function tierLimits(tier: TokenTier, nodeLimits: Limits): Limits {
  return minLimits(nodeLimits, { ...nodeLimits, ...TIER_POLICY[tier].caps });
}

// ---------------------------------------------------------------------------------- inputs

/** A connected node as the router needs it (`OnlineNode` satisfies it). */
export interface RoutableNode {
  readonly nodeId: string;
  readonly name: string;
  readonly operatorId: string;
  readonly engines: readonly EngineDescriptor[];
  readonly limits: Limits;
  readonly maxSessions: number;
  readonly pool: boolean;
  readonly poolShare: number;
  readonly state: OnlineNodeState;
  readonly status: NodeStatusSnapshot | null;
  readonly rttMs: number | null;
  readonly link: {
    open(deliver: Deliver, peer: SessionPeer, route: RouteContext): AnalysisChannel;
  };
}

/** The online nodes (`NodeRegistry` satisfies it). */
export interface RouterRegistry {
  get(nodeId: string): RoutableNode | undefined;
  poolCandidates(): readonly RoutableNode[];
  onChange?(
    listener: (event: { type: string; node: { nodeId: string; state: OnlineNodeState } }) => void,
  ): () => void;
}

/** The hub's built-in node `local`: its own engine pool (ADR-020 §1, §4.5). */
export interface LocalNode {
  /** `welcome.node.name`. */
  readonly name: string;
  readonly engines: readonly EngineDescriptor[];
  readonly limits: Limits;
  /** Sessions of the local pool donated to the shared pool (0 = not in the pool). */
  readonly poolShare: number;
  /** False once the pool is shut down. */
  available(): boolean;
  /** The pool has a free engine session. */
  hasFreeSlot(): boolean;
  /** `ClientSessions` over the local pool with an unlimited ledger (the hub accounts per IP). */
  open(deliver: Deliver, peer: SessionPeer, limits: Limits): AnalysisChannel;
}

export interface PlayerTokenVerifier {
  verifyPlayerToken(raw: unknown, now?: number): PlayerVerifyResult;
}

export interface HubRouterOptions {
  tokens: PlayerTokenVerifier;
  registry: RouterRegistry;
  /** Null: the hub has no own engines to route to. */
  local: LocalNode | null;
  /** Public (lichess) name of a node's operator for `welcome.node.operator`. */
  operatorName?: (operatorId: string) => string | undefined;
  /** Hub-wide per-IP session ledger (`MAX_SESSIONS_PER_IP` across all nodes). */
  ipLedger: SessionLedger;
  usage: UsageSink;
  /** Daily pool budget (pool tokens and player tokens routed via `poolFallback`). */
  budget: BudgetSource;
  sessionIdleMs: number;
  /** `welcome.limits` of a denied (restricted) welcome. */
  restrictedLimits: Limits;
  analyzeRateLimit?: RateLimit;
  logger: PoolLogger;
  /** A token prefers the pool node it used within this long. Default 10 min. */
  stickyMs?: number;
  /** A node with an `engine_crashed` or an unplanned loss within this long is penalised. Default 10 min. */
  failurePenaltyMs?: number;
  now?: () => number;
}

export type RouteKind = 'local' | 'private' | 'pool';

/** `/health/detail.router`: counters only — no token, id of a token, or address. */
export interface HubRouterStats {
  routes: Record<RouteKind, number>;
  denials: Partial<Record<AnalysisDeniedReason, number>>;
  /** Open pool sessions per node id (the scheduler's load). */
  poolLoad: Record<string, number>;
  sticky: number;
  tokenSlots: number;
}

type Target = { kind: 'local'; local: LocalNode } | { kind: 'remote'; node: RoutableNode };

const STICKY_MS = 10 * 60_000;
const FAILURE_PENALTY_MS = 10 * 60_000;
/** Score malus of a node that failed recently (scores are free share fractions in [0, 1]). */
const FAILURE_MALUS = 0.5;
const MAX_STICKY = 10_000;

/**
 * The hub's router (ADR-020 §4, relay layering §2): `hello.token` → legacy `ACCESS_TOKEN`
 * (node `local`) or a `dc1_` token → its listed nodes in order (first online one with a free
 * slot) → the pool when `poolFallback` (or for pool tokens) → a full but online listed node as a
 * last resort (the node answers `no_capacity` on `analyze` while it stays full) → otherwise a
 * denial with the precise reason. Every route's channel is wrapped in an
 * {@link AccountingChannel} (per-IP, per-token and per-connection slots, usage metering, the
 * daily pool budget on pool routes).
 *
 * Pool scheduling: candidates are online pool nodes (`NodeRegistry.poolCandidates`, plus
 * `local` with a positive pool share) whose open pool sessions are below their `poolShare`, whose
 * last `node.status` shows a free session and that have a non-degraded engine. Best = most free
 * share relative to `poolShare` (a 2-slot laptop and a 32-slot server fill proportionally),
 * minus a penalty for a failure in the last 10 minutes; ties go to the lower link RTT. A token
 * keeps the node it was routed to in the last 10 minutes while that node is a candidate.
 */
export class HubRouter implements AnalysisRouter {
  private readonly tokenLedger = new TokenSessionLedger();
  private readonly poolLoad = new Map<string, number>();
  private readonly sticky = new Map<string, { nodeId: string; at: number }>();
  private readonly failures = new Map<string, number>();
  private readonly routes: Record<RouteKind, number> = { local: 0, private: 0, pool: 0 };
  private readonly denials: Partial<Record<AnalysisDeniedReason, number>> = {};
  private readonly now: () => number;
  private readonly stickyMs: number;
  private readonly failurePenaltyMs: number;
  private readonly offRegistry: (() => void) | null;

  constructor(private readonly opts: HubRouterOptions) {
    this.now = opts.now ?? Date.now;
    this.stickyMs = opts.stickyMs ?? STICKY_MS;
    this.failurePenaltyMs = opts.failurePenaltyMs ?? FAILURE_PENALTY_MS;
    this.offRegistry =
      opts.registry.onChange?.((e) => {
        // An unplanned loss counts as a failure; a drained node left on purpose.
        if (e.type === 'offline' && e.node.state !== 'draining') this.noteFailure(e.node.nodeId);
      }) ?? null;
  }

  get restrictedLimits(): Limits {
    return this.opts.restrictedLimits;
  }

  route(hello: HelloMessage, peer: RoutePeer): RouteResult {
    const now = this.now();
    if (hello.token === undefined) return this.deny('no_token', peer);
    const verified = this.opts.tokens.verifyPlayerToken(hello.token, now);
    if ('error' in verified) {
      return this.deny(verified.error === 'unknown' ? 'bad_token' : verified.error, peer);
    }
    const token = verified.record;
    if (token.kind !== 'player') {
      // Pool (and reserved anonymous) tokens list no nodes.
      const pool = this.poolRoute(token, now);
      return pool.ok ? this.accept(pool, token, peer) : this.deny(pool.reason, peer, token);
    }
    let fullButOnline: Target | null = null;
    for (const id of token.nodeIds) {
      const target = this.privateTarget(id);
      if (!target) continue;
      if (this.hasFreeSlot(target)) return this.accept(this.privateRoute(target), token, peer);
      fullButOnline ??= target;
    }
    if (token.poolFallback) {
      const pool = this.poolRoute(token, now);
      if (pool.ok) return this.accept(pool, token, peer);
      if (!fullButOnline) return this.deny(pool.reason, peer, token);
    }
    if (fullButOnline) return this.accept(this.privateRoute(fullButOnline), token, peer);
    return this.deny('node_offline', peer, token);
  }

  /** A search on `nodeId` crashed (or the node was lost): penalised in pool scheduling. */
  noteFailure(nodeId: string): void {
    this.failures.set(nodeId, this.now());
  }

  stats(): HubRouterStats {
    return {
      routes: { ...this.routes },
      denials: { ...this.denials },
      poolLoad: Object.fromEntries(this.poolLoad),
      sticky: this.sticky.size,
      tokenSlots: this.tokenLedger.tokens,
    };
  }

  /** Stops listening to the registry. */
  dispose(): void {
    this.offRegistry?.();
  }

  // -------------------------------------------------------------------------------------------

  private privateTarget(nodeId: string): Target | null {
    if (nodeId === LOCAL_NODE_ID) {
      const local = this.opts.local;
      return local && local.available() ? { kind: 'local', local } : null;
    }
    const node = this.opts.registry.get(nodeId);
    return node && node.state === 'online' ? { kind: 'remote', node } : null;
  }

  private hasFreeSlot(target: Target): boolean {
    if (target.kind === 'local') return target.local.hasFreeSlot();
    const s = target.node.status;
    return s === null || s.sessions < s.maxSessions;
  }

  private privateRoute(target: Target): PlannedRoute {
    return { ok: true, target, shared: false, kind: target.kind === 'local' ? 'local' : 'private' };
  }

  private poolRoute(
    token: TokenRecord,
    now: number,
  ): PlannedRoute | { ok: false; reason: AnalysisDeniedReason } {
    const remaining = this.opts.budget.remainingMs(token.id, now);
    if (remaining !== null && remaining <= 0) return { ok: false, reason: 'budget_exhausted' };
    const candidates: { target: Target; id: string; score: number; rtt: number }[] = [];
    for (const node of this.opts.registry.poolCandidates()) {
      if (node.state !== 'online' || !node.pool || node.poolShare <= 0) continue;
      const s = node.status;
      if (s && s.sessions >= s.maxSessions) continue;
      if (s && s.engines.length > 0 && s.engines.every((e) => e.degraded)) continue;
      const score = this.score(node.nodeId, node.poolShare, now);
      if (score === null) continue;
      candidates.push({
        target: { kind: 'remote', node },
        id: node.nodeId,
        score,
        rtt: node.rttMs ?? Number.MAX_SAFE_INTEGER,
      });
    }
    const local = this.opts.local;
    if (local && local.poolShare > 0 && local.available() && local.hasFreeSlot()) {
      const score = this.score(LOCAL_NODE_ID, local.poolShare, now);
      if (score !== null) {
        candidates.push({ target: { kind: 'local', local }, id: LOCAL_NODE_ID, score, rtt: 0 });
      }
    }
    if (candidates.length === 0) return { ok: false, reason: 'no_capacity' };
    const stick = this.sticky.get(token.id);
    let chosen =
      stick && now - stick.at < this.stickyMs
        ? candidates.find((c) => c.id === stick.nodeId)
        : undefined;
    if (!chosen) {
      candidates.sort((a, b) => b.score - a.score || a.rtt - b.rtt || (a.id < b.id ? -1 : 1));
      chosen = candidates[0]!;
    }
    this.remember(token.id, chosen.id, now);
    return { ok: true, target: chosen.target, shared: true, kind: 'pool' };
  }

  /** Free pool share fraction minus the failure malus; null when the share is used up. */
  private score(nodeId: string, poolShare: number, now: number): number | null {
    const load = this.poolLoad.get(nodeId) ?? 0;
    if (load >= poolShare) return null;
    const failedAt = this.failures.get(nodeId);
    const failed = failedAt !== undefined && now - failedAt < this.failurePenaltyMs;
    if (failedAt !== undefined && !failed) this.failures.delete(nodeId);
    return (poolShare - load) / poolShare - (failed ? FAILURE_MALUS : 0);
  }

  private remember(tokenId: string, nodeId: string, now: number): void {
    this.sticky.delete(tokenId);
    this.sticky.set(tokenId, { nodeId, at: now });
    if (this.sticky.size > MAX_STICKY) {
      for (const [id, s] of this.sticky) {
        if (now - s.at >= this.stickyMs || this.sticky.size > MAX_STICKY) this.sticky.delete(id);
        else break;
      }
    }
  }

  private accept(plan: PlannedRoute, token: TokenRecord, peer: RoutePeer): RouteResult {
    const { target, shared } = plan;
    const nodeLimits = target.kind === 'local' ? target.local.limits : target.node.limits;
    const limits = tierLimits(token.tier, nodeLimits);
    const nodeId = target.kind === 'local' ? LOCAL_NODE_ID : target.node.nodeId;
    const node: WelcomeNode =
      target.kind === 'local'
        ? { name: clip(target.local.name) || LOCAL_NODE_ID, shared }
        : { name: clip(target.node.name) || nodeId, shared };
    if (target.kind === 'remote') {
      const operator = clip(this.opts.operatorName?.(target.node.operatorId) ?? '');
      if (operator) node.operator = operator;
    }
    // Engine defaults are clamped to the composed limits (a `small` token announces ≤ 2 threads).
    const engines = (target.kind === 'local' ? target.local.engines : target.node.engines).map(
      (e) => ({
        ...e,
        defaults: {
          threads: Math.min(e.defaults.threads, limits.maxThreads),
          hash: Math.min(e.defaults.hash, limits.maxHash),
        },
      }),
    );
    this.routes[plan.kind]++;
    this.opts.logger.info(
      { conn: peer.connId, tokenId: token.id, node: nodeId, kind: plan.kind, tier: token.tier },
      'connection routed',
    );
    const route: AnalysisRoute = {
      limits,
      engines,
      node,
      open: (deliver, sessionPeer) =>
        this.openChannel(deliver, sessionPeer, { target, token, limits, nodeId, shared, engines }),
    };
    return { ok: true, route };
  }

  private openChannel(
    deliver: Deliver,
    peer: SessionPeer,
    r: {
      target: Target;
      token: TokenRecord;
      limits: Limits;
      nodeId: string;
      shared: boolean;
      engines: readonly EngineDescriptor[];
    },
  ): AnalysisChannel {
    const { target, token, limits, nodeId, shared } = r;
    const createInner = (d: Deliver): AnalysisChannel => {
      if (target.kind === 'local') return target.local.open(d, peer, limits);
      const ctx: RouteContext = { limits, shared, tier: token.tier };
      if (!shared && token.id !== LEGACY_TOKEN_ID) {
        ctx.tokenId = token.id;
        if (token.label) ctx.label = token.label;
      }
      return target.node.link.open(d, peer, ctx);
    };
    return new AccountingChannel(createInner, deliver, {
      limits,
      sessionIdleMs: this.opts.sessionIdleMs,
      logger: this.opts.logger,
      slots: {
        ip: this.opts.ipLedger,
        token: this.tokenLedger.forCap(TIER_POLICY[token.tier].sessions),
      },
      keys: { ip: peer.ip, tokenId: token.id, nodeId, connId: peer.id },
      shared,
      budget: this.opts.budget,
      usage: this.opts.usage,
      engineDefaults: new Map(r.engines.map((e) => [e.id, e.defaults])),
      ...(this.opts.analyzeRateLimit ? { analyzeRateLimit: this.opts.analyzeRateLimit } : {}),
      ...(shared ? { onSessionDelta: (d: 1 | -1) => this.addLoad(nodeId, d) } : {}),
      onEngineFailure: () => this.noteFailure(nodeId),
      now: this.now,
    });
  }

  private addLoad(nodeId: string, delta: 1 | -1): void {
    const n = (this.poolLoad.get(nodeId) ?? 0) + delta;
    if (n <= 0) this.poolLoad.delete(nodeId);
    else this.poolLoad.set(nodeId, n);
  }

  private deny(reason: AnalysisDeniedReason, peer: RoutePeer, token?: TokenRecord): RouteResult {
    this.denials[reason] = (this.denials[reason] ?? 0) + 1;
    this.opts.logger.info(
      { conn: peer.connId, reason, ...(token ? { tokenId: token.id } : {}) },
      'analysis denied at hello',
    );
    return { ok: false, reason };
  }
}

type PlannedRoute = { ok: true; target: Target; shared: boolean; kind: RouteKind };

/** `welcome.node` strings are at most 32 characters. */
function clip(s: string): string {
  return s.trim().slice(0, 32);
}
