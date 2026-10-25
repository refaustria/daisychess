import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeMessage, EngineDescriptor, EngineInfo, Limits } from '@daisychess/engine-core';
import type { ExitInfo, GoParams, SearchResult, UciOptions } from '../engines/UciProcess.js';
import { IpSessionLedger } from '../ws/clientIp.js';
import type {
  AcquireOptions,
  AnalysisBackend,
  BackendAcquireResult,
  BackendEngine,
  BackendLease,
} from './AnalysisBackend.js';
import {
  ClientSessions,
  type AnalysisServerMessage,
  type ClientSessionsOptions,
} from './ClientSessions.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const INFO: EngineInfo = { depth: 1, multipv: 1, score: { cp: 20 }, pv: ['e2e4'] };
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const LIMITS: Limits = {
  maxDepth: 30,
  maxMultipv: 5,
  maxThreads: 4,
  maxHash: 256,
  maxMovetimeMs: 60_000,
  maxSessionsPerConnection: 3,
};
const ENGINES: EngineDescriptor[] = [
  { id: 'fake', name: 'Fake', enabled: true, defaults: { threads: 1, hash: 16 } },
  { id: 'other', name: 'Other', enabled: true, defaults: { threads: 2, hash: 32 } },
  { id: 'off', name: 'Off', enabled: false, defaults: { threads: 1, hash: 16 } },
];

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Scriptable engine: searches run until the test (or `stop`, unless `ignoreStop`) ends them. */
class FakeEngine implements BackendEngine {
  readonly pid = 4242;
  readonly options: UciOptions[] = [];
  readonly positions: string[] = [];
  readonly goes: GoParams[] = [];
  stops = 0;
  ignoreStop = false;
  /** Answer `stop` with `bestmove` a macrotask later (as a real engine does). */
  asyncStop = false;
  failSetOptions = false;
  private search: { done: Deferred<SearchResult>; onInfo: (i: EngineInfo) => void } | null = null;
  private exitListeners = new Set<(e: ExitInfo) => void>();

  async setOptions(options: UciOptions): Promise<void> {
    this.options.push(options);
    if (this.failSetOptions) throw new Error('readyok timeout');
  }
  position(fen: string): void {
    this.positions.push(fen);
  }
  go(params: GoParams, onInfo: (info: EngineInfo) => void): Promise<SearchResult> {
    this.goes.push(params);
    const done = deferred<SearchResult>();
    this.search = { done, onInfo };
    return done.promise;
  }
  stop(): Promise<SearchResult | null> {
    this.stops++;
    if (this.ignoreStop) return Promise.resolve(null);
    if (this.asyncStop) setImmediate(() => this.finish({ bestMove: { move: 'e2e4' } }));
    else this.finish({ bestMove: { move: 'e2e4' } });
    return Promise.resolve(null);
  }
  onExit(cb: (e: ExitInfo) => void): () => void {
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }
  get searching(): boolean {
    return this.search !== null;
  }
  info(info: EngineInfo = INFO): void {
    this.search?.onInfo(info);
  }
  finish(result: SearchResult = { bestMove: { move: 'e2e4' } }): void {
    const s = this.search;
    this.search = null;
    s?.done.resolve(result);
  }
  crash(): void {
    const s = this.search;
    this.search = null;
    for (const cb of [...this.exitListeners])
      cb({ code: null, signal: 'SIGKILL', expected: false, stderr: [] });
    s?.done.reject(new Error('exited'));
  }
}

class FakeBackend implements AnalysisBackend {
  readonly engines: FakeEngine[] = [];
  readonly acquires: { engineId: string; opts: AcquireOptions }[] = [];
  readonly released: BackendLease[] = [];
  readonly healthy: BackendLease[] = [];
  failWith: Extract<BackendAcquireResult, { ok: false }> | null = null;
  /** When set, `acquire` waits for it. */
  gate: Deferred<void> | null = null;
  private nextId = 1;
  private held = 0;

