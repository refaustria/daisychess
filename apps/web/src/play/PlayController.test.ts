import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentFen, START_FEN, useGameStore } from '../store/gameStore';
import { FakePlayEngine } from './fakePlayEngine';
import type { Outcome } from './outcome';
import { PlayController, type PlayConfig } from './PlayController';
import { findStrength } from './strength';

const g = () => useGameStore.getState();
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

let engine: FakePlayEngine;
let created: number;
let thinking: boolean[];
let over: Outcome[];
let errors: string[];
let ctl: PlayController;

const config = (patch: Partial<PlayConfig> = {}): PlayConfig => ({
  playerColor: 'white',
  strength: findStrength('1350'),
  moveTime: 100,
  ...patch,
});

function makeController(idleDisposeMs?: number) {
  return new PlayController({
    game: useGameStore,
    createEngine: () => {
      created++;
      return engine;
    },
    extraDelayMs: () => 0,
    idleDisposeMs,
    onThinking: (t) => thinking.push(t),
    onGameOver: (o) => over.push(o),
    onError: (m) => errors.push(m),
  });
}

beforeEach(() => {
  engine = new FakePlayEngine();
  created = 0;
  thinking = [];
  over = [];
  errors = [];
  g().loadFen(START_FEN);
  ctl = makeController();
});

afterEach(async () => {
  await ctl.dispose();
  vi.useRealTimers();
});

