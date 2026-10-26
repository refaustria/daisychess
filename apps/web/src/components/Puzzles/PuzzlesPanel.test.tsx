// @vitest-environment jsdom
import type { Puzzle } from '@daisychess/puzzles';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAnalysisPause } from '../../engine/analysisPause';
import { usePlayStore } from '../../play/playStore';
import {
  INTRO_DELAY_MS,
  resetPuzzleStore,
  usePuzzleStore,
  WRONG_SHOW_MS,
  type PuzzlePort,
  type PuzzleRating,
} from '../../puzzles/puzzleStore';
import { useAnalysisStore } from '../../store/analysisStore';
import { useGameStore } from '../../store/gameStore';
import { PuzzlesPanel, statusLine } from './PuzzlesPanel';

const MATE: Puzzle = {
  id: 'mate2',
  fen: '6k1/5ppp/8/4n3/8/8/8/RR4K1 b - - 0 1',
  moves: ['e5c4', 'a1a8'],
  rating: 1500,
  rd: 80,
  themes: ['mateIn1'],
  openings: [],
  game: 'abcdefgh/black#48',
  source: 'lichess',
};

let queue: Puzzle[];
let rating: PuzzleRating;

function port(): PuzzlePort {
  return {
    nextPuzzle: () => Promise.resolve(queue.shift() ?? null),
    load: () => ({ rating, difficulty: 'normal', filter: {} }),
    settle: (_p, solved) => {
      rating = {
        ...rating,
        rating: rating.rating + (solved ? 120 : -80),
        rd: 200,
        n: rating.n + 1,
      };
      return rating;
    },
    saveDifficulty: () => undefined,
    saveFilter: () => undefined,
    markSeen: () => undefined,
  };
}

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
  queue = [MATE];
  rating = { rating: 1500, rd: 350, vol: 0.09, n: 0 };
  resetPuzzleStore(port());
});

afterEach(() => {
  cleanup();
  resetPuzzleStore(port());
  useAnalysisStore.setState({ setEnabled: originalSetEnabled });
  usePlayStore.setState({ mode: 'idle' });
  vi.useRealTimers();
});

const status = () => screen.getByTestId('puzzle-status');

async function startPuzzle() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start puzzles' }));
  });
  act(() => {
    vi.advanceTimersByTime(INTRO_DELAY_MS);
  });
}

describe('PuzzlesPanel', () => {
  it('shows the rating, the attribution and an aria-live status line', () => {
    render(<PuzzlesPanel />);
    expect(screen.getByTestId('puzzle-rating').textContent).toContain('Puzzle rating 1500 ± 350');
    expect(status().getAttribute('aria-live')).toBe('polite');
    expect(status().textContent).toContain('Press “Next puzzle” to start.');
    expect(screen.getByText('Puzzles from the lichess.org database (CC0)')).toBeTruthy();
  });

  it('solves a puzzle with the typed SAN input; the rating changes', async () => {
    render(<PuzzlesPanel />);
    await startPuzzle();
    expect(status().textContent).toContain('Your turn: find the best move for White.');
    const input = screen.getByLabelText('Move, e.g. Nf3');
    fireEvent.change(input, { target: { value: 'Qa8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('alert').textContent).toContain('Qa8 is not a legal move here.');
    fireEvent.change(input, { target: { value: 'Ra8#' } });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    });
    expect(status().textContent).toContain('Solved!');
    expect(screen.getByTestId('puzzle-rating').textContent).toContain('1620 ± 200');
    expect(screen.getByTestId('puzzle-rating-delta').textContent).toContain('(+120)');
    const link = screen.getByRole('link', { name: 'Source game' });
    expect(link.getAttribute('href')).toBe('https://lichess.org/abcdefgh/black#48');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Analyse' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Next puzzle' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('wrong move → Try again; Hint and Show solution', async () => {
    render(<PuzzlesPanel />);
    await startPuzzle();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    act(() => {
      useGameStore.getState().makeMove('a1', 'a2');
    });
    expect(status().textContent).toContain("That's not the move. Try again.");
    act(() => {
      vi.advanceTimersByTime(WRONG_SHOW_MS);
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Hint' }));
    });
    expect(status().textContent).toContain('Hint: move the highlighted piece');
    expect((screen.getByRole('button', { name: 'Hint' }) as HTMLButtonElement).disabled).toBe(true);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Show solution' }));
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(status().textContent).toContain('Solution shown. Not solved.');
    expect(screen.getByTestId('puzzle-rating-delta').textContent).toContain('(−80)');
  });

  it('is paused while a game against the engine runs', () => {
    usePlayStore.setState({ mode: 'playing' });
    render(<PuzzlesPanel />);
    expect(
      (screen.getByRole('button', { name: 'Start puzzles' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Puzzles are paused/)).toBeTruthy();
  });

  it('difficulty select updates the store', () => {
    render(<PuzzlesPanel />);
    fireEvent.change(screen.getByLabelText('Difficulty'), { target: { value: 'easier' } });
    expect(usePuzzleStore.getState().difficulty).toBe('easier');
  });
});

describe('statusLine', () => {
  it('covers loading, empty and the solved-with-miss case', () => {
    expect(statusLine({ status: 'loading' })).toBe('Loading a puzzle…');
    expect(statusLine({ status: 'empty', message: 'None.' })).toBe('None.');
    const s = usePuzzleStore.getState();
    expect(
      statusLine({
        status: 'done',
        solver: {
          puzzle: MATE,
          phase: 'complete',
          ply: 2,
          fen: MATE.fen,
          played: [],
          userColor: 'white',
          result: 'failed',
          outcome: 'solved',
          mistakes: 1,
          hints: 0,
        },
        message: s.message,
      }),
    ).toBe('Solved, but counted as a miss.');
  });
});
