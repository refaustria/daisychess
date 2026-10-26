// @vitest-environment jsdom
import type { ReviewSummary } from '@daisychess/engine-core';
import type { Puzzle } from '@daisychess/puzzles';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAnalysisPause } from '../../engine/analysisPause';
import type { LiveGame } from '../../live/LiveGameController';
import { useLiveStore } from '../../live/liveStore';
import { useResignConfirm } from '../../live/resignConfirm';
import { usePlayStore } from '../../play/playStore';
import { resetMistakeSession, useMistakeSession } from '../../puzzles/mistakeSession';
import {
  INTRO_DELAY_MS,
  resetPuzzleStore,
  usePuzzleStore,
  type PuzzlePort,
} from '../../puzzles/puzzleStore';
import { useRushStore } from '../../puzzles/rushStore';
import { useReviewStore } from '../../review/reviewStore';
import { useAnalysisStore } from '../../store/analysisStore';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { useDrillStore } from '../../trainer/drillStore';
import { ActionBar, barKind, type BarInput } from './ActionBar';

const MATE: Puzzle = {
  id: 'mate2',
  fen: '6k1/5ppp/8/4n3/8/8/8/RR4K1 b - - 0 1',
  moves: ['e5c4', 'a1a8'],
  rating: 1500,
  rd: 80,
  themes: ['mateIn1'],
  openings: [],
  source: 'lichess',
};

function port(): PuzzlePort {
  const queue = [MATE, { ...MATE, id: 'mate2b' }];
  let rating = { rating: 1500, rd: 350, vol: 0.09, n: 0 };
  return {
    nextPuzzle: () => Promise.resolve(queue.shift() ?? null),
    load: () => ({ rating, difficulty: 'normal', filter: {} }),
    settle: () => (rating = { ...rating, n: rating.n + 1 }),
    saveDifficulty: () => undefined,
    saveFilter: () => undefined,
    markSeen: () => undefined,
  };
}

const BASE: BarInput = {
  tab: 'moves',
  puzzleMode: 'puzzles',
  rushRunning: false,
  mistakeSession: false,
  hasReview: false,
  drillShown: false,
  playMode: 'idle',
  liveGame: 'none',
};

const originalSetEnabled = useAnalysisStore.getState().setEnabled;
const play0 = usePlayStore.getState();
const drill0 = useDrillStore.getState();
const rush0 = useRushStore.getState();
const live0 = useLiveStore.getState();

beforeEach(() => {
  resetAnalysisPause();
  useAnalysisStore.setState({
    enabled: false,
    setEnabled: (enabled: boolean) => useAnalysisStore.setState({ enabled }),
  });
  useGameStore.getState().reset();
  useUiStore.setState({ activeTab: 'moves', puzzleMode: 'puzzles' });
  resetPuzzleStore(port());
  resetMistakeSession();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAnalysisStore.setState({ setEnabled: originalSetEnabled });
  usePlayStore.setState(play0, true);
  useDrillStore.setState(drill0, true);
  useRushStore.setState(rush0, true);
  useLiveStore.setState(live0, true);
  useReviewStore.setState({ summary: undefined, status: 'idle' });
  useResignConfirm.setState({ open: false });
  resetPuzzleStore(port());
});

const bar = () => screen.getByTestId('action-bar');
const btn = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('barKind', () => {
  it('follows the active tab and its mode', () => {
    expect(barKind(BASE)).toBe('analysis');
    expect(barKind({ ...BASE, tab: 'puzzles' })).toBe('puzzles');
    expect(barKind({ ...BASE, tab: 'puzzles', puzzleMode: 'rush' })).toBe('analysis');
    expect(barKind({ ...BASE, tab: 'puzzles', puzzleMode: 'rush', rushRunning: true })).toBe(
      'rush',
    );
    expect(barKind({ ...BASE, tab: 'puzzles', puzzleMode: 'mistakes' })).toBe('analysis');
    expect(barKind({ ...BASE, tab: 'puzzles', puzzleMode: 'mistakes', mistakeSession: true })).toBe(
      'mistakes',
    );
    expect(barKind({ ...BASE, tab: 'review' })).toBe('analysis');
    expect(barKind({ ...BASE, tab: 'review', hasReview: true })).toBe('review');
    expect(barKind({ ...BASE, tab: 'openings', drillShown: true })).toBe('drill');
    expect(barKind({ ...BASE, tab: 'openings' })).toBe('analysis');
    expect(barKind({ ...BASE, tab: 'play' })).toBe('analysis');
    expect(barKind({ ...BASE, tab: 'play', playMode: 'finished' })).toBe('play');
    expect(barKind({ ...BASE, tab: 'live', liveGame: 'finished' })).toBe('live');
    expect(barKind({ ...BASE, tab: 'live' })).toBe('analysis');
  });

  it('a running game drives the bar of the plain tabs', () => {
    expect(barKind({ ...BASE, playMode: 'playing' })).toBe('play');
    expect(barKind({ ...BASE, tab: 'settings', liveGame: 'playing' })).toBe('live');
    // A finished engine game leaves the Analysis tab to the analysis controls.
    expect(barKind({ ...BASE, playMode: 'finished' })).toBe('analysis');
    // The tab's own mode wins over the running game.
    expect(barKind({ ...BASE, tab: 'review', hasReview: true, playMode: 'playing' })).toBe(
      'review',
    );
  });
});

