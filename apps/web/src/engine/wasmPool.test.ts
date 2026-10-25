import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeReviewEngine } from '../review/fakeEngine';
import { EnginePool, isEngineFailure, POOL_IDLE_MS, PooledEngine } from './wasmPool';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

class OptionsEngine extends FakeReviewEngine {
  readonly optionCalls: Record<string, unknown>[] = [];
  loadError: Error | null = null;
  override async setOptions(o?: Record<string, unknown>): Promise<void> {
    if (o) this.optionCalls.push(o);
  }
  override async load(): Promise<void> {
    await super.load();
    if (this.loadError) throw this.loadError;
  }
}

let engines: OptionsEngine[];
let pool: EnginePool;
let nextLoadError: Error | null;

beforeEach(() => {
  engines = [];
  nextLoadError = null;
  pool = new EnginePool({
    create: () => {
      const e = new OptionsEngine();
      e.loadError = nextLoadError;
      nextLoadError = null;
      engines.push(e);
      return e;
    },
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await pool.dispose();
});

async function drain(handle: AsyncIterable<unknown>): Promise<number> {
  let n = 0;
  const it = handle[Symbol.asyncIterator]();
  while (!(await it.next()).done) n++;
  return n;
}

describe('EnginePool', () => {
  it('shares one loaded engine between purposes (one instance)', async () => {
    const a = await pool.acquire('review');
    expect(engines).toHaveLength(1);
    expect(engines[0]!.loadCalls).toBe(1);
    a.release();
    const b = await pool.acquire('drill');
    expect(b.engine).toBe(a.engine);
    expect(engines).toHaveLength(1);
    expect(pool.stats).toMatchObject({ created: 1, alive: true, holder: 'drill' });
    b.release();
    b.release(); // idempotent
    expect(pool.stats.holder).toBeNull();
  });

  it('a second request waits for the holder (FIFO) and is told who holds it', async () => {
    const review = await pool.acquire('review');
    const waits: string[] = [];
    let got: string[] = [];
    const drill = pool.acquire('drill', { onWait: (h) => waits.push(h) }).then((l) => {
      got.push('drill');
      return l;
    });
    const play = pool.acquire('play').then((l) => {
      got.push('play');
      return l;
    });
    await Promise.resolve();
    expect(waits).toEqual(['review']);
    expect(pool.stats.waiting).toBe(2);
    expect(got).toEqual([]);
    review.release();
    const d = await drill;
    expect(got).toEqual(['drill']);
    d.release();
    (await play).release();
    expect(got).toEqual(['drill', 'play']);
    expect(engines).toHaveLength(1);
    got = [];
  });

  it('an aborted wait leaves the queue', async () => {
    const review = await pool.acquire('review');
    const ac = new AbortController();
    const p = pool.acquire('drill', { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(pool.stats.waiting).toBe(0);
    review.release();
    await expect(pool.acquire('drill', { signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('disposes the engine after the idle time without a lease; a new lease cancels that', async () => {
    vi.useFakeTimers();
    const a = await pool.acquire('review');
    a.release();
    await vi.advanceTimersByTimeAsync(POOL_IDLE_MS - 1);
    const b = await pool.acquire('drill');
    await vi.advanceTimersByTimeAsync(POOL_IDLE_MS * 2);
    expect(engines[0]!.disposed).toBe(false); // leased: never idle-disposed
    b.release();
    await vi.advanceTimersByTimeAsync(POOL_IDLE_MS - 1);
    expect(engines[0]!.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(engines[0]!.disposed).toBe(true);
    expect(pool.stats.alive).toBe(false);
    const c = await pool.acquire('review');
    expect(engines).toHaveLength(2);
    expect(c.engine).toBe(engines[1]);
    c.release();
  });

  it('broken release disposes the engine; the next acquire creates a fresh one', async () => {
    const a = await pool.acquire('review');
    a.release({ broken: true });
    expect(engines[0]!.disposed).toBe(true);
    const b = await pool.acquire('drill');
    expect(b.engine).toBe(engines[1]);
    b.release();
  });

  it('a load failure rejects that request only; the waiter behind it gets a fresh engine', async () => {
    const holder = await pool.acquire('play');
    holder.release({ broken: true });
    nextLoadError = new Error('Stockfish worker error: RangeError: Out of memory');
    const first = pool.acquire('review');
    const second = pool.acquire('drill');
    await expect(first).rejects.toThrow(/Out of memory/);
    const l = await second;
    expect(l.engine).toBe(engines[2]);
    expect(engines[1]!.disposed).toBe(true);
    l.release();
  });

  it('restore options are applied (after a stop) before the next holder gets the engine', async () => {
    const a = await pool.acquire('play');
    a.release({ restore: { UCI_LimitStrength: false } });
    const b = await pool.acquire('review');
    const e = engines[0]!;
    expect(e.stopCalls).toBeGreaterThanOrEqual(1);
    expect(e.optionCalls).toEqual([{ UCI_LimitStrength: false }]);
    b.release();
  });

  it('trim disposes an idle engine at once but never a leased one', async () => {
    const a = await pool.acquire('review');
    await pool.trim();
    expect(engines[0]!.disposed).toBe(false);
    a.release();
    await pool.trim();
    expect(engines[0]!.disposed).toBe(true);
  });

  it('dispose rejects waiters and turns the current lease stale', async () => {
    const a = await pool.acquire('review');
    const w = pool.acquire('drill');
    await pool.dispose();
    await expect(w).rejects.toThrow(/disposed/);
    expect(engines[0]!.disposed).toBe(true);
    a.release(); // stale: no effect
    const b = await pool.acquire('drill');
    expect(b.engine).toBe(engines[1]);
    b.release();
  });

  it('setFactory switches the engine type', async () => {
    const other = new OptionsEngine();
    pool.setFactory(() => other);
    const l = await pool.acquire('review');
    expect(l.engine).toBe(other);
    l.release();
  });

  it('isEngineFailure: everything except a cancellation', () => {
    expect(isEngineFailure(new Error('x'))).toBe(true);
    expect(isEngineFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('PooledEngine', () => {
  it('leases per search, applies its options each time and restores them afterwards', async () => {
    const play = new PooledEngine(pool, { purpose: 'play', restore: { UCI_LimitStrength: false } });
    await play.load(); // warm-up: the engine is loaded, the lease given back
    expect(engines).toHaveLength(1);
    expect(pool.stats.holder).toBeNull();
    await play.setOptions({ UCI_LimitStrength: true, UCI_Elo: 1500 });
    const h = play.analyze(START, { movetime: 10 });
    expect(await drain(h)).toBeGreaterThan(0);
    expect(await h.bestMove).toMatchObject({ move: 'e2e4' });
    expect(pool.stats.holder).toBeNull();
    // A review in between gets the engine with the strength limit switched off again.
    const review = await pool.acquire('review');
    expect(engines[0]!.optionCalls).toEqual([
      { UCI_LimitStrength: false },
      { UCI_LimitStrength: true, UCI_Elo: 1500 },
      { UCI_LimitStrength: false },
    ]);
    review.release();
    await drain(play.analyze(START, { movetime: 10 }));
    expect(engines[0]!.optionCalls.at(-2)).toEqual({ UCI_LimitStrength: true, UCI_Elo: 1500 });
    expect(engines).toHaveLength(1);
  });

  it('waits while another purpose holds the engine and reports it', async () => {
    const waits: [boolean, string | undefined][] = [];
    const drill = new PooledEngine(pool, {
      purpose: 'drill',
      onWait: (w, h) => waits.push([w, h]),
    });
    const review = await pool.acquire('review');
    const done = drain(drill.analyze(START, {}));
    await Promise.resolve();
    expect(waits).toEqual([[true, 'review']]);
    expect(engines[0]!.analysed).toEqual([]);
    review.release();
    await done;
    expect(waits).toEqual([
      [true, 'review'],
      [false, undefined],
    ]);
    expect(engines[0]!.analysed).toEqual([START]);
  });

  it('a failing search breaks the pooled engine (not reused)', async () => {
    const drill = new PooledEngine(pool, { purpose: 'drill' });
    await drill.load();
    engines[0]!.fail.set(START, new Error('Stockfish worker error: RangeError: Out of memory'));
    await expect(drain(drill.analyze(START, {}))).rejects.toThrow(/Out of memory/);
    expect(engines[0]!.disposed).toBe(true);
    await drain(drill.analyze(START, {}));
    expect(engines).toHaveLength(2);
  });

  it('dispose gives up a pending wait and the lease, never the pooled engine', async () => {
    const drill = new PooledEngine(pool, { purpose: 'drill' });
    const review = await pool.acquire('review');
    const it = drill.analyze(START, {})[Symbol.asyncIterator]();
    const next = it.next();
    await drill.dispose();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
    review.release();
    expect(engines[0]!.disposed).toBe(false);
    expect(pool.stats.waiting).toBe(0);
    await expect(drill.load()).rejects.toThrow(/disposed/);
  });
});
