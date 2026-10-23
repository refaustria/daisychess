import type { AnalyzeOptions, BestMove, EngineInfo } from '@chesslab/engine-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnalysisController,
  type AnalysisCallbacks,
  type AnalysisEngine,
  type AnalysisSettings,
  type AnalysisStatus,
  type TerminalKind,
} from './AnalysisController';

const FEN_A = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const FEN_B = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const MATED = 'mated-fen';

const info = (depth: number, cp = 20, multipv = 1): EngineInfo => ({
  depth,
  multipv,
  score: { cp },
  pv: ['e2e4'],
});

/** Controllable analysis stream, mimicking UciSession's single-consumer handle. */
class FakeStream implements AsyncIterable<EngineInfo> {
  private buffer: EngineInfo[] = [];
  private waiter: ((r: IteratorResult<EngineInfo>) => void) | null = null;
  private failWaiter: ((e: Error) => void) | null = null;
  ended = false;
  returned = false;
  private error: Error | null = null;
  private resolveBest!: (b: BestMove | null) => void;
  readonly bestMove = new Promise<BestMove | null>((r) => (this.resolveBest = r));

  constructor(
    readonly fen: string,
    readonly opts: AnalyzeOptions,
  ) {}

  push(i: EngineInfo): void {
    if (this.ended) return;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = this.failWaiter = null;
      w({ value: i, done: false });
    } else this.buffer.push(i);
  }

  end(best: BestMove | null = null): void {
    if (this.ended) return;
    this.ended = true;
    this.resolveBest(best);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = this.failWaiter = null;
      w({ value: undefined, done: true });
    }
  }

  fail(err: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.resolveBest(null);
    if (this.failWaiter) {
      const f = this.failWaiter;
      this.waiter = this.failWaiter = null;
      f(err);
    } else this.error = err;
  }

  [Symbol.asyncIterator](): AsyncIterator<EngineInfo> {
    return {
      next: () => {
        const v = this.buffer.shift();
        if (v) return Promise.resolve({ value: v, done: false });
        if (this.error) {
          const e = this.error;
          this.error = null;
          return Promise.reject(e);
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res, rej) => {
          this.waiter = res;
          this.failWaiter = rej;
        });
      },
      return: () => {
        this.returned = true;
        this.end(null);
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

class FakeEngine implements AnalysisEngine {
  engineName = 'Stockfish 19 Fake';
  loadCalls = 0;
  stopCalls = 0;
  disposed = false;
  loadError: Error | null = null;
  readonly optionCalls: Record<string, string | number | boolean>[] = [];
  readonly streams: FakeStream[] = [];
  /** Highest number of searches that were running at the same time. */
  maxConcurrent = 0;

  capabilities() {
    return { threads: true, build: 'fake', threadCount: 4 };
  }
  async load(): Promise<void> {
    this.loadCalls++;
    if (this.loadError) throw this.loadError;
  }
  async setOptions(o: Record<string, string | number | boolean>): Promise<void> {
    this.optionCalls.push(o);
    // Like UciSession: options cannot change during a search.
    this.current()?.end(null);
  }
  analyze(fen: string, opts: AnalyzeOptions): FakeStream {
    // Like UciSession: a new search stops the previous one.
    this.current()?.end(null);
    const s = new FakeStream(fen, opts);
    this.streams.push(s);
    this.maxConcurrent = Math.max(this.maxConcurrent, this.streams.filter((x) => !x.ended).length);
    return s;
  }
  async stop(): Promise<void> {
    this.stopCalls++;
    this.current()?.end(null);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.current()?.end(null);
  }
  current(): FakeStream | undefined {
    const s = this.streams.at(-1);
    return s && !s.ended ? s : undefined;
  }
  last(): FakeStream {
    const s = this.streams.at(-1);
    if (!s) throw new Error('no search started');
    return s;
  }
}

interface Recorder extends AnalysisCallbacks {
  statuses: AnalysisStatus[];
  errors: (string | undefined)[];
  resets: { fen: string; terminal: TerminalKind | null }[];
  infos: { fen: string; info: EngineInfo }[];
  best: { fen: string; move: string | null }[];
  engines: unknown[];
}

function recorder(): Recorder {
  const r: Recorder = {
    statuses: [],
    errors: [],
    resets: [],
    infos: [],
    best: [],
    engines: [],
    onStatus: (s, e) => {
      r.statuses.push(s);
      r.errors.push(e);
    },
    onEngine: (i) => r.engines.push(i),
    onReset: (fen, terminal) => r.resets.push({ fen, terminal }),
    onInfo: (fen, i) => r.infos.push({ fen, info: i }),
    onBestMove: (fen, move) => r.best.push({ fen, move }),
  };
  return r;
}

const DEFAULTS: AnalysisSettings = { depth: 22, multipv: 1 };

function setup(settings: AnalysisSettings = DEFAULTS) {
  const engines: FakeEngine[] = [];
  let nextLoadError: Error | null = null;
  const cb = recorder();
  const factory = vi.fn(() => {
    const e = new FakeEngine();
    e.loadError = nextLoadError;
    nextLoadError = null;
    engines.push(e);
    return e;
  });
  const c = new AnalysisController({
    createEngine: factory,
    callbacks: cb,
    settings,
    classify: (fen): TerminalKind | null => (fen === MATED ? 'checkmate' : null),
    debounceMs: 80,
  });
  return {
    c,
    cb,
    factory,
    engines,
    engine: () => engines.at(-1)!,
    failNextLoad: (e: Error) => (nextLoadError = e),
  };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AnalysisController', () => {
  it('loads the engine lazily on first enable and analyses the current position', async () => {
    const { c, cb, factory, engine } = setup();
    c.setPosition(FEN_A);
    await settle();
    expect(factory).not.toHaveBeenCalled();
    expect(cb.resets).toEqual([{ fen: FEN_A, terminal: null }]);

    c.setEnabled(true);
    expect(cb.statuses.at(-1)).toBe('loading');
    await settle();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(engine().loadCalls).toBe(1);
    expect(cb.engines).toEqual([
      {
        engineName: 'Stockfish 19 Fake',
        capabilities: { threads: true, build: 'fake', threadCount: 4 },
      },
    ]);
    expect(cb.statuses.at(-1)).toBe('analysing');
    expect(engine().last().fen).toBe(FEN_A);
    expect(engine().last().opts).toEqual({ depth: 22, multipv: 1 });
    // MultiPV 1 is the engine default: no setOptions needed.
    expect(engine().optionCalls).toEqual([]);

    engine().last().push(info(1));
    engine().last().push(info(2));
    await settle();
    expect(cb.infos.map((i) => i.info.depth)).toEqual([1, 2]);
  });

  it('reports bestmove and goes ready when the depth limit is reached; depth 0 = infinite', async () => {
    const { c, cb, engine } = setup({ depth: 0, multipv: 1 });
    c.setPosition(FEN_A);
    c.setEnabled(true);
    await settle();
    expect(engine().last().opts).toEqual({ multipv: 1 });
    engine().last().push(info(30));
    engine().last().end({ move: 'e2e4' });
    await settle();
    expect(cb.best).toEqual([{ fen: FEN_A, move: 'e2e4' }]);
    expect(cb.statuses.at(-1)).toBe('ready');
  });

  it('drops infos of the previous FEN after a position change and restarts after the debounce', async () => {
    const { c, cb, engine } = setup();
    c.setPosition(FEN_A);
    c.setEnabled(true);
    await settle();
    const first = engine().last();
    first.push(info(5, 30));
    await settle();
    expect(cb.infos).toHaveLength(1);

    c.setPosition(FEN_B);
    expect(cb.resets.at(-1)).toEqual({ fen: FEN_B, terminal: null });
    first.push(info(6, 35)); // late info for FEN_A
    await settle();
    expect(cb.infos).toHaveLength(1);
    // The stale search is abandoned early (iterator return -> engine stop).
    expect(first.ended).toBe(true);
    expect(engine().streams).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(80);
    expect(engine().streams).toHaveLength(2);
    expect(engine().last().fen).toBe(FEN_B);
    engine().last().push(info(1, -10));
    await settle();
    expect(cb.infos.at(-1)).toEqual({ fen: FEN_B, info: info(1, -10) });
    expect(cb.infos.filter((i) => i.fen === FEN_A).map((i) => i.info.depth)).toEqual([5]);
  });

  it('debounces rapid navigation: 20 plies in quick succession start a single new search', async () => {
    const { c, engine } = setup();
    c.setPosition('fen-0');
    c.setEnabled(true);
    await settle();
    expect(engine().streams).toHaveLength(1);
    for (let i = 1; i <= 20; i++) {
      c.setPosition(`fen-${i}`);
      await vi.advanceTimersByTimeAsync(30);
    }
    expect(engine().streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(80);
    expect(engine().streams).toHaveLength(2);
    expect(engine().last().fen).toBe('fen-20');
    expect(engine().maxConcurrent).toBeLessThanOrEqual(2);
    expect(engine().streams.filter((s) => !s.ended)).toHaveLength(1);
  });

  it('applies MultiPV via setOptions when settings change and restarts the search', async () => {
    const { c, cb, engine } = setup();
    c.setPosition(FEN_A);
    c.setEnabled(true);
    await settle();
    const first = engine().last();
    first.push(info(8));
    await settle();
    const resetsBefore = cb.resets.length;

    c.setSettings({ depth: 22, multipv: 3 });
    expect(cb.resets.length).toBe(resetsBefore + 1);
    first.push(info(9)); // stale: belongs to the MultiPV 1 search
    await settle();
    expect(engine().optionCalls).toEqual([{ MultiPV: 3 }]);
    expect(engine().streams).toHaveLength(2);
    expect(engine().last().opts).toEqual({ depth: 22, multipv: 3 });
    expect(cb.infos.map((i) => i.info.depth)).toEqual([8]);

    // Unchanged settings do nothing; a depth-only change restarts without setOptions.
    c.setSettings({ depth: 22, multipv: 3 });
    await settle();
    expect(engine().streams).toHaveLength(2);
    c.setSettings({ depth: 10, multipv: 3 });
    await settle();
    expect(engine().optionCalls).toHaveLength(1);
    expect(engine().last().opts).toEqual({ depth: 10, multipv: 3 });
  });

  it('applies non-default MultiPV and Threads right after loading', async () => {
    const { c, engine } = setup({ depth: 22, multipv: 2, threads: 2 });
    c.setPosition(FEN_A);
    c.setEnabled(true);
    await settle();
    expect(engine().optionCalls).toEqual([{ MultiPV: 2, Threads: 2 }]);
    expect(engine().last().opts).toEqual({ depth: 22, multipv: 2 });
  });

  it('settings changed while disabled are applied on the next search', async () => {
    const { c, engine } = setup();
    c.setPosition(FEN_A);
    c.setEnabled(true);
    await settle();
    c.setEnabled(false);
    c.setSettings({ depth: 22, multipv: 4 });
    await settle();
    expect(engine().streams).toHaveLength(1);
    c.setEnabled(true);
    await settle();
    expect(engine().optionCalls).toEqual([{ MultiPV: 4 }]);
    expect(engine().last().opts.multipv).toBe(4);
  });

  it('disabling stops (does not dispose) the engine; re-enabling reuses it', async () => {
    const { c, cb, factory, engine } = setup();
    c.setPosition(FEN_A);
    c.setEnabled(true);
    await settle();
    const s = engine().last();
    c.setEnabled(false);
    await settle();
    expect(engine().stopCalls).toBe(1);
    expect(engine().disposed).toBe(false);
    expect(s.ended).toBe(true);
    expect(cb.statuses.at(-1)).toBe('idle');
    expect(cb.resets.at(-1)).toEqual({ fen: FEN_A, terminal: null });

    // Navigation while disabled only updates the position.
    c.setPosition(FEN_B);
    await vi.advanceTimersByTimeAsync(200);
    expect(engine().streams).toHaveLength(1);

    c.setEnabled(true);
    await settle();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(engine().last().fen).toBe(FEN_B);
    expect(cb.statuses.at(-1)).toBe('analysing');
  });

  it('a search error sets status error, disposes the engine and retry() starts a fresh one', async () => {
    const { c, cb, factory, engines } = setup();
    c.setPosition(FEN_A);
    c.setEnabled(true);
    await settle();
    engines[0]!.last().fail(new Error('Stockfish aborted'));
    await settle();
    expect(cb.statuses.at(-1)).toBe('error');
    expect(cb.errors.at(-1)).toBe('Stockfish aborted');
    expect(engines[0]!.disposed).toBe(true);

    // No automatic restart on navigation while in error.
    c.setPosition(FEN_B);
    await vi.advanceTimersByTimeAsync(200);
    expect(factory).toHaveBeenCalledTimes(1);

    c.retry();
    expect(cb.statuses.at(-1)).toBe('loading');
    await settle();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(engines[1]!.last().fen).toBe(FEN_B);
    expect(cb.statuses.at(-1)).toBe('analysing');
  });

  it('a load failure sets status error; retry loads again', async () => {
    const { c, cb, factory, engines, failNextLoad } = setup();
    failNextLoad(new Error('failed to load stockfish.js'));
    c.setPosition(FEN_A);
    c.setEnabled(true);
    await settle();
    expect(cb.statuses).toEqual(['loading', 'error']);
    expect(cb.errors.at(-1)).toBe('failed to load stockfish.js');
    expect(engines[0]!.streams).toHaveLength(0);

    c.retry();
    await settle();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(engines[1]!.last().fen).toBe(FEN_A);
    expect(cb.statuses.at(-1)).toBe('analysing');
  });

  it('does not analyse terminal positions', async () => {
    const { c, cb, engine } = setup();
    c.setPosition(MATED);
    c.setEnabled(true);
    await settle();
    expect(cb.resets.at(-1)).toEqual({ fen: MATED, terminal: 'checkmate' });
    expect(engine().streams).toHaveLength(0);
    expect(cb.statuses.at(-1)).toBe('ready');

    c.setPosition(FEN_A);
    await vi.advanceTimersByTimeAsync(80);
    expect(engine().streams).toHaveLength(1);
    c.setPosition(MATED);
    await vi.advanceTimersByTimeAsync(80);
    expect(engine().streams).toHaveLength(1);
    expect(engine().last().ended).toBe(true);
    expect(cb.statuses.at(-1)).toBe('ready');
  });

  it('release() disposes the engine (pagehide) and resume() reloads it', async () => {
    const { c, factory, engines } = setup();
    c.setPosition(FEN_A);
    c.setEnabled(true);
    await settle();
    c.release();
    expect(engines[0]!.disposed).toBe(true);
    c.resume();
    await settle();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(engines[1]!.last().fen).toBe(FEN_A);
  });

  it('disabling during load leaves the engine idle and starts nothing', async () => {
    const { c, cb, engine } = setup();
    c.setPosition(FEN_A);
    c.setEnabled(true);
    c.setEnabled(false);
    await settle();
    expect(engine().loadCalls).toBe(1);
    expect(engine().streams).toHaveLength(0);
    expect(cb.statuses.at(-1)).toBe('idle');
    c.setEnabled(true);
    await settle();
    expect(engine().last().fen).toBe(FEN_A);
  });
});
