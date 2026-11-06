// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureGameLedger } from '../../puzzles/gameLedger';
import { buildMoveDetails } from '../../review/details';
import { gameToBatch, useReviewStore } from '../../review/reviewStore';
import { scholarSummary } from '../../review/testFixtures';
import {
  installReviewTour,
  setEndgameTrainHandler,
  setTourTimer,
  setTourUserSide,
  useTourStore,
} from '../../review/tourStore';
import { usePuzzleStore } from '../../puzzles/puzzleStore';
import type { ReviewedMove, ReviewSummary } from '@daisychess/engine-core';
import { useGameStore } from '../../store/gameStore';
import { usePreviewStore } from '../../store/previewStore';
import { useUiStore } from '../../store/uiStore';
import { mockMatchMedia } from '../../test/matchMedia';
import { ActionBar } from '../PhoneLayout/ActionBar';
import { PHONE_QUERY } from '../PhoneLayout/usePhoneLayout';
import { ReviewTour } from './ReviewTour';

beforeEach(() => {
  configureGameLedger(null);
  setTourTimer({ set: () => 0, clear: () => {} });
  setTourUserSide(async () => 'white');
  useGameStore.getState().loadPgn('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0');
  const summary = scholarSummary();
  const moveDetails = buildMoveDetails(
    summary,
    gameToBatch(useGameStore.getState()),
    Array.from({ length: 8 }, () => ({})),
  );
  useReviewStore.setState({ status: 'done', summary, moveDetails });
  useTourStore.setState({ status: 'idle', started: new Set(), userSide: undefined, card: undefined });
});
afterEach(() => {
  cleanup();
  useTourStore.getState().stop();
  setTourTimer(undefined);
  setTourUserSide(undefined);
});

const tour = () => useTourStore.getState();

async function replay() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Replay tour' }));
    await waitFor(() => expect(tour().status).toBe('playing'));
  });
}

