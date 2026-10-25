import type { EngineInfo } from '@daisychess/engine-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UciSession, type AnalysisHandle } from './UciSession';
import { FakeUciEngine, flush } from './testing';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BLACK_TO_MOVE = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

async function ready(opts?: ConstructorParameters<typeof UciSession>[1]) {
  const engine = new FakeUciEngine();
  const session = new UciSession(engine, opts);
  await session.handshake();
  return { engine, session, mark: engine.sent.length };
}

/** Collects an analysis in the background so tests can interleave engine output. */
function collect(handle: AnalysisHandle) {
  const infos: EngineInfo[] = [];
  let error: Error | undefined;
  const done = (async () => {
    try {
      for await (const i of handle) infos.push(i);
    } catch (e) {
      error = e as Error;
    }
  })();
  return {
    infos,
    done,
    get error() {
      return error;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UciSession handshake', () => {
  it('sends uci, waits for uciok, then isready/readyok', async () => {
    const engine = new FakeUciEngine();
    engine.autoHandshake = false;
    engine.autoReady = false;
    const session = new UciSession(engine);
    let resolved = false;
    const p = session.handshake().then(() => (resolved = true));
    await flush();
    expect(engine.sent).toEqual(['uci']);
    engine.emit('id name Stockfish 19');
    engine.emit('option name Hash type spin default 16 min 1 max 33554432');
    engine.emit('uciok');
    await flush();
    expect(engine.sent).toEqual(['uci', 'isready']);
    expect(resolved).toBe(false);
    engine.emit('readyok');
    await p;
    expect(resolved).toBe(true);
    expect(session.engineName).toBe('Stockfish 19');
    expect(session.optionNames.has('Hash')).toBe(true);
  });

  it('handles several lines in one message', async () => {
    const engine = new FakeUciEngine();
    engine.autoHandshake = false;
    const session = new UciSession(engine);
    const p = session.handshake();
    await flush();
    engine.emit('id name X\nuciok\n');
    await p;
    expect(session.engineName).toBe('X');
  });

  it('times out and fails the session when uciok never arrives', async () => {
    vi.useFakeTimers();
    const engine = new FakeUciEngine();
    engine.autoHandshake = false;
    const session = new UciSession(engine, { handshakeTimeoutMs: 1000 });
    const p = session.handshake();
    const assertion = expect(p).rejects.toThrow(/uciok.*1000 ms/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(session.isTerminated).toBe(true);
    await expect(session.setOptions({ Hash: 16 })).rejects.toThrow(/uciok/);
  });
});

describe('UciSession.setOptions', () => {
  it('sends setoption for each entry and waits for readyok', async () => {
    const { engine, session, mark } = await ready();
    engine.autoReady = false;
    let resolved = false;
    const p = session
      .setOptions({ MultiPV: 3, Threads: 2, Ponder: false })
      .then(() => (resolved = true));
    await flush();
    expect(engine.since(mark)).toEqual([
      'setoption name MultiPV value 3',
      'setoption name Threads value 2',
      'setoption name Ponder value false',
      'isready',
    ]);
    expect(resolved).toBe(false);
    engine.emit('readyok');
    await p;
    expect(resolved).toBe(true);
  });

  it('queues options behind a pending handshake', async () => {
    const engine = new FakeUciEngine();
    engine.autoHandshake = false;
    const session = new UciSession(engine);
    const hs = session.handshake();
    const opts = session.setOptions({ Hash: 32 });
    await flush();
    expect(engine.sent).toEqual(['uci']);
    engine.emit('uciok');
    await Promise.all([hs, opts]);
    expect(engine.sent).toEqual(['uci', 'isready', 'setoption name Hash value 32', 'isready']);
  });

  it('rejects values that would inject commands', async () => {
    const { engine, session, mark } = await ready();
    await expect(session.setOptions({ Hash: '16\nquit' })).rejects.toThrow(/Invalid UCI option/);
    expect(engine.since(mark)).toEqual([]);
  });

  it('stops a running search before changing options', async () => {
    const { engine, session, mark } = await ready();
    const a = collect(session.analyze(START));
    await flush();
    const p = session.setOptions({ MultiPV: 2 });
    await flush();
    expect(engine.since(mark)).toEqual([`position fen ${START}`, 'go infinite', 'stop']);
    engine.emit('bestmove e2e4');
    await p;
    await a.done;
    expect(engine.since(mark).slice(3)).toEqual(['setoption name MultiPV value 2', 'isready']);
  });

  it('does not cancel an analysis requested after setOptions', async () => {
    const { engine, session, mark } = await ready();
    const p = session.setOptions({ Hash: 64 });
    const a = collect(session.analyze(START, { depth: 5 }));
    await p;
    await flush();
    expect(engine.since(mark)).toEqual([
      'setoption name Hash value 64',
      'isready',
      `position fen ${START}`,
      'go depth 5',
    ]);
    engine.emit('info depth 1 score cp 20 pv e2e4');
    engine.emit('bestmove e2e4');
    await a.done;
    expect(a.infos).toHaveLength(1);
  });
});

describe('UciSession.analyze', () => {
  it('streams info lines with pv+score and completes on bestmove', async () => {
    const { engine, session, mark } = await ready();
    const handle = session.analyze(START, { depth: 2 });
    const a = collect(handle);
    await flush();
    expect(engine.since(mark)).toEqual([`position fen ${START}`, 'go depth 2']);
    engine.emit('info string NNUE evaluation enabled');
    engine.emit('info depth 1 seldepth 1 multipv 1 score cp 18 nodes 20 nps 10000 time 2 pv e2e4');
    engine.emit('info depth 2 currmove e2e4 currmovenumber 1');
    engine.emit(
      'info depth 2 seldepth 2 multipv 1 score cp 25 nodes 60 nps 12000 time 5 pv e2e4 e7e5',
    );
    engine.emit('bestmove e2e4 ponder e7e5');
    await a.done;
    expect(a.error).toBeUndefined();
    expect(a.infos.map((i) => [i.depth, i.score, i.pv])).toEqual([
      [1, { cp: 18 }, ['e2e4']],
      [2, { cp: 25 }, ['e2e4', 'e7e5']],
    ]);
    await expect(handle.bestMove).resolves.toEqual({ move: 'e2e4', ponder: 'e7e5' });
  });

  it('converts scores to White POV when Black is to move', async () => {
    const { engine, session } = await ready();
    const a = collect(session.analyze(BLACK_TO_MOVE, { depth: 3 }));
    await flush();
    engine.emit('info depth 1 score cp 40 pv e7e5');
    engine.emit('info depth 2 score cp -15 pv c7c5');
    engine.emit('info depth 3 score mate 2 pv d8h4');
    engine.emit('info depth 3 score mate -1 pv g7g5');
    engine.emit('bestmove d8h4');
    await a.done;
    expect(a.infos.map((i) => i.score)).toEqual([
      { cp: -40 },
      { cp: 15 },
      { mate: -2 },
      { mate: 1 },
    ]);
  });

  it('keeps White-to-move scores unchanged', async () => {
    const { engine, session } = await ready();
    const a = collect(session.analyze(START, { depth: 1 }));
    await flush();
    engine.emit('info depth 1 score mate 1 pv a1a8');
    engine.emit('bestmove a1a8');
    await a.done;
    expect(a.infos[0]?.score).toEqual({ mate: 1 });
  });

  it('builds go commands and sets MultiPV only when it changes', async () => {
    const { engine, session, mark } = await ready();
    const run = async (opts: Parameters<UciSession['analyze']>[1]) => {
      const a = collect(session.analyze(START, opts));
      await flush();
      engine.emit('bestmove e2e4');
      await a.done;
    };
    await run({ movetime: 500, multipv: 3 });
    await run({ depth: 12, multipv: 3 });
    await run({ depth: 8, movetime: 100 });
    await run({ multipv: 1 });
    expect(engine.since(mark).filter((l) => !l.startsWith('position'))).toEqual([
      'setoption name MultiPV value 3',
      'go movetime 500',
      'go depth 12',
      'go depth 8 movetime 100',
      'setoption name MultiPV value 1',
      'go infinite',
    ]);
  });

  it('rejects invalid input through the iterator', async () => {
    const { engine, session, mark } = await ready();
    const bad = collect(session.analyze(START, { depth: -1 }));
    const inj = collect(session.analyze(`${START}\ngo infinite`));
    await Promise.all([bad.done, inj.done]);
    expect(bad.error?.message).toMatch(/depth must be a positive integer/);
    expect(inj.error?.message).toMatch(/Invalid FEN/);
    expect(engine.since(mark)).toEqual([]);
  });

  it('handles bestmove (none) for terminal positions', async () => {
    const { engine, session } = await ready();
    const handle = session.analyze('7k/5QQ1/8/8/8/8/8/K7 b - - 0 1', { depth: 5 });
    const a = collect(handle);
    await flush();
    engine.emit('info depth 0 score mate 0');
    engine.emit('bestmove (none)');
    await a.done;
    expect(a.infos).toEqual([]);
    await expect(handle.bestMove).resolves.toBeNull();
  });

  it('a second analyze stops the first, waits for its bestmove, then starts', async () => {
    const { engine, session, mark } = await ready();
    const first = collect(session.analyze(START));
    await flush();
    engine.emit('info depth 5 score cp 30 pv e2e4');
    const second = collect(session.analyze(BLACK_TO_MOVE, { depth: 10 }));
    await flush();
    expect(engine.since(mark)).toEqual([`position fen ${START}`, 'go infinite', 'stop']);
    // Late output of the first search must not leak into the second.
    engine.emit('info depth 6 score cp 31 pv d2d4');
    engine.emit('bestmove d2d4');
    await first.done;
    await flush();
    expect(engine.since(mark).slice(3)).toEqual([`position fen ${BLACK_TO_MOVE}`, 'go depth 10']);
    engine.emit('info depth 1 score cp 10 pv e7e5');
    engine.emit('bestmove e7e5');
    await second.done;
    expect(first.infos.map((i) => i.pv[0])).toEqual(['e2e4', 'd2d4']);
    expect(second.infos.map((i) => i.score)).toEqual([{ cp: -10 }]);
  });

  it('cancels a superseded analysis that never started', async () => {
    const { engine, session, mark } = await ready();
    const a = collect(session.analyze(START));
    const b = collect(session.analyze(START, { depth: 3 }));
    const c = collect(session.analyze(BLACK_TO_MOVE, { depth: 4 }));
    await Promise.all([a.done, b.done]);
    await flush();
    expect(engine.since(mark)).toEqual([`position fen ${BLACK_TO_MOVE}`, 'go depth 4']);
    engine.emit('bestmove e7e5');
    await c.done;
    expect([a.error, b.error, c.error]).toEqual([undefined, undefined, undefined]);
  });

  it('stops the search when the consumer breaks out of the loop', async () => {
    const { engine, session, mark } = await ready();
    const handle = session.analyze(START);
    await flush();
    engine.emit('info depth 1 score cp 10 pv e2e4');
    for await (const info of handle) {
      expect(info.depth).toBe(1);
      break;
    }
    expect(engine.since(mark)).toEqual([`position fen ${START}`, 'go infinite', 'stop']);
    engine.emit('bestmove e2e4');
    await expect(handle.bestMove).resolves.toEqual({ move: 'e2e4' });
  });
});

describe('UciSession.stop', () => {
  it('sends stop and resolves after bestmove; the iterator completes', async () => {
    const { engine, session, mark } = await ready();
    const a = collect(session.analyze(START));
    await flush();
    let stopped = false;
    const p = session.stop().then(() => (stopped = true));
    await flush();
    expect(engine.since(mark)).toEqual([`position fen ${START}`, 'go infinite', 'stop']);
    expect(stopped).toBe(false);
    engine.emit('info depth 9 score cp 12 pv g1f3');
    engine.emit('bestmove g1f3');
    await p;
    await a.done;
    expect(a.infos).toHaveLength(1);
    expect(a.error).toBeUndefined();
  });

  it('is a no-op when idle', async () => {
    const { engine, session, mark } = await ready();
    await session.stop();
    expect(engine.since(mark)).toEqual([]);
  });

  it('cancels a pending analysis without sending go', async () => {
    const engine = new FakeUciEngine();
    engine.autoHandshake = false;
    const session = new UciSession(engine);
    const hs = session.handshake();
    const a = collect(session.analyze(START));
    await session.stop();
    await a.done;
    engine.emit('uciok');
    await hs;
    await flush();
    expect(engine.sent).toEqual(['uci', 'isready']);
  });

  it('fails the session if bestmove never arrives after stop', async () => {
    vi.useFakeTimers();
    const { session } = await ready({ responseTimeoutMs: 500 });
    const a = collect(session.analyze(START));
    await vi.advanceTimersByTimeAsync(0);
    const p = session.stop();
    const assertion = expect(p).rejects.toThrow(/bestmove.*500 ms/);
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    await a.done;
    expect(a.error?.message).toMatch(/bestmove/);
    expect(session.isTerminated).toBe(true);
  });
});

describe('UciSession failure and close', () => {
  it('fail() delivers buffered infos, then throws; later calls reject', async () => {
    const { engine, session } = await ready();
    const handle = session.analyze(START);
    await flush();
    engine.emit('info depth 1 score cp 10 pv e2e4');
    session.fail(new Error('worker crashed'));
    const a = collect(handle);
    await a.done;
    expect(a.infos).toHaveLength(1);
    expect(a.error?.message).toBe('worker crashed');
    await expect(handle.bestMove).resolves.toBeNull();
    await expect(session.setOptions({ Hash: 1 })).rejects.toThrow('worker crashed');
    const later = collect(session.analyze(START));
    await later.done;
    expect(later.error?.message).toBe('worker crashed');
  });

  it('rejects an in-flight isready when the session fails', async () => {
    const { engine, session } = await ready();
    engine.autoReady = false;
    const p = session.setOptions({ Hash: 1 });
    await flush();
    session.fail(new Error('boom'));
    await expect(p).rejects.toThrow('boom');
  });

  it('treats an Emscripten abort line as fatal', async () => {
    const { engine, session } = await ready();
    const a = collect(session.analyze(START));
    await flush();
    engine.emit('Aborted(OOM)');
    await a.done;
    expect(a.error?.message).toMatch(/Stockfish aborted: Aborted\(OOM\)/);
  });

  it('close() ends a running analysis without an error', async () => {
    const { engine, session } = await ready();
    const a = collect(session.analyze(START));
    await flush();
    engine.emit('info depth 1 score cp 10 pv e2e4');
    session.close();
    await a.done;
    expect(a.error).toBeUndefined();
    expect(a.infos).toHaveLength(1);
    await expect(session.setOptions({ Hash: 1 })).rejects.toThrow(/disposed/);
  });
});