describe('PlayController', () => {
  it('does not move while it is the player’s turn; answers after the player moved', async () => {
    ctl.start(config());
    await flush();
    expect(engine.searches).toHaveLength(0);
    expect(created).toBe(0);
    expect(g().makeMove('e2', 'e4')).toBe(true);
    expect(ctl.isThinking).toBe(true);
    await flush();
    expect(engine.searches).toHaveLength(1);
    expect(engine.searches[0]!.fen).toBe(g().moves[0]!.fen);
    expect(engine.searches[0]!.opts).toEqual({ movetime: 100 });
    expect(g().moves).toHaveLength(2);
    expect(g().ply).toBe(2);
    expect(thinking).toEqual([true, false]);
    expect(ctl.isThinking).toBe(false);
  });

  it('moves first when the player has Black, and never searches twice at once', async () => {
    ctl.start(config({ playerColor: 'black' }));
    await flush();
    expect(g().moves).toHaveLength(1);
    expect(g().makeMove('e7', 'e5') || g().makeMove('e7', 'e6')).toBe(true);
    await flush();
    expect(g().moves).toHaveLength(3);
    expect(engine.maxActive).toBe(1);
    expect(engine.loadCalls).toBe(1);
  });

  it('applies the strength options once; full strength clears the limit', async () => {
    ctl.start(config({ playerColor: 'black' }));
    await flush();
    g().makeMove('e7', 'e5');
    await flush();
    expect(engine.options).toEqual([{ UCI_LimitStrength: true, UCI_Elo: 1350 }]);
    ctl.start(config({ playerColor: 'black', strength: findStrength('full') }));
    g().makeMove('g8', 'f6');
    await flush();
    expect(engine.options.at(-1)).toEqual({ UCI_LimitStrength: false });
  });

  it('takeback (position change) cancels the pending engine move', async () => {
    engine.manual = true;
    ctl.start(config());
    g().makeMove('e2', 'e4');
    await flush();
    expect(engine.pending).toBe(1);
    g().undo(); // player's turn again
    expect(ctl.isThinking).toBe(false);
    expect(engine.stopCalls).toBeGreaterThan(0);
    engine.release();
    await flush();
    expect(g().moves).toHaveLength(0);
  });

  it('a result for an outdated position is dropped even if the engine answers late', async () => {
    engine.manual = true;
    ctl.start(config());
    g().makeMove('e2', 'e4');
    await flush();
    // Replace the move with another one: still the engine's turn, but a different position.
    g().undo();
    g().makeMove('d2', 'd4');
    await flush();
    expect(engine.searches.map((s) => s.fen)).toEqual([
      expect.stringContaining('4P3'),
      expect.stringContaining('3P4'),
    ]);
    engine.release();
    await flush();
    expect(g().moves).toHaveLength(2);
    expect(g().moves[0]!.san).toBe('d4');
  });

  it('holds its move while the user views an earlier ply and plays it at the tip', async () => {
    engine.manual = true;
    ctl.start(config());
    g().makeMove('e2', 'e4');
    await flush();
    g().goTo(0);
    engine.release();
    await flush();
    expect(g().moves).toHaveLength(1);
    expect(g().ply).toBe(0);
    expect(ctl.isThinking).toBe(true);
    g().last();
    expect(g().moves).toHaveLength(2);
    expect(g().ply).toBe(2);
  });

  it('falls back to the info pv when bestMove is missing', async () => {
    engine.noBestMove = true;
    ctl.start(config());
    g().makeMove('e2', 'e4');
    await flush();
    expect(g().moves).toHaveLength(2);
  });

  it('plays engine promotions (UCI with piece letter)', async () => {
    g().loadFen('7k/8/8/8/8/8/p7/7K b - - 0 1');
    engine.pickMove = () => 'a2a1n';
    ctl.start(config());
    await flush();
    expect(g().moves[0]!.san).toBe('a1=N');
  });

  it('detects checkmate by the player and by the engine', async () => {
    g().loadFen('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    ctl.start(config());
    g().makeMove('a1', 'a8');
    await flush();
    expect(over).toEqual([{ result: '1-0', reason: 'checkmate' }]);
    expect(engine.searches).toHaveLength(0);
    expect(ctl.active).toBe(false);

    g().loadFen('r5k1/8/8/8/8/8/5PPP/6K1 b - - 0 1');
    engine.pickMove = () => 'a8a1';
    ctl.start(config());
    await flush();
    expect(over.at(-1)).toEqual({ result: '0-1', reason: 'checkmate' });
  });

  it('detects threefold repetition', async () => {
    const shuffle = ['g8f6', 'f6g8', 'g8f6', 'f6g8'];
    let i = 0;
    engine.pickMove = () => shuffle[i++] ?? null;
    ctl.start(config());
    for (const [from, to] of [
      ['g1', 'f3'],
      ['f3', 'g1'],
      ['g1', 'f3'],
      ['f3', 'g1'],
    ] as const) {
      g().makeMove(from, to);
      await flush();
    }
    expect(over).toEqual([{ result: '½-½', reason: 'threefold_repetition' }]);
  });

  it('engine errors end the game and dispose the engine', async () => {
    engine.failSearch = new Error('worker crashed');
    ctl.start(config());
    g().makeMove('e2', 'e4');
    await flush();
    expect(errors).toEqual(['worker crashed']);
    expect(ctl.active).toBe(false);
    expect(ctl.isThinking).toBe(false);
    expect(engine.disposed).toBe(true);
  });

  it('load failures and illegal engine moves are reported', async () => {
    engine.failLoad = new Error('no wasm');
    ctl.start(config());
    g().makeMove('e2', 'e4');
    await flush();
    expect(errors).toEqual(['no wasm']);

    engine = new FakePlayEngine();
    engine.pickMove = () => 'a1a5';
    g().loadFen(START_FEN);
    ctl.start(config({ playerColor: 'black' }));
    await flush();
    expect(errors.at(-1)).toMatch(/illegal move \(a1a5\)/);
  });

  it('stop cancels the search; the engine is disposed after the idle timeout unless reused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    ctl = makeController(1000);
    engine.manual = true;
    ctl.start(config());
    g().makeMove('e2', 'e4');
    await vi.advanceTimersByTimeAsync(0);
    ctl.stop();
    expect(engine.stopCalls).toBe(1);
    engine.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(g().moves).toHaveLength(1);
    // A new game within the idle window reuses the loaded engine.
    ctl.start(config({ playerColor: 'black' }));
    engine.manual = false;
    engine.release();
    await vi.advanceTimersByTimeAsync(1500);
    expect(engine.disposed).toBe(false);
    expect(created).toBe(1);
    ctl.stop();
    await vi.advanceTimersByTimeAsync(999);
    expect(engine.disposed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(engine.disposed).toBe(true);
  });

  it('uses the tip FEN of the game store', () => {
    ctl.start(config({ playerColor: 'black' }));
    expect(ctl.isThinking).toBe(true);
    expect(currentFen(g())).toBe(START_FEN);
  });
});
