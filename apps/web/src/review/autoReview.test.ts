import { Chess } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveStore } from '../live/liveStore';
import { FakePlayEngine } from '../play/fakePlayEngine';
import { configurePlay, resetPlay, usePlayStore } from '../play/playStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { ENGINE_GAME_REVIEW_MIN_PLIES, installAutoReview, isGameLoad } from './autoReview';
import { useReviewStore } from './reviewStore';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';
const start = vi.fn(() => Promise.resolve(undefined));
const reset = vi.fn();
let uninstall: () => void = () => undefined;

beforeEach(() => {
  start.mockClear();
  reset.mockClear();
  useGameStore.getState().reset();
  useSettingsStore.setState({ autoReview: true });
  usePlayStore.setState({ mode: 'idle' });
  useUiStore.setState({ activeTab: 'import' });
  useReviewStore.setState({ start, reset });
  uninstall = installAutoReview();
});

afterEach(() => {
  uninstall();
  usePlayStore.setState({ mode: 'idle' });
  useLiveStore.setState({ status: 'idle' });
});

describe('auto review', () => {
  it('a loaded game starts a fast review and opens the Review tab', () => {
    expect(useGameStore.getState().loadPgn(SCHOLAR)).toBe(true);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ movetime: 300 }, { auto: true });
    expect(useUiStore.getState().activeTab).toBe('review');
    // Loading again (e.g. another game) restarts it.
    useGameStore.getState().loadPgn('1. d4 d5 2. c4');
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a load from the Explorer tab reviews in the background without switching tabs', () => {
    useUiStore.setState({ activeTab: 'explorer' });
    useGameStore.getState().loadPgn(SCHOLAR);
    expect(start).toHaveBeenCalledWith({ movetime: 300 }, { auto: true });
    expect(useUiStore.getState().activeTab).toBe('explorer');
  });

  it('manual moves, navigation, takebacks, new game and FEN loads do not trigger', () => {
    const g = useGameStore.getState();
    g.makeMove('e2', 'e4');
    g.makeMove('e7', 'e5');
    g.makeMove('g1', 'f3');
    g.goTo(1);
    g.undo();
    g.reset();
    g.loadFen('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
    expect(start).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeTab).toBe('import');
  });

  it('games with fewer than 2 moves are not reviewed', () => {
    useGameStore.getState().loadPgn('1. e4');
    expect(start).not.toHaveBeenCalled();
  });

  it('does nothing when the setting is off', () => {
    useSettingsStore.setState({ autoReview: false });
    useGameStore.getState().loadPgn(SCHOLAR);
    expect(start).not.toHaveBeenCalled();
    expect(useUiStore.getState().activeTab).toBe('import');
  });

  it('never runs while a game against the engine is in progress', () => {
    usePlayStore.setState({ mode: 'playing' });
    useGameStore.getState().loadPgn(SCHOLAR);
    // Moves played in the engine game never look like a load either.
    useGameStore.getState().makeMove('a2', 'a3');
    expect(start).not.toHaveBeenCalled();
  });

  it('runs again once the engine game is over', () => {
    usePlayStore.setState({ mode: 'finished' });
    useGameStore.getState().loadPgn(SCHOLAR);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('never runs while a live lichess game runs; reviews it when it finishes, staying on the Live tab', () => {
    useUiStore.setState({ activeTab: 'live' });
    useLiveStore.setState({ status: 'playing' });
    useGameStore.getState().loadPgn(SCHOLAR); // e.g. the live controller installing the game
    expect(start).not.toHaveBeenCalled();
    useLiveStore.setState({ status: 'finished' });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith({ movetime: 300 }, { auto: true });
    expect(useUiStore.getState().activeTab).toBe('live');
  });

  it('a live game that ends with fewer than 2 moves (abort) is not reviewed', () => {
    useLiveStore.setState({ status: 'playing' });
    useGameStore.getState().makeMove('e2', 'e4');
    useLiveStore.setState({ status: 'finished' });
    expect(start).not.toHaveBeenCalled();
  });

  it('cancels a running review when a live game or seek starts', () => {
    const cancel = vi.fn();
    useReviewStore.setState({ status: 'running', cancel });
    useLiveStore.setState({ status: 'seeking' });
    expect(cancel).toHaveBeenCalledTimes(1);
    useReviewStore.setState({ status: 'idle' });
  });

  it('isGameLoad needs replaced headers/start position and at least two moves', () => {
    const a = { headers: {}, startFen: 's', moves: [] };
    const m = [
      { san: 'e4', from: 'e2', to: 'e4', fen: 'x' },
      { san: 'e5', from: 'e7', to: 'e5', fen: 'y' },
    ];
    expect(isGameLoad({ ...a, headers: {}, moves: m }, a)).toBe(true);
    expect(isGameLoad({ ...a, moves: m }, a)).toBe(false);
    expect(isGameLoad({ ...a, startFen: 't', moves: m }, a)).toBe(true);
    expect(isGameLoad({ ...a, headers: {}, moves: m.slice(0, 1) }, a)).toBe(false);
  });

  describe('after a game against the engine', () => {
    const flush = () => new Promise<void>((r) => queueMicrotask(r));
    const loadMoves = (n: number) => {
      const line = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'].slice(0, n);
      useGameStore.getState().reset();
      for (const san of line) {
        const g = useGameStore.getState();
        const fen = g.moves.at(-1)?.fen ?? g.startFen;
        const m = new Chess(fen).move(san);
        g.makeMove(m.from, m.to);
      }
    };

    it(`reviews a finished game of at least ${ENGINE_GAME_REVIEW_MIN_PLIES} plies in the background`, async () => {
      useUiStore.setState({ activeTab: 'play' });
      loadMoves(ENGINE_GAME_REVIEW_MIN_PLIES);
      usePlayStore.setState({ mode: 'playing' });
      usePlayStore.setState({ mode: 'finished', reason: 'resign', result: '0-1' });
      // Deferred until the play store has finished its own bookkeeping.
      expect(start).not.toHaveBeenCalled();
      await flush();
      expect(reset).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({ movetime: 300 }, { auto: true });
      expect(useUiStore.getState().activeTab).toBe('play');
    });

    it('not for short games, aborted games, or with the setting off', async () => {
      loadMoves(ENGINE_GAME_REVIEW_MIN_PLIES - 1);
      usePlayStore.setState({ mode: 'playing' });
      usePlayStore.setState({ mode: 'finished', reason: 'resign' });
      await flush();
      loadMoves(ENGINE_GAME_REVIEW_MIN_PLIES);
      usePlayStore.setState({ mode: 'playing' });
      usePlayStore.setState({ mode: 'finished', reason: 'aborted' });
      await flush();
      useSettingsStore.setState({ autoReview: false });
      usePlayStore.setState({ mode: 'playing' });
      usePlayStore.setState({ mode: 'finished', reason: 'resign' });
      await flush();
      expect(start).not.toHaveBeenCalled();
    });

    it('not when another game started right away (rematch)', async () => {
      loadMoves(ENGINE_GAME_REVIEW_MIN_PLIES);
      usePlayStore.setState({ mode: 'playing' });
      usePlayStore.setState({ mode: 'finished', reason: 'resign' });
      usePlayStore.setState({ mode: 'playing' });
      await flush();
      expect(start).not.toHaveBeenCalled();
    });

    it('a new engine game cancels a running review', () => {
      const cancel = vi.fn();
      useReviewStore.setState({ status: 'running', cancel });
      usePlayStore.setState({ mode: 'playing' });
      expect(cancel).toHaveBeenCalledTimes(1);
      useReviewStore.setState({ status: 'idle' });
    });

    it('integration: a real engine game that ends by resignation is reviewed', async () => {
      await configurePlay({
        createEngine: () => new FakePlayEngine(),
        extraDelayMs: () => 0,
        random: () => 0.1,
      });
      try {
        usePlayStore.getState().start({ color: 'white', from: 'start', timeControl: null });
        for (const [from, to] of [
          ['a2', 'a3'],
          ['b2', 'b3'],
          ['c2', 'c3'],
        ] as const) {
          const plies = useGameStore.getState().moves.length;
          expect(useGameStore.getState().makeMove(from, to)).toBe(true);
          await vi.waitFor(() => expect(useGameStore.getState().moves.length).toBe(plies + 2));
        }
        usePlayStore.getState().resign();
        await flush();
        expect(start).toHaveBeenCalledWith({ movetime: 300 }, { auto: true });
      } finally {
        await resetPlay();
      }
    });
  });
});
