import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { installAutoReview, isGameLoad } from './autoReview';
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
});
