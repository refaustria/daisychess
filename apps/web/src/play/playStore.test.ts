import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnalysisStore } from '../store/analysisStore';
import { START_FEN, useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { FakePlayEngine } from './fakePlayEngine';
import {
  configurePlay,
  PLAY_STORAGE_KEY,
  readPlaySetup,
  resetPlay,
  takeBackPlies,
  usePlayStore,
} from './playStore';

const g = () => useGameStore.getState();
const p = () => usePlayStore.getState();
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

let engine: FakePlayEngine;
let random = 0.1;

beforeEach(async () => {
  engine = new FakePlayEngine();
  await configurePlay({ createEngine: () => engine, extraDelayMs: () => 0, random: () => random });
  usePlayStore.setState({ setup: { color: 'white', strength: '1500', moveTime: 500 } });
  g().loadPgn('1. e4 e5');
  useAnalysisStore.getState().setEnabled(true);
});

afterEach(async () => {
  await resetPlay();
  useAnalysisStore.getState().setEnabled(false);
});

describe('takeBackPlies', () => {
  it('goes back to the player’s previous turn', () => {
    const game = (pgn: string) => {
      g().loadPgn(pgn);
      return g();
    };
    expect(takeBackPlies(game('1. e4 e5'), 'white')).toBe(2);
    expect(takeBackPlies(game('1. e4'), 'white')).toBe(1);
    expect(takeBackPlies(game('1. e4'), 'black')).toBe(0);
    expect(takeBackPlies(game('1. e4 e5'), 'black')).toBe(1);
    expect(takeBackPlies(game('1. e4 e5 2. Nf3'), 'black')).toBe(2);
  });
});

describe('playStore', () => {
  it.each([
    ['reset', () => g().reset()],
    ['loadFen', () => g().loadFen('7k/8/8/8/8/8/8/K7 w - - 0 1')],
    ['loadPgn', () => g().loadPgn('1. d4 d5')],
  ])('%s while playing aborts the game and restores analysis', async (_n, load) => {
    p().start({ color: 'white' });
    await flush();
    expect(useAnalysisStore.getState().enabled).toBe(false);
    load();
    expect(p().mode).toBe('finished');
    expect(p().reason).toBe('aborted');
    expect(p().result).toBeUndefined();
    expect(useAnalysisStore.getState().enabled).toBe(true);
    await flush();
    expect(g().moves.length).toBeLessThanOrEqual(2); // the engine does not keep playing
  });

  it('start resets the game, orients the board, pauses analysis; resign restores it', async () => {
    p().start({ color: 'black', strength: '1800', moveTime: 100 });
    expect(p().mode).toBe('playing');
    expect(p().playerColor).toBe('black');
    expect(g().orientation).toBe('black');
    expect(g().startFen).toBe(START_FEN);
    expect(useAnalysisStore.getState().enabled).toBe(false);
    await flush();
    expect(g().moves).toHaveLength(1); // the engine opened as White
    expect(engine.options).toEqual([{ UCI_LimitStrength: true, UCI_Elo: 1800 }]);
    expect(engine.searches[0]!.opts).toEqual({ movetime: 100 });
    expect(p().thinking).toBe(false);

    p().resign();
    expect(p().mode).toBe('finished');
    expect(p().result).toBe('1-0');
    expect(p().reason).toBe('resign');
    expect(useAnalysisStore.getState().enabled).toBe(true);
  });

  it('premoves (queue): played one per turn after the engine replies; cleared on stop', async () => {
    useSettingsStore.setState({ premoves: 'queue' });
    p().start({ color: 'white' });
    g().makeMove('e2', 'e4');
    p().addPremove('d2d4');
    p().addPremove('g1f3');
    expect(p().premoves).toEqual(['d2d4', 'g1f3']);
    await flush();
    // Engine reply, premove d4, engine reply, premove Nf3, engine reply.
    expect(
      g()
        .moves.map((m) => m.san)
        .filter((_, i) => i % 2 === 0),
    ).toEqual(['e4', 'd4', 'Nf3']);
    expect(p().premoves).toEqual([]);
    p().addPremove('a2a3');
    p().stop();
    expect(p().premoves).toEqual([]);
    useSettingsStore.setState({ premoves: 'single' });
  });

  it('keeps live analysis off while playing, even if switched on', () => {
    p().start();
    useAnalysisStore.getState().setEnabled(true);
    expect(useAnalysisStore.getState().enabled).toBe(false);
    p().stop();
    expect(p().mode).toBe('idle');
    expect(useAnalysisStore.getState().enabled).toBe(true);
  });

  it('does not switch analysis on afterwards when it was off before', () => {
    useAnalysisStore.getState().setEnabled(false);
    p().start();
    p().stop();
    expect(useAnalysisStore.getState().enabled).toBe(false);
  });

  it('takeBack removes the engine reply and the player’s move in one update', async () => {
    p().start({ color: 'white' });
    g().makeMove('e2', 'e4');
    await flush();
    expect(g().moves).toHaveLength(2);
    const seen: number[] = [];
    const unsub = useGameStore.subscribe((s) => seen.push(s.moves.length));
    p().takeBack();
    unsub();
    expect(seen).toEqual([0]);
    expect(g().moves).toHaveLength(0);
    await flush();
    expect(engine.searches).toHaveLength(1);
    expect(p().mode).toBe('playing');
  });

  it('takeBack while the engine thinks removes the player’s move and drops the search', async () => {
    engine.manual = true;
    p().start({ color: 'white' });
    g().makeMove('e2', 'e4');
    await flush();
    expect(p().thinking).toBe(true);
    p().takeBack();
    expect(p().thinking).toBe(false);
    engine.release();
    await flush();
    expect(g().moves).toHaveLength(0);
  });

  it('random colour, checkmate result and rematch', async () => {
    random = 0.9;
    p().start({ color: 'random' });
    expect(p().playerColor).toBe('black');
    random = 0.1;
    p().rematch();
    expect(p().playerColor).toBe('white');
    expect(p().setup.color).toBe('random');
    expect(g().moves).toHaveLength(0);
    // Fool's mate against the player.
    const replies = ['e7e5', 'd8h4'];
    engine.pickMove = () => replies.shift() ?? null;
    g().makeMove('f2', 'f3');
    await flush();
    g().makeMove('g2', 'g4');
    await flush();
    expect(p().mode).toBe('finished');
    expect(p().result).toBe('0-1');
    expect(p().reason).toBe('checkmate');
  });

  it('engine errors finish the game with a message', async () => {
    engine.failSearch = new Error('worker crashed');
    p().start({ color: 'black' });
    await flush();
    expect(p().mode).toBe('finished');
    expect(p().reason).toBe('engine_error');
    expect(p().result).toBeUndefined();
    expect(p().message).toBe('worker crashed');
    expect(useAnalysisStore.getState().enabled).toBe(true);
  });

  it('sanitizes the setup', () => {
    p().start({ strength: 'bogus', moveTime: 42 });
    expect(p().setup).toEqual({
      color: 'white',
      strength: '1500',
      moveTime: 500,
      timeControl: null,
      from: 'start',
    });
  });
});

describe('playStore clock', () => {
  let nowMs = 0;
  const tc = (initialMs: number, incrementMs = 0) => ({ timeControl: { initialMs, incrementMs } });

  beforeEach(async () => {
    nowMs = 1000;
    await configurePlay({
      createEngine: () => engine,
      extraDelayMs: () => 0,
      random: () => random,
      now: () => nowMs,
    });
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs only the side to move; Fischer increment; engine time follows the clock', async () => {
    engine.manual = true;
    p().start({ color: 'white', moveTime: 3000, ...tc(60_000, 1000) });
    expect(p().clock).toMatchObject({ w: 60_000, b: 60_000, runningSide: 'w' });
    nowMs += 5000;
    g().makeMove('e2', 'e4');
    // -5 s +1 s; the engine's clock waits for its search to start.
    expect(p().clock).toMatchObject({ w: 56_000, b: 60_000, runningSide: null });
    await flush();
    expect(p().clock?.runningSide).toBe('b');
    // min(3000, max(50, 60000/30 + 0.8 × 1000)) = 2800
    expect(engine.searches[0]!.opts).toEqual({ movetime: 2800 });
    nowMs += 2500;
    engine.release();
    await flush();
    expect(g().moves).toHaveLength(2);
    expect(p().clock).toMatchObject({ w: 56_000, b: 58_500, runningSide: 'w' });
    p().resign();
    expect(p().clock?.runningSide).toBeNull();
    nowMs += 10_000;
    p().tick();
    expect(p().clock).toMatchObject({ w: 56_000, b: 58_500 }); // paused when finished
  });

  it('no clock: unchanged behaviour', async () => {
    p().start({ color: 'black', moveTime: 100, timeControl: null });
    expect(p().clock).toBeNull();
    await flush();
    expect(engine.searches[0]!.opts).toEqual({ movetime: 100 });
  });

  it('the user flags: game over on time, the engine wins; the ticker stops', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    p().start({ color: 'white', ...tc(15_000) });
    expect(vi.getTimerCount()).toBe(1);
    nowMs += 14_000;
    vi.advanceTimersByTime(100);
    expect(p().mode).toBe('playing');
    expect(p().clock?.w).toBe(1000);
    nowMs += 1000;
    vi.advanceTimersByTime(100);
    expect(p().mode).toBe('finished');
    expect(p().reason).toBe('timeout');
    expect(p().result).toBe('0-1');
    expect(p().clock).toMatchObject({ w: 0, flagged: 'w', runningSide: null });
    expect(vi.getTimerCount()).toBe(0);
    expect(useAnalysisStore.getState().enabled).toBe(true);
  });

  it('a late tick (throttled background tab) still flags with the exact elapsed time', () => {
    p().start({ color: 'white', ...tc(15_000) });
    nowMs += 60_000;
    p().tick();
    expect(p()).toMatchObject({ mode: 'finished', reason: 'timeout', result: '0-1' });
  });

  it('a move after the time ran out (before the tick noticed) loses on time', () => {
    p().start({ color: 'white', ...tc(15_000) });
    nowMs += 15_500;
    g().makeMove('e2', 'e4');
    expect(p()).toMatchObject({ mode: 'finished', reason: 'timeout', result: '0-1' });
  });

  it('the engine’s clock starts with its search (loading the engine is not charged)', async () => {
    engine.manual = true;
    p().start({ color: 'black', ...tc(60_000) });
    expect(p().clock).toMatchObject({ w: 60_000, runningSide: null });
    nowMs += 5000; // engine loading
    await flush();
    expect(p().clock).toMatchObject({ w: 60_000, runningSide: 'w' });
    nowMs += 1000;
    engine.release();
    await flush();
    expect(p().clock).toMatchObject({ w: 59_000, b: 60_000, runningSide: 'b' });
  });

  it('the engine flags while thinking: the user wins, the search is dropped', async () => {
    engine.manual = true;
    p().start({ color: 'black', ...tc(15_000) });
    await flush();
    expect(p().clock?.runningSide).toBe('w');
    expect(engine.searches[0]!.opts).toEqual({ movetime: 500 }); // min(500, 15000/30)
    nowMs += 15_000;
    p().tick();
    expect(p()).toMatchObject({ mode: 'finished', reason: 'timeout', result: '0-1' });
    engine.release();
    await flush();
    expect(g().moves).toHaveLength(0);
  });

  it('takeback: no increment, the user’s clock runs again', async () => {
    p().start({ color: 'white', ...tc(60_000, 2000) });
    nowMs += 1000;
    g().makeMove('e2', 'e4');
    await flush();
    expect(p().clock).toMatchObject({ w: 61_000, b: 62_000, runningSide: 'w' });
    nowMs += 3000;
    p().takeBack();
    expect(p().clock).toMatchObject({ w: 58_000, b: 62_000, runningSide: 'w' });
  });

  it('the engine’s clock stops once its move is ready (held while the user browses back)', async () => {
    engine.manual = true;
    p().start({ color: 'white', ...tc(60_000) });
    g().makeMove('e2', 'e4');
    await flush();
    g().goTo(0);
    nowMs += 1000;
    engine.release();
    await flush();
    expect(g().moves).toHaveLength(1); // held
    expect(p().clock).toMatchObject({ b: 59_000, runningSide: null });
    nowMs += 20_000;
    g().goTo(1);
    expect(g().moves).toHaveLength(2);
    expect(p().clock).toMatchObject({ w: 60_000, b: 59_000, runningSide: 'w' });
  });

  it('persists the last setup incl. the time control', () => {
    p().start({ color: 'black', strength: '1800', moveTime: 1000, ...tc(180_000, 2000) });
    expect(JSON.parse(localStorage.getItem(PLAY_STORAGE_KEY) ?? '{}')).toEqual({
      color: 'black',
      strength: '1800',
      moveTime: 1000,
      timeControl: { initialMs: 180_000, incrementMs: 2000 },
      from: 'start',
    });
    expect(readPlaySetup().timeControl).toEqual({ initialMs: 180_000, incrementMs: 2000 });
    p().setSetup({ timeControl: null });
    expect(readPlaySetup().timeControl).toBeNull();
    localStorage.setItem(PLAY_STORAGE_KEY, '{not json');
    expect(readPlaySetup()).toEqual({
      color: 'white',
      strength: '1500',
      moveTime: 500,
      timeControl: null,
      from: 'start',
    });
    localStorage.setItem(
      PLAY_STORAGE_KEY,
      JSON.stringify({ color: 'x', timeControl: { initialMs: 1, incrementMs: 0 } }),
    );
    expect(readPlaySetup()).toMatchObject({
      color: 'white',
      timeControl: { initialMs: 15_000, incrementMs: 0 },
    });
  });
});

