import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStore } from '../store/analysisStore';
import { START_FEN, useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { FakePlayEngine } from './fakePlayEngine';
import { configurePlay, resetPlay, takeBackPlies, usePlayStore } from './playStore';

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
    expect(g().moves.map((m) => m.san).filter((_, i) => i % 2 === 0)).toEqual(['e4', 'd4', 'Nf3']);
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
    expect(p().setup).toEqual({ color: 'white', strength: '1500', moveTime: 500 });
  });
});