  async acquire(engineId: string, opts: AcquireOptions): Promise<BackendAcquireResult> {
    this.acquires.push({ engineId, opts });
    if (this.gate) await this.gate.promise;
    if (this.failWith) return this.failWith;
    const engine = new FakeEngine();
    this.engines.push(engine);
    this.held++;
    const lease = { id: this.nextId++, engineId, engine, released: false };
    return { ok: true, lease };
  }
  async release(lease: BackendLease): Promise<void> {
    if (this.released.includes(lease)) return;
    this.released.push(lease);
    this.held--;
  }
  reportHealthy(lease: BackendLease): void {
    this.healthy.push(lease);
  }
  health() {
    return { available: true, sessions: this.held };
  }
  get engine(): FakeEngine {
    const e = this.engines.at(-1);
    if (!e) throw new Error('no engine leased');
    return e;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
}

function analyze(searchId: number, extra: Partial<AnalyzeMessage> = {}): AnalyzeMessage {
  return { type: 'analyze', sessionId: 's1', searchId, engine: 'fake', fen: FEN, ...extra };
}

function setup(over: Partial<ClientSessionsOptions> = {}, peer = { ip: '203.0.113.7', id: 1 }) {
  const backend = (over.backend as FakeBackend | undefined) ?? new FakeBackend();
  const ledger = (over.ledger as IpSessionLedger | undefined) ?? new IpSessionLedger(10);
  const out: AnalysisServerMessage[] = [];
  const sessions = new ClientSessions((m) => out.push(m), peer, {
    limits: LIMITS,
    engines: ENGINES,
    logger: silent,
    sessionIdleMs: 60_000,
    stopTimeoutMs: 1_000,
    ...over,
    backend,
    ledger,
  });
  return { sessions, backend, ledger, out };
}

const terminals = (out: AnalysisServerMessage[]) =>
  out.filter((m) => m.type === 'bestmove' || (m.type === 'error' && m.searchId !== undefined));

afterEach(() => {
  vi.useRealTimers();
});

describe('ClientSessions', () => {
  it('runs a search: options, position, go, info, bestmove completed; reports the engine healthy', async () => {
    const { sessions, backend, out } = setup();
    sessions.handle(analyze(1, { depth: 12, multipv: 2 }));
    await settle();
    const e = backend.engine;
    expect(backend.acquires).toEqual([{ engineId: 'fake', opts: { peerId: 1, sessionId: 's1' } }]);
    expect(e.options).toEqual([{ Threads: 1, Hash: 16, MultiPV: 2 }]);
    expect(e.positions).toEqual([FEN]);
    expect(e.goes).toEqual([{ depth: 12 }]);
    e.info();
    e.finish({ bestMove: { move: 'e2e4', ponder: 'e7e5' } });
    await settle();
    expect(out).toEqual([
      { type: 'info', sessionId: 's1', searchId: 1, info: INFO },
      {
        type: 'bestmove',
        sessionId: 's1',
        searchId: 1,
        bestMove: { move: 'e2e4', ponder: 'e7e5' },
        reason: 'completed',
      },
    ]);
    expect(backend.healthy).toHaveLength(1);
    expect(sessions.sessionCount).toBe(1);
  });

  it('re-sends the last info with the policy before bestmove (ADR-019)', async () => {
    const { sessions, backend, out } = setup();
    sessions.handle(analyze(1, { depth: 1 }));
    await settle();
    backend.engine.info();
    backend.engine.finish({ bestMove: { move: 'e2e4' }, policy: [{ uci: 'e2e4', p: 0.5 }] });
    await settle();
    expect(out.map((m) => m.type)).toEqual(['info', 'info', 'bestmove']);
    expect(out[1]).toMatchObject({ info: { ...INFO, policy: [{ uci: 'e2e4', p: 0.5 }] } });
  });

  it('orders a new analyze after the old search: bestmove(1, stopped) precedes every info of 2', async () => {
    const { sessions, backend, out } = setup();
    sessions.handle(analyze(1));
    await settle();
    const e = backend.engine;
    e.asyncStop = true;
    e.info();
    sessions.handle(analyze(2));
    // While the stop is in flight, the engine still emits a late info of search 1.
    e.info();
    await settle();
    expect(e.stops).toBe(1);
    e.info({ ...INFO, depth: 2 });
    e.finish();
    await settle();
    const seq = out.map((m) => `${m.type}:${'searchId' in m ? m.searchId : '-'}`);
    expect(seq).toEqual(['info:1', 'info:1', 'bestmove:1', 'info:2', 'bestmove:2']);
    expect(out[2]).toMatchObject({ reason: 'stopped' });
    // The engine is reused: one lease, two goes.
    expect(backend.acquires).toHaveLength(1);
    expect(e.goes).toHaveLength(2);
  });

  it('terminates superseded queued analyzes without reaching the engine: exactly one terminal each', async () => {
    const { sessions, backend, out } = setup();
    sessions.handle(analyze(1));
    sessions.handle(analyze(2));
    sessions.handle(analyze(3));
    await settle();
    backend.engine.finish();
    await settle();
    const t = terminals(out);
    expect(t.map((m) => m.searchId)).toEqual([1, 2, 3]);
    expect(t[0]).toMatchObject({ type: 'bestmove', bestMove: null, reason: 'stopped' });
    expect(t[1]).toMatchObject({ type: 'bestmove', bestMove: null, reason: 'stopped' });
    expect(t[2]).toMatchObject({ type: 'bestmove', reason: 'completed' });
    expect(backend.engine.goes).toHaveLength(1);
  });

  it('stop ends the search with bestmove stopped and supersedes queued analyzes', async () => {
    const { sessions, backend, out } = setup();
    sessions.handle(analyze(1));
    await settle();
    sessions.handle(analyze(2));
    sessions.handle({ type: 'stop', sessionId: 's1' });
    await settle();
    expect(terminals(out)).toEqual([
      {
        type: 'bestmove',
        sessionId: 's1',
        searchId: 1,
        bestMove: { move: 'e2e4' },
        reason: 'stopped',
      },
      { type: 'bestmove', sessionId: 's1', searchId: 2, bestMove: null, reason: 'stopped' },
    ]);
    expect(backend.engine.goes).toHaveLength(1);
    sessions.handle({ type: 'stop', sessionId: 'nope' });
    expect(out.at(-1)).toMatchObject({
      type: 'error',
      code: 'session_not_found',
      sessionId: 'nope',
    });
  });

  describe('terminal-message guarantee', () => {
    it('engine crash mid-search → error engine_crashed with ids; lease and IP slot returned', async () => {
      const { sessions, backend, ledger, out } = setup();
      sessions.handle(analyze(1));
      await settle();
      expect(ledger.count('203.0.113.7')).toBe(1);
      backend.engine.crash();
      await settle();
      expect(terminals(out)).toEqual([
        {
          type: 'error',
          code: 'engine_crashed',
          message: 'engine process crashed',
          sessionId: 's1',
          searchId: 1,
        },
      ]);
      expect(backend.released).toHaveLength(1);
      expect(ledger.count('203.0.113.7')).toBe(0);
      // The session survives and leases a fresh engine for the next analyze.
      sessions.handle(analyze(2));
      await settle();
      expect(backend.engines).toHaveLength(2);
    });

    it('crash of an idle leased engine → session-level engine_crashed error', async () => {
      const { sessions, backend, out } = setup();
      sessions.handle(analyze(1));
      await settle();
      backend.engine.finish();
      await settle();
      backend.engine.crash();
      expect(out.at(-1)).toEqual({
        type: 'error',
        code: 'engine_crashed',
        message: 'engine process crashed',
        sessionId: 's1',
      });
    });

    it('setOptions failing → error engine_crashed "engine not responding", lease dropped', async () => {
      const backend = new FakeBackend();
      const { sessions, out } = setup({ backend });
      const origAcquire = backend.acquire.bind(backend);
      backend.acquire = async (id, o) => {
        const r = await origAcquire(id, o);
        if (r.ok) (r.lease.engine as FakeEngine).failSetOptions = true;
        return r;
      };
      sessions.handle(analyze(1));
      await settle();
      expect(terminals(out)).toEqual([
        expect.objectContaining({
          type: 'error',
          code: 'engine_crashed',
          message: 'engine not responding',
          searchId: 1,
        }),
      ]);
      expect(backend.released).toHaveLength(1);
    });

    it('an engine that ignores stop is dropped after stopTimeoutMs with engine_crashed', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { sessions, backend, out } = setup({ stopTimeoutMs: 500 });
      sessions.handle(analyze(1));
      await settle();
      backend.engine.ignoreStop = true;
      sessions.handle(analyze(2));
      await settle();
      expect(terminals(out)).toHaveLength(0);
      vi.advanceTimersByTime(500);
      await settle();
      expect(terminals(out)[0]).toMatchObject({
        type: 'error',
        code: 'engine_crashed',
        message: 'engine not responding',
        searchId: 1,
      });
      expect(backend.released).toHaveLength(1);
      // Search 2 runs on a fresh engine.
      expect(backend.engines).toHaveLength(2);
      expect(backend.engine.goes).toHaveLength(1);
    });

    it('the wall-clock cap stops a search with reason limit', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { sessions, backend, out } = setup();
      sessions.handle(analyze(1, { movetime: 100 }));
      await settle();
      vi.advanceTimersByTime(2_099);
      expect(backend.engine.stops).toBe(0);
      vi.advanceTimersByTime(1);
      await settle();
      expect(terminals(out)).toEqual([
        expect.objectContaining({ type: 'bestmove', searchId: 1, reason: 'limit' }),
      ]);
    });

    it('acquire failure → error with the backend code; IP slot returned', async () => {
      const { sessions, backend, ledger, out } = setup();
      backend.failWith = {
        ok: false,
        code: 'no_capacity',
        message: 'server session limit reached',
      };
      sessions.handle(analyze(1));
      await settle();
      expect(out).toEqual([
        {
          type: 'error',
          code: 'no_capacity',
          message: 'server session limit reached',
          sessionId: 's1',
          searchId: 1,
        },
      ]);
      expect(ledger.total).toBe(0);
    });

    it('a throwing deliver does not break the session chain', async () => {
      const backend = new FakeBackend();
      const got: AnalysisServerMessage[] = [];
      let fail = true;
      const sessions = new ClientSessions(
        (m) => {
          if (fail) {
            fail = false;
            throw new Error('socket gone');
          }
          got.push(m);
        },
        { ip: '1.2.3.4', id: 'c1' },
        {
          backend,
          ledger: new IpSessionLedger(5),
          limits: LIMITS,
          engines: ENGINES,
          logger: silent,
          sessionIdleMs: 60_000,
        },
      );
      sessions.handle(analyze(1));
      await settle();
      backend.engine.info(); // throws inside deliver
      backend.engine.finish();
      await settle();
      expect(got.map((m) => m.type)).toEqual(['bestmove']);
    });
  });