describe('ActionBar', () => {
  it('analysis: steps through the game and toggles the engine', () => {
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
      useGameStore.getState().makeMove('e7', 'e5');
    });
    render(<ActionBar />);
    expect(bar().getAttribute('data-kind')).toBe('analysis');
    expect(bar().getAttribute('role')).toBe('toolbar');
    expect(btn('Next move').disabled).toBe(true);
    fireEvent.click(btn('Previous move'));
    expect(useGameStore.getState().ply).toBe(1);
    fireEvent.click(btn('First move'));
    expect(useGameStore.getState().ply).toBe(0);
    fireEvent.click(btn('Last move'));
    expect(useGameStore.getState().ply).toBe(2);
    const engine = btn('Engine');
    expect(engine.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(engine);
    expect(useAnalysisStore.getState().enabled).toBe(true);
    expect(btn('Engine').getAttribute('aria-pressed')).toBe('true');
  });

  it('puzzles: Start, Hint, Solution, then Analyse and Next', async () => {
    vi.useFakeTimers();
    useUiStore.setState({ activeTab: 'puzzles' });
    render(<ActionBar />);
    expect(bar().getAttribute('data-kind')).toBe('puzzles');
    expect(screen.queryByRole('button', { name: 'Hint' })).toBeNull();
    await act(async () => {
      fireEvent.click(btn('Start puzzles'));
    });
    act(() => {
      vi.advanceTimersByTime(INTRO_DELAY_MS);
    });
    expect(usePuzzleStore.getState().solver?.phase).toBe('user');
    expect(btn('Next puzzle').textContent).toBe('Next');
    act(() => {
      fireEvent.click(btn('Hint'));
    });
    expect(usePuzzleStore.getState().solver?.hint).toBeTruthy();
    expect(btn('Hint').disabled).toBe(true);
    act(() => {
      fireEvent.click(btn('Show solution'));
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(usePuzzleStore.getState().solver?.phase).toBe('complete');
    expect(btn('Analyse')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Hint' })).toBeNull();
    await act(async () => {
      fireEvent.click(btn('Next puzzle'));
    });
    expect(usePuzzleStore.getState().solver?.puzzle.id).toBe('mate2b');
  });

  it('rush: time, score, strikes and End run', () => {
    const end = vi.fn();
    useUiStore.setState({ activeTab: 'puzzles', puzzleMode: 'rush' });
    useRushStore.setState({ status: 'running', remainingMs: 61_000, score: 4, strikes: 1, end });
    render(<ActionBar />);
    expect(bar().getAttribute('data-kind')).toBe('rush');
    expect(screen.getByRole('timer').getAttribute('aria-label')).toBe('Time left 1:01');
    expect(screen.getByTestId('bar-rush-score').textContent).toBe('Score 4');
    expect(screen.getByLabelText('1 of 3 strikes')).toBeTruthy();
    fireEvent.click(btn('End run'));
    expect(end).toHaveBeenCalled();
  });

  it('your mistakes: Next due ends an empty session with a note; End training', () => {
    useUiStore.setState({ activeTab: 'puzzles', puzzleMode: 'mistakes' });
    useMistakeSession.setState({ active: true, queue: [], index: 1, total: 1 });
    usePuzzleStore.setState({ status: 'done' });
    render(<ActionBar />);
    expect(bar().getAttribute('data-kind')).toBe('mistakes');
    expect(btn('Hint').disabled).toBe(true);
    fireEvent.click(btn('Next due'));
    expect(useMistakeSession.getState()).toMatchObject({
      active: false,
      note: 'No more due puzzles. Well done.',
    });
    expect(bar().getAttribute('data-kind')).toBe('analysis');
    act(() => useMistakeSession.setState({ active: true }));
    fireEvent.click(btn('End training'));
    expect(useMistakeSession.getState().active).toBe(false);
  });

  it('review: ◀ ▶ and Next mistake', () => {
    act(() => {
      for (const [f, t] of [
        ['e2', 'e4'],
        ['e7', 'e5'],
        ['f1', 'c4'],
        ['b8', 'c6'],
      ] as const)
        useGameStore.getState().makeMove(f, t);
      useGameStore.getState().goTo(0);
    });
    useUiStore.setState({ activeTab: 'review' });
    useReviewStore.setState({
      status: 'done',
      // Only the fields findJump reads.
      summary: {
        moves: [
          { ply: 2, classification: 'mistake' },
          { ply: 4, classification: 'blunder' },
        ],
      } as unknown as ReviewSummary,
    });
    render(<ActionBar />);
    expect(bar().getAttribute('data-kind')).toBe('review');
    fireEvent.click(btn('Next mistake'));
    expect(useGameStore.getState().ply).toBe(2);
    fireEvent.click(btn('Next mistake'));
    expect(useGameStore.getState().ply).toBe(4);
    expect(btn('Next mistake').disabled).toBe(true);
    fireEvent.click(btn('Previous move'));
    expect(useGameStore.getState().ply).toBe(3);
  });

  it('play: Take back, Resign, Stop while playing; Rematch, Review, New setup after', () => {
    const takeBack = vi.fn();
    const resign = vi.fn();
    const stop = vi.fn();
    const rematch = vi.fn();
    useUiStore.setState({ activeTab: 'play' });
    usePlayStore.setState({
      mode: 'playing',
      thinking: false,
      playerColor: 'white',
      fromPly: 0,
      takeBack,
      resign,
      stop,
      rematch,
    });
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
      useGameStore.getState().makeMove('e7', 'e5');
    });
    render(<ActionBar />);
    expect(bar().getAttribute('data-kind')).toBe('play');
    fireEvent.click(btn('Take back'));
    fireEvent.click(btn('Resign'));
    fireEvent.click(btn('Stop'));
    expect([takeBack, resign, stop].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    act(() => usePlayStore.setState({ thinking: true }));
    expect(btn('Take back').disabled).toBe(true);

    act(() => usePlayStore.setState({ mode: 'finished' }));
    fireEvent.click(btn('Rematch'));
    expect(rematch).toHaveBeenCalled();
    expect(btn('Review this game').textContent).toBe('Review');
    fireEvent.click(btn('New setup'));
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('live: Offer draw, Resign with confirmation shared with the panel, result actions', () => {
    const resign = vi.fn(() => Promise.resolve());
    const offerDraw = vi.fn(() => Promise.resolve());
    const leave = vi.fn();
    const game = { id: 'g1', moves: ['e2e4', 'e7e5', 'g1f3'], color: 'white' } as LiveGame;
    useUiStore.setState({ activeTab: 'live' });
    useLiveStore.setState({ status: 'playing', game, resign, offerDraw, leave });
    render(<ActionBar />);
    expect(bar().getAttribute('data-kind')).toBe('live');
    fireEvent.click(btn('Offer draw'));
    expect(offerDraw).toHaveBeenCalled();
    fireEvent.click(btn('Resign'));
    expect(useResignConfirm.getState().open).toBe(true);
    fireEvent.click(btn('No'));
    expect(useResignConfirm.getState().open).toBe(false);
    fireEvent.click(btn('Resign'));
    fireEvent.click(btn('Yes, resign'));
    expect(resign).toHaveBeenCalled();

    act(() => useLiveStore.setState({ game: { ...game, drawOffer: 'mine' } }));
    expect(btn('Draw offered').disabled).toBe(true);

    act(() => useLiveStore.setState({ status: 'finished' }));
    fireEvent.click(btn('New game'));
    expect(leave).toHaveBeenCalled();
    fireEvent.click(btn('Review this game'));
    expect(useUiStore.getState().activeTab).toBe('review');
  });

  it('drill: Try again / Stop drill while running; Repeat, Next variation, Play on when done', () => {
    const retry = vi.fn();
    const stop = vi.fn();
    const repeat = vi.fn();
    const next = vi.fn();
    const playOn = vi.fn();
    useUiStore.setState({ activeTab: 'openings' });
    useDrillStore.setState({
      status: 'running',
      phase: 'retry',
      retry,
      stop,
      repeat,
      next,
      playOn,
    });
    render(<ActionBar />);
    expect(bar().getAttribute('data-kind')).toBe('drill');
    fireEvent.click(btn('Try again'));
    fireEvent.click(btn('Stop drill'));
    expect(retry).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
    act(() =>
      useDrillStore.setState({
        status: 'done',
        phase: 'none',
        summary: { reason: 'end', firstTry: 1, userMoves: 1, mistakes: 0 } as never,
      }),
    );
    fireEvent.click(btn('Repeat'));
    fireEvent.click(btn('Next variation'));
    fireEvent.click(btn('Play on vs engine'));
    expect([repeat, next, playOn].every((f) => f.mock.calls.length === 1)).toBe(true);
  });
});
