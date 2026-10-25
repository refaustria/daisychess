import { Chess } from 'chess.js';
import { describe, expect, it, vi } from 'vitest';
import { BatchAnalyzer, EngineStallError, type BatchGame } from './BatchAnalyzer';
import { FakeReviewEngine } from './fakeEngine';

function gameFrom(sans: string[], startFen?: string): BatchGame {
  const c = new Chess(startFen);
  const start = c.fen();
  const moves = sans.map((san) => {
    const m = c.move(san);
    return { uci: `${m.from}${m.to}${m.promotion ?? ''}`, san: m.san, fenAfter: m.after };
  });
  return { startFen: start, moves };
}

const SCHOLAR = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'];
const fens = (g: BatchGame): string[] => [g.startFen, ...g.moves.map((m) => m.fenAfter)];

function scholarEngine(): { engine: FakeReviewEngine; game: BatchGame; p: string[] } {
  const game = gameFrom(SCHOLAR);
  const p = fens(game);
  const engine = new FakeReviewEngine();
  // White POV evals with the engine's best moves.
  engine.scripts.set(p[0]!, { score: { cp: 30 }, pv: ['e2e4', 'e7e5'] });
  engine.scripts.set(p[1]!, { score: { cp: 30 }, pv: ['e7e5'] });
  engine.scripts.set(p[2]!, { score: { cp: 30 }, pv: ['g1f3'] });
  engine.scripts.set(p[3]!, { score: { cp: 20 }, pv: ['b8c6'] });
  engine.scripts.set(p[4]!, { score: { cp: 20 }, pv: ['d1h5'] });
  engine.scripts.set(p[5]!, { score: { cp: -10 }, pv: ['g7g6'] });
  engine.scripts.set(p[6]!, { score: { mate: 1 }, pv: ['h5f7'], bestMove: null });
  return { engine, game, p };
}