  describe('release and close', () => {
    it('release stops the search (bestmove stopped), returns the engine and frees the IP slot', async () => {
      const { sessions, backend, ledger, out } = setup();
      sessions.handle(analyze(1));
      await settle();
      sessions.handle({ type: 'release', sessionId: 's1' });
      expect(sessions.sessionCount).toBe(0);
      await settle();
      expect(terminals(out)).toEqual([
        expect.objectContaining({ type: 'bestmove', reason: 'stopped' }),
      ]);
      expect(backend.released).toHaveLength(1);
      expect(ledger.total).toBe(0);
      sessions.handle({ type: 'release', sessionId: 's1' }); // idempotent
      await settle();
      expect(backend.released).toHaveLength(1);
    });

    it('a re-created session waits for its retiring predecessor (order kept across release)', async () => {
      const { sessions, backend, out } = setup();
      sessions.handle(analyze(1));
      await settle();
      backend.engine.ignoreStop = true;
      sessions.handle({ type: 'release', sessionId: 's1' });
      sessions.handle(analyze(2));
      await settle();
      // Search 2 must not start while search 1 has not ended.
      expect(backend.engines).toHaveLength(1);
      backend.engines[0]!.finish();
      await settle();
      expect(out.map((m) => `${m.type}:${'searchId' in m ? m.searchId : '-'}`)).toEqual([
        'bestmove:1',
      ]);
      expect(backend.engines).toHaveLength(2);
      backend.engine.finish();
      await settle();
      expect(terminals(out).map((m) => m.searchId)).toEqual([1, 2]);
    });

    it('close stops every search, returns every lease and delivers nothing afterwards', async () => {
      const { sessions, backend, ledger, out } = setup();
      sessions.handle(analyze(1));
      sessions.handle(analyze(1, { sessionId: 's2' }));
      await settle();
      expect(backend.engines).toHaveLength(2);
      const before = out.length;
      let resolved = false;
      const closed = sessions.close().then(() => (resolved = true));
      expect(sessions.close()).toBe(sessions.close()); // idempotent
      await closed;
      expect(resolved).toBe(true);
      expect(backend.released).toHaveLength(2);
      expect(ledger.total).toBe(0);
      expect(out.length).toBe(before);
      sessions.handle(analyze(5));
      await settle();
      expect(backend.acquires).toHaveLength(2);
      expect(out.length).toBe(before);
    });

    it('close waits for an engine that ignores stop (until the stop timeout)', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { sessions, backend } = setup({ stopTimeoutMs: 300 });
      sessions.handle(analyze(1));
      await settle();
      backend.engine.ignoreStop = true;
      let resolved = false;
      void sessions.close().then(() => (resolved = true));
      await settle();
      expect(resolved).toBe(false);
      vi.advanceTimersByTime(300);
      await settle();
      expect(resolved).toBe(true);
      expect(backend.released).toHaveLength(1);
    });

    it('close during a pending acquire hands the late lease straight back', async () => {
      const { sessions, backend, ledger, out } = setup();
      backend.gate = deferred<void>();
      sessions.handle(analyze(1));
      await settle();
      const closed = sessions.close();
      backend.gate.resolve();
      await closed;
      await settle();
      expect(backend.released).toHaveLength(1);
      expect(ledger.total).toBe(0);
      expect(out).toEqual([]);
    });

    it('release during a pending acquire → bestmove stopped, lease handed back', async () => {
      const { sessions, backend, ledger, out } = setup();
      backend.gate = deferred<void>();
      sessions.handle(analyze(1));
      await settle();
      sessions.handle({ type: 'release', sessionId: 's1' });
      backend.gate.resolve();
      await settle();
      expect(out).toEqual([
        { type: 'bestmove', sessionId: 's1', searchId: 1, bestMove: null, reason: 'stopped' },
      ]);
      expect(backend.released).toHaveLength(1);
      expect(ledger.total).toBe(0);
    });

    it('releases an idle session lease after sessionIdleMs; activity re-arms the timer', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { sessions, backend, ledger } = setup({ sessionIdleMs: 1_000 });
      sessions.handle(analyze(1));
      await settle();
      backend.engine.finish();
      await settle();
      vi.advanceTimersByTime(900);
      sessions.handle(analyze(2));
      await settle();
      backend.engine.finish();
      await settle();
      vi.advanceTimersByTime(900);
      await settle();
      expect(backend.released).toHaveLength(0);
      expect(backend.acquires).toHaveLength(1);
      vi.advanceTimersByTime(100);
      await settle();
      expect(backend.released).toHaveLength(1);
      expect(ledger.total).toBe(0);
      // The session stays; the next analyze leases again.
      expect(sessions.sessionCount).toBe(1);
      sessions.handle(analyze(3));
      await settle();
      expect(backend.acquires).toHaveLength(2);
    });

