// @vitest-environment jsdom
import type { Puzzle } from '@daisychess/puzzles';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAnalysisPause } from '../../engine/analysisPause';
import { usePlayStore } from '../../play/playStore';
import { INTRO_DELAY_MS, resetPuzzleStore, type PuzzlePort } from '../../puzzles/puzzleStore';
import { resetRushStore, useRushStore, type RushPort } from '../../puzzles/rushStore';
import { useAnalysisStore } from '../../store/analysisStore';
import { useGameStore } from '../../store/gameStore';
import { PuzzlesPanel } from './PuzzlesPanel';

const PUZZLE: Puzzle = {
  id: 'r1',
  fen: '6k1/5ppp/8/4n3/8/8/8/RR4K1 b - - 0 1',
  moves: ['e5c4', 'a1a8'],
  rating: 900,
  rd: 80,
  themes: [],
  openings: [],
  source: 'lichess',
};

const puzzlePort: PuzzlePort = {
  nextPuzzle: () => Promise.resolve(null),
  load: () => ({
    rating: { rating: 1500, rd: 350, vol: 0.09, n: 0 },
    difficulty: 'normal',
    filter: {},
  }),
  settle: () => ({ rating: 1500, rd: 350, vol: 0.09, n: 0 }),
  saveDifficulty: () => undefined,
  saveFilter: () => undefined,
  markSeen: () => undefined,
};

const rushPort: RushPort = {
  pool: () => Promise.resolve([PUZZLE]),
  seen: () => [],
  record: () => true,
};

const originalSetEnabled = useAnalysisStore.getState().setEnabled;

beforeEach(() => {
  vi.useFakeTimers();
  resetAnalysisPause();
  useAnalysisStore.setState({
    enabled: false,
    setEnabled: (enabled: boolean) => useAnalysisStore.setState({ enabled }),
  });
  useGameStore.getState().reset();
  usePlayStore.setState({ mode: 'idle' });
  resetPuzzleStore(puzzlePort);
  resetRushStore(rushPort);
});

afterEach(() => {
  cleanup();
  resetRushStore();
  resetPuzzleStore();
  useAnalysisStore.setState({ setEnabled: originalSetEnabled });
  vi.useRealTimers();
});

describe('Rush mode in the Puzzles tab', () => {
  it('switches to Rush, runs a puzzle with timer, score and strikes, then shows the result', async () => {
    render(<PuzzlesPanel />);
    expect(screen.getByRole('button', { name: 'Puzzles' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rush' }));
    expect(screen.getByTestId('rush-best').textContent).toContain('3 min 0 · 5 min 0');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '3 minutes' }));
    });
    act(() => {
      vi.advanceTimersByTime(INTRO_DELAY_MS);
    });
    expect(screen.getByTestId('rush-timer').textContent).toMatch(/^2:5\d$/);
    expect(screen.getByTestId('rush-status').textContent).toContain('Puzzle 1: your move.');
    expect((screen.getByRole('button', { name: 'Puzzles' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    act(() => {
      useGameStore.getState().makeMove('a1', 'a8');
    });
    expect(screen.getByTestId('rush-score').textContent).toContain('Score 1');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'End run' }));
    });
    expect(screen.getByTestId('rush-result').textContent).toContain('Final score 1');
    expect(screen.getByTestId('rush-result').textContent).toContain('new best');
    expect(useRushStore.getState().status).toBe('over');
    expect(screen.getByRole('button', { name: '5 minutes' })).toBeTruthy();
  });
});
