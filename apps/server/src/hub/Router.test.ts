import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  type AnalyzeMessage,
  type EngineDescriptor,
  type HelloMessage,
  type Limits,
  type TokenTier,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { AnalysisChannel } from '../sessions/AnalysisChannel.js';
import type { AnalysisRoute, RouteResult } from '../sessions/AnalysisRouter.js';
import type {
  AnalysisClientMessage,
  AnalysisServerMessage,
  Deliver,
} from '../sessions/ClientSessions.js';
import { IpSessionLedger } from '../ws/clientIp.js';
import type { RouteContext } from './HubNodeLink.js';
import type { NodeStatusSnapshot } from './NodeRegistry.js';
import {
  HubRouter,
  TIER_POLICY,
  tierLimits,
  type HubRouterOptions,
  type LocalNode,
  type RoutableNode,
  type RouterRegistry,
} from './Router.js';
import type { TokenRecord } from './store/HubStore.js';
import { LEGACY_TOKEN_ID, LOCAL_NODE_ID, type PlayerVerifyResult } from './tokens.js';

const silent: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };
const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MIN = 60_000;
const ENGINES: EngineDescriptor[] = [
  { id: 'sf', name: 'Stockfish', enabled: true, defaults: { threads: 8, hash: 256 } },
];
const NODE_LIMITS: Limits = { ...DEFAULT_LIMITS, maxThreads: 16, maxSessionsPerConnection: 4 };