describe('BatchAnalyzer', () => {
  it('analyses every non-terminal position sequentially and reviews the game', async () => {
    const { engine, game, p } = scholarEngine();
    const progress: Array<[number, number]> = [];
    const onDone = vi.fn();
    const a = new BatchAnalyzer({ engine, options: {}, concurrency: 1 });
    const summary = await a.run(game, { onProgress: (d, t) => progress.push([d, t]), onDone })
      .promise;

    expect(engine.analysed).toEqual(p.slice(0, 7)); // final (checkmate) position not searched
    expect(engine.calls[0]).toEqual({ depth: 18, multipv: 1 });
    expect(engine.maxActive).toBe(1);
    expect(progress).toEqual([1, 2, 3, 4, 5, 6, 7, 8].map((d) => [d, 8]));
    expect(onDone).toHaveBeenCalledWith(summary);

    expect(summary.moves).toHaveLength(7);
    const m = summary.moves;
    expect(m[0]!.evalBefore).toEqual({ cp: 30 }); // last info, not the first (cp 12345)
    expect(m[0]!.bestMove).toBe('e2e4');
    expect(m[0]!.classification).toBe('best');
    expect(m[5]!.san).toBe('Nf6');
    expect(m[5]!.evalAfter).toEqual({ mate: 1 });
    expect(m[5]!.classification).toBe('blunder');
    // bestMove null → falls back to pv[0]; checkmate → {mate: 0} → mover won.
    expect(m[6]!.bestMove).toBe('h5f7');
    expect(m[6]!.evalAfter).toEqual({ mate: 0 });
    expect(m[6]!.winProbAfter).toBe(100);
    expect(m[6]!.classification).toBe('best');
    expect(a.cache.size).toBe(8);
  });

  it('stores the PV (at most 8 plies) per position in the cache and the run results', async () => {
    const { engine, game, p } = scholarEngine();
    const long = ['g7g6', 'h5f3', 'g8f6', 'g1e2', 'f8g7', 'e1g1', 'e8g8', 'd2d3', 'd7d6', 'b1c3'];
    engine.scripts.set(p[5]!, { score: { cp: -10 }, pv: long });
    const a = new BatchAnalyzer({ engine });
    const run = a.run(game);
    await run.promise;
    expect(a.cache.get(p[0]!)?.pv).toEqual(['e2e4', 'e7e5']);
    expect(a.cache.get(p[5]!)?.pv).toEqual(long.slice(0, 8));
    expect(a.cache.get(p[5]!)?.bestMove).toBe('g7g6');
    // Terminal positions are not searched and have no line.
    expect(a.cache.get(p[7]!)?.pv).toBeUndefined();
    expect(run.results).toHaveLength(8);
    expect(run.results[5]!.pv).toEqual(long.slice(0, 8));
  });

  it('reports a partial summary with progress', async () => {
    const { engine, game } = scholarEngine();
    const partials: number[] = [];
    await new BatchAnalyzer({ engine }).run(game, {
      onProgress: (_d, _t, partial) => partials.push(partial?.moves.length ?? -1),
    }).promise;
    expect(partials).toEqual([-1, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('evaluates stalemate as 0 without searching it', async () => {
    const game = gameFrom(['Qf7'], '7k/4Q3/6K1/8/8/8/8/8 w - - 0 1');
    const engine = new FakeReviewEngine();
    engine.scripts.set(game.startFen, { score: { mate: 2 }, pv: ['g6h6'] });
    const s = await new BatchAnalyzer({ engine }).run(game).promise;
    expect(engine.analysed).toEqual([game.startFen]);
    expect(s.moves[0]!.evalAfter).toEqual({ cp: 0 });
    expect(s.moves[0]!.classification).toBe('blunder');
  });

  it('counts legal moves (forced moves) from the position before the move', async () => {
    // Rg1 covers g7/g8: Kh7 is the only legal move.
    const game = gameFrom(['Kh7'], '7k/8/8/8/8/8/8/6RK b - - 0 1');
    const engine = new FakeReviewEngine();
    const s = await new BatchAnalyzer({ engine }).run(game).promise;
    expect(s.moves[0]!.classification).toBe('forced');
  });

  it('uses movetime when given', async () => {
    const { engine, game } = scholarEngine();
    await new BatchAnalyzer({ engine, options: { movetime: 300, depth: 12 } }).run(game).promise;
    expect(
      engine.calls.every((c) => c.movetime === 300 && c.depth === undefined && c.multipv === 1),
    ).toBe(true);
  });

  it('converts side-to-move scores with pov "stm"', async () => {
    const game = gameFrom(['e4']);
    const [p0, p1] = fens(game);
    const engine = new FakeReviewEngine();
    engine.scripts.set(p0!, { score: { cp: 40 }, pv: ['e2e4'] });
    engine.scripts.set(p1!, { score: { cp: -35 }, pv: ['e7e5'] }); // Black to move: -35 for Black
    const stm = await new BatchAnalyzer({ engine, options: { pov: 'stm' } }).run(game).promise;
    expect(stm.moves[0]!.evalBefore).toEqual({ cp: 40 });
    expect(stm.moves[0]!.evalAfter).toEqual({ cp: 35 });
    const white = await new BatchAnalyzer({ engine, options: { pov: 'white' } }).run(game).promise;
    expect(white.moves[0]!.evalAfter).toEqual({ cp: -35 });
  });

  it('cancel stops the engine, rejects with AbortError, keeps the cache; a rerun resumes', async () => {
    const { engine, game, p } = scholarEngine();
    engine.hang.add(p[2]!);
    const a = new BatchAnalyzer({ engine });
    const onError = vi.fn();
    const ref: { run?: ReturnType<BatchAnalyzer['run']> } = {};
    const run = a.run(game, {
      onProgress: (done) => {
        if (done === 2) setTimeout(() => ref.run!.cancel(), 5);
      },
      onError,
    });
    ref.run = run;
    await expect(run.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
    expect(engine.stopCalls).toBe(1);
    expect(engine.active).toBe(0); // engine idle before the promise settled
    expect([...a.cache.keys()]).toEqual([p[0], p[1]]); // the aborted (partial) search is not cached
    run.cancel(); // idempotent
    expect(engine.stopCalls).toBe(1);

    engine.hang.clear();
    engine.analysed.length = 0;
    const rerun = new BatchAnalyzer({ engine, cache: a.cache });
    const s = await rerun.run(game).promise;
    expect(engine.analysed).toEqual(p.slice(2, 7));
    expect(s.moves).toHaveLength(7);
    expect(engine.maxActive).toBe(1);
  });

  it('cancel before the first search starts rejects without searching', async () => {
    const { engine, game } = scholarEngine();
    const run = new BatchAnalyzer({ engine }).run(game);
    run.cancel();
    await expect(run.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.analysed.length).toBeLessThanOrEqual(1);
    expect(engine.active).toBe(0);
  });

  it('rejects on engine errors and reports them', async () => {
    const { engine, game, p } = scholarEngine();
    engine.fail.set(p[3]!, new Error('worker crashed'));
    const onError = vi.fn();
    const a = new BatchAnalyzer({ engine });
    await expect(a.run(game, { onError }).promise).rejects.toThrow('worker crashed');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'worker crashed' }));
    expect(a.cache.size).toBe(3);
  });

  it('rejects when the engine yields no evaluation', async () => {
    const engine = new FakeReviewEngine();
    engine.analyze = () => ({
      bestMove: Promise.resolve(null),
      [Symbol.asyncIterator]: async function* () {
        /* nothing */
      },
    });
    await expect(new BatchAnalyzer({ engine }).run(gameFrom(['e4'])).promise).rejects.toThrow(
      /no evaluation/,
    );
  });

  it('rejects illegal moves and invalid options', async () => {
    const engine = new FakeReviewEngine();
    const g = gameFrom(['e4']);
    g.moves[0]!.uci = 'e2e5';
    await expect(new BatchAnalyzer({ engine }).run(g).promise).rejects.toThrow(/Illegal move e2e5/);
    expect(() => new BatchAnalyzer({ engine, options: { depth: 0 } })).toThrow(/depth/);
    // @ts-expect-error only concurrency 1 is supported
    expect(() => new BatchAnalyzer({ engine, concurrency: 2 })).toThrow(/concurrency/);
  });
});

describe('BatchAnalyzer: stall watchdog (stallMs)', () => {
  it('a search without output fails with EngineStallError and stops the engine', async () => {
    const { engine, game, p } = scholarEngine();
    // Hangs until stop(); the watchdog's stop() then ends it — but the run must fail anyway.
    engine.hang.add(p[2]!);
    const a = new BatchAnalyzer({ engine, options: { movetime: 10 }, stallMs: 25 });
    const err = await a.run(game).promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngineStallError);
    expect((err as Error).message).toBe('the engine stopped responding (no output for 25 ms)');
    expect(engine.stopCalls).toBeGreaterThan(0);
    expect(a.cache.has(p[1]!)).toBe(true);
    expect(a.cache.has(p[2]!)).toBe(false);
  });

  it('a best move that never arrives also trips the watchdog', async () => {
    const { engine, game } = scholarEngine();
    const analyze = engine.analyze.bind(engine);
    engine.analyze = (fen, opts) => {
      const h = analyze(fen, opts);
      return {
        [Symbol.asyncIterator]: () => h[Symbol.asyncIterator](),
        bestMove: new Promise(() => undefined),
      };
    };
    const a = new BatchAnalyzer({ engine, options: { movetime: 10 }, stallMs: 20 });
    await expect(a.run(game).promise).rejects.toBeInstanceOf(EngineStallError);
  });

  it('slow but steady output and stallMs 0 never trip it', async () => {
    const { engine, game } = scholarEngine();
    engine.delayMs = 15;
    const a = new BatchAnalyzer({ engine, options: { movetime: 10 }, stallMs: 200 });
    expect((await a.run(game).promise).moves).toHaveLength(7);
    const b = new BatchAnalyzer({ engine, options: { movetime: 10 }, stallMs: 0 });
    expect((await b.run(game).promise).moves).toHaveLength(7);
  });

  it('formats long timeouts in seconds', () => {
    expect(new EngineStallError(60_000).message).toBe(
      'the engine stopped responding (no output for 60 s)',
    );
  });
});