describe('play from the current position', () => {
  it('takeBackPlies respects fromPly', () => {
    g().loadPgn('1. e4 e5 2. Nf3 Nc6');
    expect(takeBackPlies(g(), 'white')).toBe(2);
    expect(takeBackPlies(g(), 'white', 3)).toBe(0);
    expect(takeBackPlies(g(), 'white', 2)).toBe(2);
  });

  it('keeps the moves, truncates at the shown ply, engine moves first when it is to move', async () => {
    g().loadPgn('1. e4 e5 2. Nf3 Nc6');
    const headers = g().headers;
    g().goTo(3); // after 2. Nf3, Black to move; the later move is discarded
    p().start({ from: 'current', color: 'white' });
    expect(p().mode).toBe('playing');
    expect(p().fromPly).toBe(3);
    expect(g().headers).toBe(headers);
    expect(
      g()
        .moves.map((m) => m.san)
        .slice(0, 3),
    ).toEqual(['e4', 'e5', 'Nf3']);
    await flush();
    // Black (engine) to move: it answered, so the user (White) is on move now.
    expect(g().moves).toHaveLength(4);
    expect(g().moves[3]!.fen.split(' ')[1]).toBe('w');
    expect(readPlaySetup().from).toBe('current');
  });

  it('the user moves first when it is the user’s turn; takeback stops at the base', async () => {
    g().loadPgn('1. e4 e5');
    p().start({ from: 'current', color: 'white' });
    await flush();
    expect(engine.searches).toHaveLength(0);
    p().takeBack();
    expect(g().moves).toHaveLength(2); // nothing of the user's to take back
    g().makeMove('g1', 'f3');
    await flush();
    expect(g().moves).toHaveLength(4);
    p().takeBack();
    expect(g().moves).toHaveLength(2);
    expect(g().ply).toBe(2);
    expect(p().mode).toBe('playing');
  });

  it('rematch returns to the same base position', async () => {
    g().loadPgn('1. e4 e5 2. Nf3 Nc6');
    p().start({ from: 'current', color: 'white' });
    g().makeMove('f1', 'b5');
    await flush();
    p().resign();
    expect(g().moves.length).toBeGreaterThan(4);
    p().rematch();
    expect(p().mode).toBe('playing');
    expect(p().fromPly).toBe(4);
    expect(g().moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
  });

  it('refuses a terminal position with a message', () => {
    g().loadPgn('1. f3 e5 2. g4 Qh4#');
    p().start({ from: 'current', color: 'white' });
    expect(p().mode).toBe('idle');
    expect(p().message).toMatch(/Checkmate/);
    expect(g().moves).toHaveLength(4);
  });

  it('from start (default) still resets the board', () => {
    p().start({ color: 'white' });
    expect(p().fromPly).toBe(0);
    expect(g().moves).toHaveLength(0);
    expect(p().setup.from).toBe('start');
  });
});