    it('a running search is never released as idle', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { sessions, backend } = setup({ sessionIdleMs: 1_000 });
      sessions.handle(analyze(1));
      await settle();
      vi.advanceTimersByTime(5_000);
      await settle();
      expect(backend.released).toHaveLength(0);
      expect(backend.engine.searching).toBe(true);
    });

    it('switching engines returns the old lease and acquires the new engine', async () => {
      const { sessions, backend, ledger } = setup();
      sessions.handle(analyze(1));
      await settle();
      backend.engine.finish();
      await settle();
      sessions.handle(analyze(2, { engine: 'other' }));
      await settle();
      expect(backend.acquires.map((a) => a.engineId)).toEqual(['fake', 'other']);
      expect(backend.released.map((l) => l.engineId)).toEqual(['fake']);
      expect(backend.engine.options).toEqual([{ Threads: 2, Hash: 32, MultiPV: 1 }]);
      expect(ledger.total).toBe(1);
    });

    it('retireAll (game start) stops and releases every session', async () => {
      const { sessions, backend, ledger, out } = setup();
      sessions.handle(analyze(1));
      sessions.handle(analyze(1, { sessionId: 's2' }));
      await settle();
      sessions.retireAll();
      expect(sessions.sessionCount).toBe(0);
      await settle();
      expect(terminals(out)).toHaveLength(2);
      expect(terminals(out).every((m) => m.type === 'bestmove' && m.reason === 'stopped')).toBe(
        true,
      );
      expect(backend.released).toHaveLength(2);
      expect(ledger.total).toBe(0);
    });
  });

  describe('per-IP ledger', () => {
    it('clients from one address share the cap; slots come back on release and close', async () => {
      const ledger = new IpSessionLedger(2);
      const backend = new FakeBackend();
      const a = setup({ ledger, backend }, { ip: '198.51.100.1', id: 1 });
      const b = setup({ ledger, backend }, { ip: '198.51.100.1', id: 2 });
      const other = setup({ ledger, backend }, { ip: '198.51.100.2', id: 3 });
      a.sessions.handle(analyze(1));
      a.sessions.handle(analyze(1, { sessionId: 's2' }));
      await settle();
      b.sessions.handle(analyze(1));
      other.sessions.handle(analyze(1));
      await settle();
      expect(b.out).toEqual([
        {
          type: 'error',
          code: 'no_capacity',
          message: 'too many sessions from your address (at most 2)',
          sessionId: 's1',
          searchId: 1,
        },
      ]);
      expect(other.out.filter((m) => m.type === 'error')).toEqual([]);
      expect(ledger.count('198.51.100.1')).toBe(2);
      a.sessions.handle({ type: 'release', sessionId: 's2' });
      await settle();
      b.sessions.handle(analyze(2));
      await settle();
      expect(ledger.count('198.51.100.1')).toBe(2);
      await a.sessions.close();
      await b.sessions.close();
      expect(ledger.count('198.51.100.1')).toBe(0);
      expect(ledger.count('198.51.100.2')).toBe(1);
    });

    it('reserves synchronously: two clients racing for the last slot cannot both get it', async () => {
      const ledger = new IpSessionLedger(1);
      const backend = new FakeBackend();
      backend.gate = deferred<void>();
      const a = setup({ ledger, backend }, { ip: '10.0.0.1', id: 1 });
      const b = setup({ ledger, backend }, { ip: '10.0.0.1', id: 2 });
      a.sessions.handle(analyze(1));
      b.sessions.handle(analyze(1));
      await settle();
      backend.gate.resolve();
      await settle();
      expect(backend.acquires).toHaveLength(1);
      expect(b.out[0]).toMatchObject({ type: 'error', code: 'no_capacity' });
    });
  });

  describe('admission', () => {
    it('forbidden hook rejects before anything else and does not consume the analyze rate', async () => {
      let playing = true;
      const { sessions, backend, out } = setup({
        forbidden: () => (playing ? 'no analysis while you play in a room' : null),
        analyzeRateLimit: { max: 1, windowMs: 60_000 },
      });
      sessions.handle(analyze(1));
      sessions.handle(analyze(2));
      await settle();
      expect(out).toEqual([
        {
          type: 'error',
          code: 'forbidden',
          message: 'no analysis while you play in a room',
          sessionId: 's1',
          searchId: 1,
        },
        expect.objectContaining({ code: 'forbidden', searchId: 2 }),
      ]);
      expect(backend.acquires).toHaveLength(0);
      expect(sessions.sessionCount).toBe(0);
      playing = false;
      sessions.handle(analyze(3));
      sessions.handle(analyze(4));
      await settle();
      expect(backend.acquires).toHaveLength(1);
      expect(out.at(-1)).toMatchObject({ code: 'rate_limited', searchId: 4 });
    });

    it('rejects unknown/disabled engines, over-limit requests and too many sessions', async () => {
      const { sessions, backend, out } = setup();
      sessions.handle(analyze(1, { engine: 'nope' }));
      sessions.handle(analyze(2, { engine: 'off' }));
      sessions.handle(analyze(3, { depth: 31 }));
      for (const id of ['a', 'b', 'c', 'd']) sessions.handle(analyze(4, { sessionId: id }));
      await settle();
      const errors = out.filter((m) => m.type === 'error');
      expect(errors.map((m) => m.code)).toEqual([
        'unknown_engine',
        'unknown_engine',
        'limit_exceeded',
        'limit_exceeded',
      ]);
      expect(errors[3]).toMatchObject({
        sessionId: 'd',
        message: 'at most 3 sessions per connection',
      });
      expect(backend.acquires).toHaveLength(3);
    });

    it('caps a node-limited engine (maxNodes) and sends its cap to the engine', async () => {
      const engines: EngineDescriptor[] = [
        {
          id: 'maia',
          name: 'Maia',
          enabled: true,
          defaults: { threads: 1, hash: 16 },
          maxNodes: 1,
        },
      ];
      const { sessions, backend, out } = setup({ engines });
      sessions.handle(analyze(1, { engine: 'maia', nodes: 5 }));
      await settle();
      expect(out[0]).toMatchObject({ type: 'error', code: 'limit_exceeded', searchId: 1 });
      sessions.handle(analyze(2, { engine: 'maia' }));
      await settle();
      expect(backend.engine.goes).toEqual([{ nodes: 1 }]);
    });
  });
});
