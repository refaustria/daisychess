import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LIMITS,
  type AnalyzeMessage,
  type InfoMessage,
  type Limits,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { AnalysisChannel } from '../sessions/AnalysisChannel.js';
import type {
  AnalysisClientMessage,
  AnalysisServerMessage,
  Deliver,
} from '../sessions/ClientSessions.js';
import { IpSessionLedger } from '../ws/clientIp.js';
import {
  AccountingChannel,
  TokenSessionLedger,
  type AccountingChannelOptions,
  type BudgetSource,
  type ObservedSearch,
} from './AccountingChannel.js';

const silent: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };
const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const IDLE = 60_000;

/** Records what reaches it; `emit` plays the engine side. */
class FakeInner implements AnalysisChannel {
  readonly handled: AnalysisClientMessage[] = [];
  retired = 0;
  closed = false;
  lost?: Promise<void>;
  constructor(readonly deliver: Deliver) {}
  get sessionCount(): number {
    return 0;
  }
  handle(msg: AnalysisClientMessage): void {
    this.handled.push(msg);
  }
  retireAll(): void {
    this.retired++;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  emit(msg: AnalysisServerMessage): void {
    this.deliver(msg);
  }
  bestmove(sessionId: string, searchId: number): void {
    this.emit({ type: 'bestmove', sessionId, searchId, bestMove: null, reason: 'completed' });
  }
}

const analyze = (sessionId: string, searchId: number, extra: Partial<AnalyzeMessage> = {}) =>
  ({ type: 'analyze', sessionId, searchId, engine: 'sf', fen: FEN, ...extra }) as AnalyzeMessage;

let now = 1_000_000;
let ipLedger: IpSessionLedger;
let tokenLedger: TokenSessionLedger;
let usage: {
  searches: { tokenId: string; nodeId: string; engineMs: number; at: number }[];
  sessions: number;
};

function make(over: Partial<AccountingChannelOptions> & { tokenCap?: number; ip?: string } = {}) {
  const out: AnalysisServerMessage[] = [];
  let inner!: FakeInner;
  const limits: Limits = { ...DEFAULT_LIMITS, maxMovetimeMs: 5_000, ...over.limits };
  const { tokenCap, ip, ...rest } = over;
  const ch = new AccountingChannel(
    (d) => (inner = new FakeInner(d)),
    (m) => out.push(m),
    {
      limits,
      sessionIdleMs: IDLE,
      logger: silent,
      slots: { ip: ipLedger, token: tokenLedger.forCap(tokenCap ?? 2) },
      keys: { ip: ip ?? '198.51.100.1', tokenId: 'tok00001', nodeId: 'node0001', connId: 1 },
      shared: false,
      usage: {
        search: (u) => usage.searches.push(u),
        session: () => usage.sessions++,
      },
      now: () => now,
      ...rest,
    },
  );
  return { ch, inner, out };
}

beforeEach(() => {
  now = 1_000_000;
  ipLedger = new IpSessionLedger(2);
  tokenLedger = new TokenSessionLedger();
  usage = { searches: [], sessions: 0 };
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AccountingChannel: slots', () => {
  it('reserves one IP and one token slot at the first analyze of a session; release frees them', () => {
    const { ch, inner } = make();
    ch.handle(analyze('a', 1));
    ch.handle(analyze('a', 2));
    expect(ipLedger.count('198.51.100.1')).toBe(1);
    expect(tokenLedger.count('tok00001')).toBe(1);
    expect(ch.sessionCount).toBe(1);
    expect(usage.sessions).toBe(1);
    ch.handle({ type: 'release', sessionId: 'a' });
    expect(ipLedger.count('198.51.100.1')).toBe(0);
    expect(tokenLedger.count('tok00001')).toBe(0);
    expect(inner.handled.map((m) => m.type)).toEqual(['analyze', 'analyze', 'release']);
  });

  it('per-IP cap across channels: no_capacity locally, nothing relayed', () => {
    const one = make({ tokenCap: 10 });
    const two = make({ tokenCap: 10 });
    one.ch.handle(analyze('a', 1));
    one.ch.handle(analyze('b', 1));
    two.ch.handle(analyze('c', 1));
    expect(two.out).toEqual([
      expect.objectContaining({ type: 'error', code: 'no_capacity', sessionId: 'c', searchId: 1 }),
    ]);
    expect(two.inner.handled).toEqual([]);
    expect(tokenLedger.count('tok00001')).toBe(2);
    // Another address is not affected.
    const other = make({ tokenCap: 10, ip: '203.0.113.7' });
    other.ch.handle(analyze('d', 1));
    expect(other.inner.handled).toHaveLength(1);
  });

  it('per-token cap (tier sessions) across connections: limit_exceeded, the IP slot is returned', () => {
    const one = make({ tokenCap: 1, ip: '203.0.113.1' });
    const two = make({ tokenCap: 1, ip: '203.0.113.2' });
    one.ch.handle(analyze('a', 1));
    two.ch.handle(analyze('a', 1));
    expect(two.out[0]).toMatchObject({
      code: 'limit_exceeded',
      message: 'at most 1 sessions per token',
    });
    expect(ipLedger.count('203.0.113.2')).toBe(0);
    expect(two.inner.handled).toEqual([]);
  });

  it('per-connection cap from the route limits', () => {
    const { ch, inner, out } = make({
      limits: { ...DEFAULT_LIMITS, maxSessionsPerConnection: 1 },
      tokenCap: 5,
    });
    ch.handle(analyze('a', 1));
    ch.handle(analyze('b', 1));
    expect(out[0]).toMatchObject({ code: 'limit_exceeded', sessionId: 'b', searchId: 1 });
    expect(inner.handled).toHaveLength(1);
  });

  it('a session-level error and a refused first search free the slots; a served session keeps them', () => {
    const { ch, inner } = make();
    ch.handle(analyze('a', 1));
    inner.emit({ type: 'error', code: 'engine_crashed', message: 'x', sessionId: 'a' });
    expect(ch.sessionCount).toBe(0);
    // The node is full: the first search of a fresh session is refused → slots back.
    ch.handle(analyze('b', 1));
    inner.emit({
      type: 'error',
      code: 'no_capacity',
      message: 'busy',
      sessionId: 'b',
      searchId: 1,
    });
    expect(ch.sessionCount).toBe(0);
    expect(ipLedger.total).toBe(0);
    // Served once: a later refusal leaves the session open (idle timer takes over).
    ch.handle(analyze('c', 1));
    inner.bestmove('c', 1);
    ch.handle(analyze('c', 2, { engine: 'nope' }));
    inner.emit({
      type: 'error',
      code: 'unknown_engine',
      message: 'x',
      sessionId: 'c',
      searchId: 2,
    });
    expect(ch.sessionCount).toBe(1);
  });

  it('frees an idle session after sessionIdleMs without an open search; new work cancels it', () => {
    vi.useFakeTimers();
    const { ch, inner } = make();
    ch.handle(analyze('a', 1));
    vi.advanceTimersByTime(IDLE * 2);
    expect(ch.sessionCount).toBe(1); // a search is running: never idle
    inner.bestmove('a', 1);
    vi.advanceTimersByTime(IDLE - 1);
    ch.handle(analyze('a', 2)); // cancels the timer
    inner.bestmove('a', 2);
    vi.advanceTimersByTime(IDLE - 1);
    expect(ch.sessionCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(ch.sessionCount).toBe(0);
    expect(ipLedger.total).toBe(0);
    // Reopened later: slots are reserved again.
    ch.handle(analyze('a', 3));
    expect(ipLedger.total).toBe(1);
    expect(usage.sessions).toBe(2);
  });

  it('retireAll and close free every slot; close forwards and delivers nothing afterwards', async () => {
    const { ch, inner, out } = make();
    ch.handle(analyze('a', 1));
    ch.handle(analyze('b', 1));
    ch.retireAll();
    expect(inner.retired).toBe(1);
    expect(ipLedger.total).toBe(0);
    ch.handle(analyze('c', 1));
    await ch.close();
    expect(inner.closed).toBe(true);
    expect(tokenLedger.tokens).toBe(0);
    inner.bestmove('c', 1);
    ch.handle(analyze('d', 1));
    expect(out).toEqual([]);
    expect(inner.handled.map((m) => m.sessionId)).toEqual(['a', 'b', 'c']);
  });

  it("reports session deltas and engine failures; forwards the inner channel's lost promise", () => {
    const deltas: number[] = [];
    const failures: number[] = [];
    const { ch, inner } = make({
      onSessionDelta: (d) => deltas.push(d),
      onEngineFailure: () => failures.push(1),
    });
    ch.handle(analyze('a', 1));
    inner.emit({
      type: 'error',
      code: 'engine_crashed',
      message: 'x',
      sessionId: 'a',
      searchId: 1,
    });
    ch.handle({ type: 'release', sessionId: 'a' });
    expect(deltas).toEqual([1, -1]);
    expect(failures).toEqual([1]);
    expect(ch.lost).toBeUndefined();
    inner.lost = Promise.resolve();
    expect(ch.lost).toBe(inner.lost);
  });
});

describe('AccountingChannel: limits, defaults, rate', () => {
  it('rejects over-limit analyzes locally and fills in clamped engine defaults', () => {
    const { ch, inner, out } = make({
      limits: { ...DEFAULT_LIMITS, maxThreads: 2 },
      engineDefaults: new Map([['sf', { threads: 2, hash: 64 }]]),
    });
    ch.handle(analyze('a', 1, { threads: 3 }));
    expect(out[0]).toMatchObject({ code: 'limit_exceeded', sessionId: 'a', searchId: 1 });
    expect(ch.sessionCount).toBe(0);
    ch.handle(analyze('a', 2));
    ch.handle(analyze('a', 3, { threads: 1, hash: 16 }));
    expect(inner.handled).toEqual([
      expect.objectContaining({ searchId: 2, threads: 2, hash: 64 }),
      expect.objectContaining({ searchId: 3, threads: 1, hash: 16 }),
    ]);
  });

  it('rate-limits analyze before relaying', () => {
    const { ch, inner, out } = make({ analyzeRateLimit: { max: 2, windowMs: 1_000 } });
    for (let i = 1; i <= 3; i++) ch.handle(analyze('a', i));
    expect(inner.handled).toHaveLength(2);
    expect(out[0]).toMatchObject({ code: 'rate_limited', searchId: 3 });
    now += 1_000;
    ch.handle(analyze('a', 4));
    expect(inner.handled).toHaveLength(3);
  });
});

describe('AccountingChannel: usage and budget', () => {
  it('meters wall time analyze → terminal, capped at maxMovetimeMs + 2 s', async () => {
    const { ch, inner } = make();
    ch.handle(analyze('a', 1));
    now += 1_234;
    inner.bestmove('a', 1);
    ch.handle(analyze('a', 2));
    now += 60_000;
    inner.emit({
      type: 'error',
      code: 'engine_crashed',
      message: 'x',
      sessionId: 'a',
      searchId: 2,
    });
    // A terminal for an unknown search is not metered.
    inner.bestmove('a', 99);
    // Running at close: metered up to the close.
    ch.handle(analyze('b', 1));
    now += 500;
    await ch.close();
    expect(usage.searches).toEqual([
      { tokenId: 'tok00001', nodeId: 'node0001', engineMs: 1_234, at: 1_001_234 },
      { tokenId: 'tok00001', nodeId: 'node0001', engineMs: 7_000, at: 1_061_234 },
      { tokenId: 'tok00001', nodeId: 'node0001', engineMs: 500, at: 1_061_734 },
    ]);
  });

  /** A budget fed by the channel's own metering, like the hub store. */
  function meteredBudget(totalMs: number): BudgetSource & { used: () => number } {
    return {
      remainingMs: () => Math.max(0, totalMs - usage.searches.reduce((s, u) => s + u.engineMs, 0)),
      used: () => usage.searches.reduce((s, u) => s + u.engineMs, 0),
    };
  }

  it('pool routes: no_capacity "daily pool budget exhausted" before each analyze; private routes are not checked', () => {
    const empty: BudgetSource = { remainingMs: () => 0 };
    const pool = make({ shared: true, budget: empty });
    pool.ch.handle(analyze('a', 1));
    expect(pool.out).toEqual([
      {
        type: 'error',
        code: 'no_capacity',
        message: 'daily pool budget exhausted',
        sessionId: 'a',
        searchId: 1,
      },
    ]);
    expect(pool.inner.handled).toEqual([]);
    expect(ipLedger.total).toBe(0);
    const priv = make({ shared: false, budget: empty });
    priv.ch.handle(analyze('a', 1));
    expect(priv.inner.handled).toHaveLength(1);
    const unlimited = make({ shared: true, budget: { remainingMs: () => null } });
    unlimited.ch.handle(analyze('x', 1));
    expect(unlimited.inner.handled).toHaveLength(1);
  });

  it('an endless search overruns the budget by at most one metered search', () => {
    const budget = meteredBudget(10_000);
    const { ch, inner, out } = make({ shared: true, budget, tokenCap: 5 });
    const cap = 5_000 + 2_000;
    ch.handle(analyze('a', 1));
    now += 3_000;
    // While a search runs, its elapsed time counts against the budget already.
    ch.handle(analyze('b', 1));
    expect(inner.handled).toHaveLength(2);
    now += 30_000; // both run far beyond any cap (a misbehaving node)
    ch.handle(analyze('c', 1));
    expect(out.at(-1)).toMatchObject({ code: 'no_capacity', sessionId: 'c' });
    inner.bestmove('a', 1);
    inner.bestmove('b', 1);
    expect(budget.used()).toBe(2 * cap);
    // Spent: every further analyze is refused locally, on any session.
    ch.handle(analyze('a', 2));
    expect(out.at(-1)).toMatchObject({
      code: 'no_capacity',
      message: 'daily pool budget exhausted',
    });
    expect(inner.handled).toHaveLength(2);
    // The overrun is bounded: at most one capped search per session that was admitted.
    expect(budget.used() - 10_000).toBeLessThanOrEqual(cap * 2);
  });

  it('sequential searches stop at the budget with at most one search of overrun', () => {
    const budget = meteredBudget(10_000);
    const { ch, inner } = make({ shared: true, budget });
    let admitted = 0;
    for (let i = 1; i <= 10; i++) {
      const before = inner.handled.length;
      ch.handle(analyze('a', i));
      if (inner.handled.length === before) break;
      admitted++;
      now += 4_000;
      inner.bestmove('a', i);
    }
    expect(admitted).toBe(3); // 0, 4 and 8 s used before: the third overruns by 2 s
    expect(budget.used()).toBe(12_000);
    expect(budget.used() - 10_000).toBeLessThan(5_000 + 2_000);
  });
});

describe('AccountingChannel: search observation for spot-checks (M24-12)', () => {
  const info = (
    sessionId: string,
    searchId: number,
    depth: number,
    multipv = 1,
    cp = 20,
  ): InfoMessage => ({
    type: 'info',
    sessionId,
    searchId,
    info: { depth, multipv, score: { cp }, pv: ['d2d4'] },
  });

  it('reports a finished search with the last multipv-1 info and its bestmove', () => {
    const results: ObservedSearch[] = [];
    const { ch, inner, out } = make({ onSearchResult: (r) => results.push(r) });
    ch.handle(analyze('s1', 1, { multipv: 2 }));
    inner.emit(info('s1', 1, 11, 1, 25));
    inner.emit(info('s1', 1, 11, 2, -40));
    inner.emit(info('s1', 1, 12, 1, 18));
    inner.emit(info('s1', 1, 12, 2, -55));
    inner.emit({
      type: 'bestmove',
      sessionId: 's1',
      searchId: 1,
      bestMove: { move: 'd2d4', ponder: 'd7d5' },
      reason: 'stopped',
    });
    expect(results).toEqual([
      { engine: 'sf', fen: FEN, depth: 12, bestMove: 'd2d4', score: { cp: 18 }, reason: 'stopped' },
    ]);
    // The player still sees everything unchanged.
    expect(out).toHaveLength(5);
  });

  it('reports nothing without info, for bestmove null, errors, unknown searches or after close', async () => {
    const results: ObservedSearch[] = [];
    const { ch, inner } = make({ onSearchResult: (r) => results.push(r) });
    ch.handle(analyze('s1', 1));
    inner.emit({
      type: 'bestmove',
      sessionId: 's1',
      searchId: 1,
      bestMove: { move: 'e2e4' },
      reason: 'completed',
    });
    ch.handle(analyze('s1', 2));
    inner.emit(info('s1', 2, 15));
    inner.bestmove('s1', 2); // bestMove null
    ch.handle(analyze('s1', 3));
    inner.emit(info('s1', 3, 15));
    inner.emit({
      type: 'error',
      code: 'engine_crashed',
      message: 'x',
      sessionId: 's1',
      searchId: 3,
    });
    ch.handle(analyze('s2', 1));
    inner.emit(info('s2', 1, 15));
    inner.emit({ type: 'error', code: 'internal_error', message: 'x', sessionId: 's2' });
    inner.emit({
      type: 'bestmove',
      sessionId: 's2',
      searchId: 1,
      bestMove: { move: 'e2e4' },
      reason: 'completed',
    });
    inner.emit(info('zz', 9, 15));
    ch.handle(analyze('s1', 4));
    inner.emit(info('s1', 4, 15));
    await ch.close();
    inner.emit({
      type: 'bestmove',
      sessionId: 's1',
      searchId: 4,
      bestMove: { move: 'e2e4' },
      reason: 'completed',
    });
    expect(results).toEqual([]);
  });

  it('keeps no position state without onSearchResult; a throwing sink does not break delivery', () => {
    const { ch, inner, out } = make({
      onSearchResult: () => {
        throw new Error('boom');
      },
    });
    ch.handle(analyze('s1', 1));
    inner.emit(info('s1', 1, 12));
    inner.emit({
      type: 'bestmove',
      sessionId: 's1',
      searchId: 1,
      bestMove: { move: 'd2d4' },
      reason: 'completed',
    });
    expect(out.map((m) => m.type)).toEqual(['info', 'bestmove']);
    const plain = make();
    plain.ch.handle(analyze('s1', 1));
    expect((plain.ch as unknown as { observed: Map<string, unknown> }).observed.size).toBe(0);
  });

  it('reports the number of open searches as deltas, down to 0 on close', async () => {
    const deltas: number[] = [];
    const { ch, inner } = make({ onSearchDelta: (d) => deltas.push(d) });
    ch.handle(analyze('s1', 1));
    ch.handle(analyze('s1', 2)); // replaces; the first still owes its terminal
    inner.bestmove('s1', 1);
    ch.handle(analyze('s2', 1));
    await ch.close();
    expect(deltas).toEqual([1, 1, -1, 1, -2]);
  });
});