class FakeChannel implements AnalysisChannel {
  readonly handled: AnalysisClientMessage[] = [];
  constructor(readonly deliver: Deliver) {}
  get sessionCount() {
    return 0;
  }
  handle(m: AnalysisClientMessage) {
    this.handled.push(m);
  }
  retireAll() {}
  close() {
    return Promise.resolve();
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface FakeNode extends Mutable<RoutableNode> {
  opened: RouteContext[];
  channels: FakeChannel[];
}

function node(
  id: string,
  over: Partial<Omit<FakeNode, 'link' | 'opened' | 'channels'>> = {},
): FakeNode {
  const opened: RouteContext[] = [];
  const channels: FakeChannel[] = [];
  return {
    nodeId: id,
    name: `box-${id}`,
    operatorId: 'op000001',
    engines: ENGINES,
    limits: NODE_LIMITS,
    maxSessions: 4,
    pool: false,
    poolShare: 0,
    state: 'online',
    status: null,
    rttMs: 10,
    ...over,
    opened,
    channels,
    link: {
      open(d, _peer, ctx) {
        opened.push(ctx);
        const c = new FakeChannel(d);
        channels.push(c);
        return c;
      },
    },
  };
}

const status = (sessions: number, maxSessions = 4): NodeStatusSnapshot => ({
  sessions,
  maxSessions,
  load1: 0,
  engines: [{ id: 'sf', busy: sessions, idle: 0, degraded: false }],
  at: 0,
});

class FakeRegistry implements RouterRegistry {
  nodes: FakeNode[] = [];
  listeners: Parameters<NonNullable<RouterRegistry['onChange']>>[0][] = [];
  get(id: string) {
    return this.nodes.find((n) => n.nodeId === id);
  }
  poolCandidates() {
    return this.nodes.filter((n) => n.state === 'online' && n.pool && n.poolShare > 0);
  }
  onChange(l: Parameters<NonNullable<RouterRegistry['onChange']>>[0]) {
    this.listeners.push(l);
    return () => {};
  }
  offline(n: FakeNode) {
    this.nodes = this.nodes.filter((x) => x !== n);
    for (const l of this.listeners) l({ type: 'offline', node: n });
  }
}

function token(id: string, over: Partial<TokenRecord> = {}): TokenRecord {
  return {
    id,
    operatorId: 'op000001',
    kind: 'player',
    label: 'Anna iPad',
    nodeIds: [],
    poolFallback: false,
    tier: 'full',
    expiresAt: null,
    revokedAt: null,
    createdAt: 0,
    lastUsedAt: null,
    ...over,
  };
}

let now = 1_000_000;
let registry: FakeRegistry;
let tokens: Map<string, PlayerVerifyResult>;
let budget: Map<string, number | null>;
let local: LocalNode & {
  free: boolean;
  up: boolean;
  channels: FakeChannel[];
  limitsSeen: Limits[];
};
let ipLedger: IpSessionLedger;

function makeLocal(poolShare = 0): typeof local {
  const channels: FakeChannel[] = [];
  const limitsSeen: Limits[] = [];
  const l = {
    name: 'referee-box',
    engines: ENGINES,
    limits: DEFAULT_LIMITS,
    poolShare,
    free: true,
    up: true,
    channels,
    limitsSeen,
    available: () => l.up,
    hasFreeSlot: () => l.free,
    open: (d: Deliver, _p: unknown, limits: Limits) => {
      limitsSeen.push(limits);
      const c = new FakeChannel(d);
      channels.push(c);
      return c;
    },
  };
  return l;
}

function router(over: Partial<HubRouterOptions> = {}) {
  return new HubRouter({
    tokens: {
      verifyPlayerToken: (raw) => tokens.get(String(raw)) ?? { error: 'unknown' },
    },
    registry,
    local,
    operatorName: (id) => (id === 'op000001' ? 'bojan' : undefined),
    ipLedger,
    usage: { search() {}, session() {} },
    budget: { remainingMs: (id) => (budget.has(id) ? budget.get(id)! : null) },
    sessionIdleMs: 60_000,
    restrictedLimits: DEFAULT_LIMITS,
    logger: silent,
    now: () => now,
    ...over,
  });
}

const hello = (t?: string): HelloMessage =>
  t === undefined
    ? { type: 'hello', protocolVersion: 1 }
    : { type: 'hello', protocolVersion: 1, token: t };
const peer = { ip: '198.51.100.1', connId: 1 };
const analyze = (sessionId: string, searchId = 1): AnalyzeMessage => ({
  type: 'analyze',
  sessionId,
  searchId,
  engine: 'sf',
  fen: FEN,
});

function routed(r: RouteResult): AnalysisRoute {
  if (!r.ok) throw new Error(`denied: ${r.reason}`);
  return r.route;
}

function open(route: AnalysisRoute, out: AnalysisServerMessage[] = [], ip = peer.ip) {
  return route.open((m) => out.push(m), { ip, id: 1 });
}

beforeEach(() => {
  now = 1_000_000;
  registry = new FakeRegistry();
  tokens = new Map();
  budget = new Map();
  local = makeLocal();
  ipLedger = new IpSessionLedger(4);
});

describe('tiers', () => {
  it('maps small/standard/full onto the node limits element-wise', () => {
    expect(tierLimits('small', NODE_LIMITS)).toEqual({
      ...NODE_LIMITS,
      maxSessionsPerConnection: 1,
      maxThreads: 2,
      maxMovetimeMs: 60_000,
    });
    expect(tierLimits('standard', NODE_LIMITS)).toEqual({
      ...NODE_LIMITS,
      maxSessionsPerConnection: 2,
      maxMovetimeMs: 600_000,
    });
    expect(tierLimits('full', NODE_LIMITS)).toEqual(NODE_LIMITS);
    // Never above the node: a node with 1 thread stays at 1 for every tier.
    const tiny = { ...NODE_LIMITS, maxThreads: 1, maxMovetimeMs: 30_000 };
    for (const t of ['small', 'standard', 'full'] as TokenTier[]) {
      expect(tierLimits(t, tiny).maxThreads).toBe(1);
      expect(tierLimits(t, tiny).maxMovetimeMs).toBe(30_000);
    }
    expect(TIER_POLICY.small.sessions).toBe(1);
    expect(TIER_POLICY.standard.sessions).toBe(2);
    expect(TIER_POLICY.full.sessions).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('HubRouter: denials', () => {
  it('no_token, bad_token (unknown and wrong), expired, revoked', () => {
    tokens.set('wrong', { error: 'bad_token' });
    tokens.set('old', { error: 'expired' });
    tokens.set('gone', { error: 'revoked' });
    const r = router();
    expect(r.route(hello(), peer)).toEqual({ ok: false, reason: 'no_token' });
    expect(r.route(hello('dc1_unknown'), peer)).toEqual({ ok: false, reason: 'bad_token' });
    expect(r.route(hello('wrong'), peer)).toEqual({ ok: false, reason: 'bad_token' });
    expect(r.route(hello('old'), peer)).toEqual({ ok: false, reason: 'expired' });
    expect(r.route(hello('gone'), peer)).toEqual({ ok: false, reason: 'revoked' });
    expect(r.stats().denials).toEqual({ no_token: 1, bad_token: 2, expired: 1, revoked: 1 });
    expect(r.restrictedLimits).toEqual(DEFAULT_LIMITS);
  });

  it('node_offline: every listed node offline or draining, no pool fallback', () => {
    const draining = node('nodeaaaa', { state: 'draining' });
    registry.nodes.push(draining);
    tokens.set('t', {
      kind: 'token',
      record: token('tok00001', { nodeIds: ['nodeaaaa', 'nodebbbb'] }),
    });
    expect(router().route(hello('t'), peer)).toEqual({
      ok: false,
      reason: 'node_offline',
      tokenId: 'tok00001',
    });
    // `local` listed but the hub's pool is down.
    local.up = false;
    tokens.set('l', {
      kind: 'legacy',
      record: token(LEGACY_TOKEN_ID, { nodeIds: [LOCAL_NODE_ID] }),
    });
    expect(router().route(hello('l'), peer)).toEqual({
      ok: false,
      reason: 'node_offline',
      tokenId: 'legacy',
    });
  });

  it('pool: no_capacity without a candidate, budget_exhausted before scheduling', () => {
    tokens.set('p', {
      kind: 'token',
      record: token('pool0001', { kind: 'pool', tier: 'standard' }),
    });
    expect(router().route(hello('p'), peer)).toEqual({
      ok: false,
      reason: 'no_capacity',
      tokenId: 'pool0001',
    });
    registry.nodes.push(node('nodeaaaa', { pool: true, poolShare: 2 }));
    budget.set('pool0001', 0);
    expect(router().route(hello('p'), peer)).toEqual({
      ok: false,
      reason: 'budget_exhausted',
      tokenId: 'pool0001',
    });
    budget.set('pool0001', 1);
    expect(router().route(hello('p'), peer).ok).toBe(true);
  });

  it("poolFallback with every listed node offline reports the pool's reason", () => {
    tokens.set('t', {
      kind: 'token',
      record: token('tok00001', { nodeIds: ['nodeaaaa'], poolFallback: true }),
    });
    expect(router().route(hello('t'), peer)).toEqual({
      ok: false,
      reason: 'no_capacity',
      tokenId: 'tok00001',
    });
    registry.nodes.push(node('poolpool', { pool: true, poolShare: 1 }));
    budget.set('tok00001', 0);
    expect(router().route(hello('t'), peer)).toEqual({
      ok: false,
      reason: 'budget_exhausted',
      tokenId: 'tok00001',
    });
  });
});

describe('HubRouter: private and local routes', () => {
  it('legacy ACCESS_TOKEN → local, full tier, no pool, welcome.node names the hub', () => {
    tokens.set('legacy', {
      kind: 'legacy',
      record: token(LEGACY_TOKEN_ID, { nodeIds: [LOCAL_NODE_ID] }),
    });
    const r = router();
    const result = r.route(hello('legacy'), peer);
    // The verified token's public id lets the server close its connections on revoke (M24-9).
    expect(result).toMatchObject({ ok: true, tokenId: LEGACY_TOKEN_ID });
    const route = routed(result);
    expect(route.node).toEqual({ name: 'referee-box', shared: false });
    expect(route.limits).toEqual(DEFAULT_LIMITS);
    expect(route.engines.map((e) => e.id)).toEqual(['sf']);
    // Engine defaults are clamped to the route's limits.
    expect(route.engines[0]!.defaults).toEqual({ threads: DEFAULT_LIMITS.maxThreads, hash: 256 });
    open(route);
    expect(local.channels).toHaveLength(1);
    expect(local.limitsSeen).toEqual([DEFAULT_LIMITS]);
    expect(r.stats().routes).toEqual({ local: 1, private: 0, pool: 0 });
    // The full tier has no per-token cap: many devices share the legacy token.
    for (let i = 0; i < 3; i++) {
      const ch = open(routed(r.route(hello('legacy'), peer)), [], `203.0.113.${i}`);
      ch.handle(analyze('a'));
      ch.handle(analyze('b'));
    }
    expect(local.channels.slice(1).every((c) => c.handled.length === 2)).toBe(true);
  });

  it('first listed node that is online with a free slot wins; welcome names node and operator', () => {
    const a = node('nodeaaaa', { status: status(4) }); // full
    const b = node('nodebbbb', { name: 'fast-box', status: status(1) });
    registry.nodes.push(a, b);
    tokens.set('t', {
      kind: 'token',
      record: token('tok00001', { nodeIds: ['nodexxxx', 'nodeaaaa', 'nodebbbb'], tier: 'small' }),
    });
    const r = router();
    const route = routed(r.route(hello('t'), peer));
    expect(route.node).toEqual({ name: 'fast-box', operator: 'bojan', shared: false });
    expect(route.limits).toEqual(tierLimits('small', NODE_LIMITS));
    expect(route.engines[0]!.defaults.threads).toBe(2);
    const ch = open(route);
    expect(b.opened).toEqual([
      {
        limits: tierLimits('small', NODE_LIMITS),
        shared: false,
        tier: 'small',
        tokenId: 'tok00001',
        label: 'Anna iPad',
      },
    ]);
    // The analyze reaches the node with the clamped default threads.
    ch.handle(analyze('s'));
    expect(b.channels[0]!.handled[0]).toMatchObject({ threads: 2, hash: 256 });
    expect(r.stats().routes.private).toBe(1);
  });

  it('a full but online listed node is the last resort (no fallback, or the pool is full too)', () => {
    const a = node('nodeaaaa', { status: status(4) });
    registry.nodes.push(a);
    tokens.set('t', { kind: 'token', record: token('tok00001', { nodeIds: ['nodeaaaa'] }) });
    expect(routed(router().route(hello('t'), peer)).node?.name).toBe('box-nodeaaaa');
    tokens.set('f', {
      kind: 'token',
      record: token('tok00002', { nodeIds: ['nodeaaaa'], poolFallback: true }),
    });
    expect(routed(router().route(hello('f'), peer)).node).toMatchObject({ shared: false });
  });

  it('poolFallback: listed nodes offline/full → pool (shared, no token id or label on the link)', () => {
    registry.nodes.push(node('nodeaaaa', { status: status(4) }));
    const p = node('poolpool', {
      pool: true,
      poolShare: 2,
      operatorId: 'op000002',
      name: 'donated',
    });
    registry.nodes.push(p);
    tokens.set('t', {
      kind: 'token',
      record: token('tok00001', { nodeIds: ['nodeaaaa'], poolFallback: true, tier: 'standard' }),
    });
    const route = routed(router().route(hello('t'), peer));
    expect(route.node).toEqual({ name: 'donated', shared: true });
    open(route);
    expect(p.opened).toEqual([
      { limits: tierLimits('standard', NODE_LIMITS), shared: true, tier: 'standard' },
    ]);
  });
});

describe('HubRouter: pool scheduling', () => {
  const poolToken = (id = 'pool0001') => {
    tokens.set(id, { kind: 'token', record: token(id, { kind: 'pool', tier: 'standard' }) });
    return id;
  };

  it('least relative load weighted by poolShare; load counts open pool sessions', () => {
    const small = node('smallnod', { pool: true, poolShare: 2, rttMs: 5 });
    const big = node('bignode0', { pool: true, poolShare: 8, rttMs: 50 });
    registry.nodes.push(small, big);
    const r = router({ stickyMs: 0 });
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const t = poolToken(`pool000${i}`);
      const route = routed(r.route(hello(t), peer));
      picks.push(route.node!.name);
      open(route, [], `203.0.113.${i}`).handle(analyze('s'));
    }
    // Equal free share → lower RTT; then proportionally: small 1/2 vs big 8/8 etc.
    expect(picks).toEqual([
      'box-smallnod',
      'box-bignode0',
      'box-bignode0',
      'box-bignode0',
      'box-bignode0',
      'box-smallnod',
    ]);
    expect(r.stats().poolLoad).toEqual({ smallnod: 2, bignode0: 4 });
  });

  it('skips nodes with a full status, an exhausted share or only degraded engines; local joins with its share', () => {
    const full = node('fullnode', { pool: true, poolShare: 4, status: status(4) });
    const degraded = node('degraded', {
      pool: true,
      poolShare: 4,
      status: { ...status(0), engines: [{ id: 'sf', busy: 0, idle: 1, degraded: true }] },
    });
    registry.nodes.push(full, degraded);
    local = makeLocal(1);
    const r = router({ stickyMs: 0 });
    const route = routed(r.route(hello(poolToken()), peer));
    expect(route.node).toEqual({ name: 'referee-box', shared: true });
    open(route).handle(analyze('s'));
    // local's share (1) is used up now.
    expect(r.route(hello(poolToken('pool0002')), peer)).toEqual({
      ok: false,
      reason: 'no_capacity',
      tokenId: 'pool0002',
    });
    expect(r.stats().routes).toEqual({ local: 0, private: 0, pool: 1 });
  });

  it('a release gives the pool slot back', () => {
    registry.nodes.push(node('onlyone0', { pool: true, poolShare: 1 }));
    const r = router({ stickyMs: 0 });
    const ch = open(routed(r.route(hello(poolToken()), peer)));
    ch.handle(analyze('s'));
    expect(r.route(hello(poolToken('pool0002')), peer).ok).toBe(false);
    ch.handle({ type: 'release', sessionId: 's' });
    expect(r.route(hello(poolToken('pool0002')), peer).ok).toBe(true);
  });

  it('sticky: a token keeps its pool node for 10 minutes while it is a candidate', () => {
    const a = node('nodeaaaa', { pool: true, poolShare: 4, rttMs: 5 });
    const b = node('nodebbbb', { pool: true, poolShare: 4, rttMs: 50 });
    registry.nodes.push(a, b);
    const r = router();
    const t = poolToken();
    expect(routed(r.route(hello(t), peer)).node!.name).toBe('box-nodeaaaa');
    // Load a so b scores better for everybody else.
    open(routed(r.route(hello(poolToken('pool0002')), peer)));
    a.status = status(0);
    for (let i = 0; i < 2; i++) {
      const ch = open(routed(r.route(hello(t), peer)), [], `203.0.113.${i}`);
      ch.handle(analyze(`s${i}`));
    }
    expect(r.stats().poolLoad).toEqual({ nodeaaaa: 2 });
    expect(routed(r.route(hello(poolToken('pool0003')), peer)).node!.name).toBe('box-nodebbbb');
    expect(routed(r.route(hello(t), peer)).node!.name).toBe('box-nodeaaaa'); // sticky
    now += 10 * MIN;
    expect(routed(r.route(hello(t), peer)).node!.name).toBe('box-nodebbbb'); // expired
    // Sticky node no longer a candidate → normal scheduling.
    registry.nodes = registry.nodes.filter((n) => n !== b);
    expect(routed(r.route(hello(t), peer)).node!.name).toBe('box-nodeaaaa');
  });

  it('failure penalty: engine_crashed or an unplanned loss demotes a node for 10 minutes', () => {
    const a = node('nodeaaaa', { pool: true, poolShare: 4, rttMs: 5 });
    const b = node('nodebbbb', { pool: true, poolShare: 4, rttMs: 50 });
    registry.nodes.push(a, b);
    const r = router({ stickyMs: 0 });
    const out: AnalysisServerMessage[] = [];
    const ch = open(routed(r.route(hello(poolToken()), peer)), out);
    ch.handle(analyze('s'));
    a.channels[0]!.deliver({
      type: 'error',
      code: 'engine_crashed',
      message: 'x',
      sessionId: 's',
      searchId: 1,
    });
    expect(out).toHaveLength(1);
    ch.handle({ type: 'release', sessionId: 's' });
    expect(r.stats().poolLoad).toEqual({});
    expect(routed(r.route(hello(poolToken('pool0002')), peer)).node!.name).toBe('box-nodebbbb');
    now += 10 * MIN;
    expect(routed(r.route(hello(poolToken('pool0003')), peer)).node!.name).toBe('box-nodeaaaa');
    // A node lost (not drained) is penalised once it comes back.
    registry.offline(a);
    registry.nodes.push(a);
    expect(routed(r.route(hello(poolToken('pool0004')), peer)).node!.name).toBe('box-nodebbbb');
    // A drained node is not.
    now += 10 * MIN;
    registry.offline(node('nodebbbb', { state: 'draining' }));
    expect(routed(r.route(hello(poolToken('pool0005')), peer)).node!.name).toBe('box-nodeaaaa');
  });

  it('per-token cap of the tier applies across connections; the budget is checked per analyze on pool routes', () => {
    registry.nodes.push(node('nodeaaaa', { pool: true, poolShare: 8 }));
    const r = router({ stickyMs: 0 });
    const t = poolToken(); // standard: 2 sessions per token
    const outs: AnalysisServerMessage[][] = [[], [], []];
    for (let i = 0; i < 3; i++) {
      open(routed(r.route(hello(t), peer)), outs[i], `203.0.113.${i}`).handle(analyze('s'));
    }
    expect(outs[2]).toEqual([expect.objectContaining({ code: 'limit_exceeded', sessionId: 's' })]);
    expect(r.stats().tokenSlots).toBe(1);
    const out: AnalysisServerMessage[] = [];
    const t2 = poolToken('pool0009');
    const ch = open(routed(r.route(hello(t2), peer)), out, '203.0.113.9');
    budget.set('pool0009', 0);
    ch.handle(analyze('x'));
    expect(out).toEqual([
      expect.objectContaining({ code: 'no_capacity', message: 'daily pool budget exhausted' }),
    ]);
  });
});