describe('ReviewTour', () => {
  it('offers a replay, shows the stop progress, the stop card and the controls work', async () => {
    render(<ReviewTour />);
    await replay();
    expect(screen.getByText('Tour: Stop 0 of 1')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.getByTestId('review-tour').textContent).toContain('Stops at White’s mistakes');

    fireEvent.click(screen.getByRole('button', { name: 'Pause tour' }));
    expect(screen.getByTestId('review-tour').getAttribute('data-status')).toBe('paused');
    fireEvent.click(screen.getByRole('button', { name: 'Resume tour' }));
    expect(screen.getByTestId('review-tour').getAttribute('data-status')).toBe('playing');

    fireEvent.click(screen.getByRole('button', { name: 'Skip to next stop' }));
    expect(screen.getByText('Tour: Stop 1 of 1')).toBeTruthy();
    expect(screen.getByTestId('review-tour').getAttribute('data-status')).toBe('waiting');
    const stop = screen.getByRole('region', { name: 'Tour stop' });
    expect(stop.tagName).toBe('SECTION');
    const status = within(stop).getByRole('status');
    expect(status.textContent).toContain("Opening: Bishop's Opening (C23)");
    // The family text comes before the automatic sentences.
    const paras = [...status.querySelectorAll('p')].map((p) => p.textContent ?? '');
    expect(paras.length).toBeGreaterThanOrEqual(2);
    expect(paras.findIndex((p) => p.startsWith('Book until'))).toBeGreaterThan(0);
    // Pause does nothing while waiting.
    expect((screen.getByRole('button', { name: 'Pause tour' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    fireEvent.click(screen.getByTestId('tour-next'));
    expect(tour().status).toBe('playing');
    expect(useGameStore.getState().ply).toBe(5);
    expect(screen.queryByRole('region', { name: 'Tour stop' })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Stop tour' }));
    expect(screen.getByRole('status').textContent).toBe('Tour stopped.');
    expect(screen.getByRole('button', { name: 'Replay tour' })).toBeTruthy();
  });

  it('moves the focus to Next on a stop and back to Replay when the tour ends', async () => {
    render(<ReviewTour />);
    await replay();
    act(() => tour().skip());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('tour-next')));
    act(() => screen.getByTestId('tour-next').click());
    act(() => tour().skip()); // no further stop: finishes
    expect(screen.getByRole('status').textContent).toContain('Tour finished');
    expect(useGameStore.getState().ply).toBe(7);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Replay tour' })),
    );
  });

  it('does not take the focus from a text field', async () => {
    const input = document.createElement('input');
    document.body.append(input);
    try {
      render(<ReviewTour />);
      await replay();
      input.focus();
      act(() => tour().skip());
      await new Promise((r) => setTimeout(r, 30));
      expect(document.activeElement).toBe(input);
    } finally {
      input.remove();
    }
  });

  it('a click on the stop card continues', async () => {
    render(<ReviewTour />);
    await replay();
    act(() => tour().skip());
    fireEvent.click(screen.getByRole('region', { name: 'Tour stop' }));
    expect(tour().status).toBe('playing');
    expect(useGameStore.getState().ply).toBe(5);
  });

  it('renders a mistake card: the plain text, or the explanation when there is one', async () => {
    render(<ReviewTour />);
    await replay();
    act(() =>
      useTourStore.setState({
        status: 'waiting',
        card: { kind: 'mistake', ply: 6, text: '3... Nf6?? Blunder: better was g6' },
      }),
    );
    const stop = screen.getByRole('region', { name: 'Tour stop' });
    expect(stop.getAttribute('data-kind')).toBe('mistake');
    expect(within(stop).getByRole('status').textContent).toBe('3... Nf6?? Blunder: better was g6');
    act(() =>
      useTourStore.setState({
        card: {
          kind: 'mistake',
          ply: 6,
          text: 'plain',
          explanation: {
            headline: '3... Nf6?? Blunder (−41%)',
            sentences: ['Nf6 allows mate in 1.'],
            arrows: [],
          },
        },
      }),
    );
    const text = within(screen.getByRole('region', { name: 'Tour stop' })).getByRole('status');
    expect(text.textContent).toBe('3... Nf6?? Blunder (−41%)Nf6 allows mate in 1.');
  });

  it('a click on a control inside the card does not continue; the line steps with buttons and [ ]', async () => {
    render(<ReviewTour />);
    await replay();
    act(() => tour().skip());
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    act(() =>
      useTourStore.setState({
        card: {
          kind: 'mistake',
          ply: 6,
          text: 'plain',
          maia: 'common at 1500',
          explanation: {
            headline: '3... Nf6?? Blunder (−41%)',
            sentences: ['Nf6 allows mate in 1.'],
            line: { fen: START, sans: ['e4', 'e5'], label: 'Best line' },
            arrows: [],
          },
        },
      }),
    );
    const stop = screen.getByRole('region', { name: 'Tour stop' });
    expect(within(stop).getByTestId('tour-maia').textContent).toBe('common at 1500');
    const ply = useGameStore.getState().ply;
    fireEvent.click(within(stop).getByRole('button', { name: 'Next move of the line' }));
    expect(tour().status).toBe('waiting');
    expect(useGameStore.getState().ply).toBe(ply);
    expect(usePreviewStore.getState().lineIndex).toBe(1);
    expect(screen.getByTestId('tour-line-step').textContent).toBe('1/2 e4');
    const uninstall = installReviewTour();
    try {
      fireEvent.keyDown(document, { key: ']' });
      expect(screen.getByTestId('tour-line-step').textContent).toBe('2/2 e5');
      expect(usePreviewStore.getState().lineArrow).toBe('e7e5');
      fireEvent.keyDown(document, { key: '[' });
      expect(usePreviewStore.getState().lineIndex).toBe(1);
      expect(tour().status).toBe('waiting');
      // Continuing ends the preview with the stop.
      fireEvent.click(screen.getByTestId('tour-next'));
      expect(usePreviewStore.getState().fen).toBeNull();
    } finally {
      uninstall();
    }
  });

  it('"Show book move" previews the book alternative one step in', async () => {
    render(<ReviewTour />);
    await replay();
    act(() => tour().skip());
    const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    act(() =>
      useTourStore.setState({
        card: { kind: 'opening', title: 'Opening: X', sentences: ['s'], preview: { fen: START, sans: ['d4'] } },
      }),
    );
    fireEvent.click(screen.getByTestId('tour-book-move'));
    expect(tour().status).toBe('waiting');
    expect(usePreviewStore.getState().lineArrow).toBe('d2d4');
  });

  it("Switch restarts the tour with the other side's stops", async () => {
    render(<ReviewTour />);
    await replay();
    await act(async () => {
      fireEvent.click(screen.getByTestId('tour-side'));
      await waitFor(() => expect(tour().userSide).toBe('black'));
    });
    expect(screen.getByText('Tour: Stop 0 of 2')).toBeTruthy();
    expect(screen.getByTestId('tour-side').getAttribute('aria-label')).toBe(
      "Switch to White's mistakes",
    );
    expect(screen.getByTestId('review-tour').textContent).toContain('Stops at Black’s mistakes');
  });

  it('shows the finished message', async () => {
    render(<ReviewTour />);
    await replay();
    act(() => {
      for (let i = 0; i < 3; i++) tour().skip();
    });
    expect(screen.getByRole('status').textContent).toContain('Tour finished');
    expect(useGameStore.getState().ply).toBe(7);
  });
});

describe('ReviewTour on phones', () => {
  it('leaves Pause · Next · Stop to the action bar: one tour-next in the DOM', async () => {
    const mq = mockMatchMedia(PHONE_QUERY, true);
    try {
      useUiStore.setState({ activeTab: 'review' });
      render(
        <>
          <ActionBar />
          <ReviewTour />
        </>,
      );
      await replay();
      expect(screen.getAllByTestId('tour-next')).toHaveLength(1);
      const bar = screen.getByTestId('action-bar');
      expect(within(bar).getByTestId('tour-next')).toBeTruthy();
      expect(screen.getAllByRole('button', { name: 'Stop tour' })).toHaveLength(1);
      act(() => tour().skip());
      await waitFor(() => expect(document.activeElement).toBe(within(bar).getByTestId('tour-next')));
    } finally {
      mq.restore();
    }
  });
});

describe('ReviewTour endgame stop', () => {
  const START = '6kr/5pp1/8/8/1P3PP1/8/6K1/R7 w - - 0 1';

  /** A rook endgame from a custom start, every move "best", the engine at +4 throughout. */
  function loadEndgame() {
    useGameStore.getState().loadPgn(
      `[SetUp "1"]\n[FEN "${START}"]\n[Result "0-1"]\n\n1. Ra2 Rh5 2. Rb2 Rh3 3. Rb1 Rh5 0-1`,
    );
    const game = useGameStore.getState();
    const moves: ReviewedMove[] = game.moves.map((m, i) => ({
      ply: i + 1,
      san: m.san,
      uci: `${m.from}${m.to}${m.promotion ?? ''}`,
      mover: i % 2 === 0 ? 'white' : 'black',
      evalBefore: { cp: 400 },
      evalAfter: { cp: 400 },
      bestMove: `${m.from}${m.to}`,
      winProbBefore: 50,
      winProbAfter: 50,
      winProbLoss: 0,
      classification: 'best',
    }));
    const counts = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, forced: 0 };
    const summary: ReviewSummary = {
      white: { accuracy: 100, counts },
      black: { accuracy: 100, counts },
      moves,
    };
    const moveDetails = buildMoveDetails(summary, gameToBatch(game), moves.map(() => ({})));
    useReviewStore.setState({ status: 'done', summary, moveDetails });
  }

  afterEach(() => setEndgameTrainHandler(undefined));

  /** The tour waits at its first step here, so it never shows `playing`. */
  async function replayToStop() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Replay tour' }));
      await waitFor(() => expect(tour().status).toBe('waiting'));
    });
  }

  it('stops at the start of the endgame and shows the card; Next continues', async () => {
    loadEndgame();
    render(<ReviewTour />);
    await replayToStop();
    expect(tour().status).toBe('waiting');
    expect(screen.getByText('Tour: Stop 1 of 1')).toBeTruthy();
    const stop = screen.getByRole('region', { name: 'Tour stop' });
    expect(stop.getAttribute('data-kind')).toBe('endgame');
    expect(within(stop).getByText('Endgame: rook endgame')).toBeTruthy();
    expect(within(stop).getByTestId('tour-endgame-signature').textContent).toContain('White: R+3P');
    expect(stop.textContent).toContain('The engine rates it +4.0 for White: winning');
    expect(stop.textContent).toContain('Black won the game nevertheless.');
    // The trainer is not there yet: no "Train this endgame".
    expect(within(stop).queryByTestId('tour-endgame-train')).toBeNull();
    fireEvent.click(screen.getByTestId('tour-next'));
    expect(tour().status).toBe('playing');
    expect(screen.queryByRole('region', { name: 'Tour stop' })).toBeNull();
  });

  it('"Endgame puzzles" opens the puzzles with the family theme; the trainer button needs a handler', async () => {
    const open = vi.fn(async () => {});
    usePuzzleStore.setState({ openWithFilter: open });
    const train = vi.fn();
    loadEndgame();
    render(<ReviewTour />);
    await replayToStop();
    fireEvent.click(screen.getByTestId('tour-endgame-puzzles'));
    expect(open).toHaveBeenCalledWith({ endgame: 'rookEndgame' });
    // a handler is registered later: the button appears on the next render of the card
    setEndgameTrainHandler(train);
    cleanup();
    useTourStore.getState().stop();
    render(<ReviewTour />);
    await replayToStop();
    fireEvent.click(screen.getByTestId('tour-endgame-train'));
    expect(train).toHaveBeenCalledWith('rook_pawn');
  });
});
