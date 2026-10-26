import type { Puzzle } from '@daisychess/puzzles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAnalysisPause } from '../engine/analysisPause';
import { useGameStore } from '../store/gameStore';
import { useUiStore } from '../store/uiStore';
import { resetPuzzleStore, usePuzzleStore, type PuzzlePort } from './puzzleStore';

const P: Puzzle = {
  id: 'x1',
  fen: '6k1/5ppp/8/4n3/8/8/8/RR4K1 b - - 0 1',
  moves: ['e5c4', 'a1a8'],
  rating: 1500,
  rd: 80,
  themes: ['mateIn1'],
  openings: ['Italian_Game'],
  source: 'lichess',
};

describe('openWithFilter', () => {
  let seen: unknown[];
  let result: Puzzle | null;
  const port = (): PuzzlePort => ({
    nextPuzzle: (f) => {
      seen.push(f);
      return Promise.resolve(result);
    },
    load: () => ({
      rating: { rating: 1500, rd: 350, vol: 0.09, n: 0 },
      difficulty: 'normal',
      filter: {},
    }),
    settle: () => ({ rating: 1500, rd: 350, vol: 0.09, n: 1 }),
    saveDifficulty: () => undefined,
    saveFilter: () => undefined,
    markSeen: () => undefined,
  });

  beforeEach(() => {
    vi.useFakeTimers();
    resetAnalysisPause();
    useGameStore.getState().reset();
    seen = [];
    result = P;
    resetPuzzleStore(port());
  });
  afterEach(() => {
    resetPuzzleStore(port());
    vi.useRealTimers();
  });

  it('sets the filter, shows the Puzzles tab and starts a matching puzzle', async () => {
    await usePuzzleStore.getState().openWithFilter({ opening: 'Italian_Game' });
    expect(seen).toEqual([{ opening: 'Italian_Game' }]);
    expect(usePuzzleStore.getState().filter).toEqual({ opening: 'Italian_Game' });
    expect(useUiStore.getState().activeTab).toBe('puzzles');
    expect(usePuzzleStore.getState().status).toBe('running');
  });

  it('shows the empty state when nothing matches', async () => {
    result = null;
    await usePuzzleStore.getState().openWithFilter({ theme: 'mateIn1' });
    expect(usePuzzleStore.getState().status).toBe('empty');
    expect(usePuzzleStore.getState().message).toMatch(/No more puzzles/);
  });
});
