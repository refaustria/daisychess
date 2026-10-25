// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveStore } from '../../live/liveStore';
import { loadOpenings } from '../../openings';
import { usePlayStore } from '../../play/playStore';
import { buildMoveDetails } from '../../review/details';
import { gameToBatch, useReviewStore } from '../../review/reviewStore';
import { SCHOLAR_TIMED_PGN, scholarSummary } from '../../review/testFixtures';
import { useGameStore } from '../../store/gameStore';
import { OpeningFocusView } from './OpeningFocusBlock';
import { ReviewPanel, reviewingLabel } from './ReviewPanel';

const PGN = '[White "Ann"]\n[Black "Bob"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';
const start = vi.fn(() => Promise.resolve(undefined));
const cancel = vi.fn();
const reset = vi.fn();
const dismissAutoNotice = vi.fn();

beforeEach(() => {
  start.mockClear();
  cancel.mockClear();
  reset.mockClear();
  dismissAutoNotice.mockClear();
  useGameStore.getState().reset();
  useReviewStore.setState({
    status: 'idle',
    progress: { done: 0, total: 0 },
    summary: undefined,
    moveDetails: {},
    error: undefined,
    autoNotice: false,
    runsOn: undefined,
    engineNotice: undefined,
    start,
    cancel,
    reset,
    dismissAutoNotice,
  });
});
afterEach(cleanup);
beforeAll(loadOpenings);

describe('ReviewPanel', () => {
  it('idle: Start is disabled without moves', () => {
    render(<ReviewPanel />);
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('idle: Start is disabled with a hint while playing against the engine', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    act(() => usePlayStore.setState({ mode: 'playing' }));
    render(<ReviewPanel />);
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('Finish or stop the game first')).toBeTruthy();
    act(() => usePlayStore.setState({ mode: 'idle' }));
  });

  it('Start and Run Deep are disabled during a live lichess game (fair play)', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    act(() => useLiveStore.setState({ status: 'playing' }));
    useReviewStore.setState({ autoNotice: true });
    render(<ReviewPanel />);
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByRole('button', { name: 'Run Deep' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      screen.getByText('Review is disabled during a live game (lichess fair play)'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(start).not.toHaveBeenCalled();
    act(() => useLiveStore.setState({ status: 'idle' }));
  });

  it('idle: Start uses the chosen preset', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    render(<ReviewPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(start).toHaveBeenLastCalledWith({ depth: 18 });
    fireEvent.click(screen.getByRole('radio', { name: 'Fast (0.3 s/move)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(start).toHaveBeenLastCalledWith({ movetime: 300 });
  });

  it('running: shows progress and cancels', () => {
    useReviewStore.setState({ status: 'running', progress: { done: 2, total: 8 } });
    render(<ReviewPanel />);
    expect(screen.getByText('2/8 (25%)')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(cancel).toHaveBeenCalled();
  });

  it('running: shows where the review runs', () => {
    useReviewStore.setState({
      status: 'running',
      progress: { done: 1, total: 8 },
      runsOn: { kind: 'server', name: 'Stockfish 19', threads: 8 },
    });
    render(<ReviewPanel />);
    expect(screen.getByTestId('review-engine').textContent).toBe(
      'Reviewing on server (Stockfish 19, 8 threads)… live analysis is paused.',
    );
    act(() => useReviewStore.setState({ runsOn: { kind: 'browser' } }));
    expect(screen.getByTestId('review-engine').textContent).toBe(
      'Reviewing in browser… live analysis is paused.',
    );
    expect(screen.queryByTestId('review-engine-notice')).toBeNull();
  });

  it('fallback notice is shown in one line while running and after the review', () => {
    const notice = 'Server unavailable (Access token required or wrong) — reviewing in the browser';
    useGameStore.getState().loadPgn(PGN);
    useReviewStore.setState({
      status: 'running',
      progress: { done: 1, total: 8 },
      runsOn: { kind: 'browser' },
      engineNotice: notice,
    });
    render(<ReviewPanel />);
    expect(screen.getByTestId('review-engine-notice').textContent).toBe(notice);
    act(() =>
      useReviewStore.setState({
        status: 'done',
        summary: scholarSummary(),
        progress: { done: 8, total: 8 },
      }),
    );
    expect(screen.getByTestId('review-engine-notice').textContent).toBe(notice);
    expect(screen.getByTestId('review-engine').textContent).toBe('Reviewed in browser.');
    act(() => useReviewStore.setState({ status: 'idle' }));
    expect(screen.queryByTestId('review-engine-notice')).toBeNull();
  });

  it('reviewingLabel', () => {
    expect(reviewingLabel(undefined)).toBe('Reviewing…');
    expect(reviewingLabel({ kind: 'server', threads: 1 })).toBe('Reviewing on server (1 thread)…');
    expect(reviewingLabel({ kind: 'server' }, true)).toBe('Reviewed on server.');
  });

  it('done: accuracy, counts, highlights per side and navigation', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    const summary = scholarSummary();
    const moveDetails = buildMoveDetails(summary, gameToBatch(useGameStore.getState()), []);
    useReviewStore.setState({ status: 'done', summary, moveDetails });
    render(<ReviewPanel />);
    expect(screen.getByTestId('review-panel').dataset.status).toBe('done');
    expect(screen.getByTestId('accuracy-white').textContent).toBe('87%');
    expect(screen.getByTestId('accuracy-black').textContent).toBe('62%');
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export annotated PGN' })).toBeTruthy();

    const white = screen.getByRole('region', { name: 'White highlights' });
    const black = screen.getByRole('region', { name: 'Black highlights' });
    expect(white.textContent).toContain('Ann');
    expect(black.textContent).toContain('Bob');
    // White: Qh5 is the only inaccuracy; best/excellent moves are listed as good moves.
    expect(white.textContent).toContain('3. Qh5?!');
    expect(white.textContent).toContain('1. e4✓');
    const moment = screen.getByRole('button', { name: /3\.\.\. Nf6\?\?/ });
    expect(moment.textContent).toContain('best was g6');
    expect(black.contains(moment)).toBe(true);
    fireEvent.click(moment);
    expect(useGameStore.getState().ply).toBe(6);
    // The current-move card follows the ply.
    expect(screen.getByTestId('move-card-played').textContent).toBe('3... Nf6??');

    // A manual start replaces the finished review with the chosen preset.
    fireEvent.click(screen.getByRole('radio', { name: 'Fast (0.3 s/move)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(reset).toHaveBeenCalled();
    expect(start).toHaveBeenLastCalledWith({ movetime: 300 });
  });

  it('running with a partial summary shows the card and lets a manual start restart', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    const summary = scholarSummary();
    summary.moves = summary.moves.slice(0, 3);
    const moveDetails = buildMoveDetails(summary, gameToBatch(useGameStore.getState()), []);
    useReviewStore.setState({
      status: 'running',
      progress: { done: 4, total: 8 },
      summary,
      moveDetails,
    });
    act(() => useGameStore.getState().goTo(2));
    render(<ReviewPanel />);
    expect(screen.getByTestId('move-card-played').textContent).toBe('1... e5✓');
    act(() => useGameStore.getState().goTo(5));
    expect(screen.getByTestId('move-card').textContent).toContain('not been analysed yet');
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(reset).toHaveBeenCalled();
    expect(start).toHaveBeenLastCalledWith({ depth: 18 });
  });

  it('auto notice: Run Deep restarts with depth 18, × dismisses', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    useReviewStore.setState({
      status: 'running',
      progress: { done: 1, total: 8 },
      autoNotice: true,
    });
    render(<ReviewPanel />);
    expect(screen.getByTestId('auto-notice').textContent).toContain(
      'Auto review (fast) — run Deep for more accuracy',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run Deep' }));
    expect(reset).toHaveBeenCalled();
    expect(start).toHaveBeenLastCalledWith({ depth: 18 });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss auto review notice' }));
    expect(dismissAutoNotice).toHaveBeenCalled();
  });

  it('error: shows message and retries', () => {
    useReviewStore.setState({ status: 'error', error: 'boom' });
    render(<ReviewPanel />);
    expect(screen.getByRole('alert').textContent).toContain('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(start).toHaveBeenCalled();
  });

  it('error of an auto review: the engine failure with the hint, no "run Deep" notice', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    const error =
      'the browser engine could not start (wasm-simd is not enabled). Set the server access token to review on the server.';
    useReviewStore.setState({
      status: 'error',
      error,
      autoNotice: true,
      trigger: 'auto',
      progress: { done: 0, total: 8 },
    });
    render(<ReviewPanel />);
    expect(screen.getByTestId('review-panel').getAttribute('data-status')).toBe('error');
    expect(screen.getByRole('alert').textContent).toBe(`Review failed: ${error}`);
    expect(screen.queryByTestId('auto-notice')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(start).toHaveBeenCalledWith({ depth: 18 });
  });

  it('error without a message still says the review failed', () => {
    useReviewStore.setState({ status: 'error', error: undefined });
    render(<ReviewPanel />);
    expect(screen.getByRole('alert').textContent).toBe('Review failed: unknown error');
  });

  it('done: the Opening block names the opening and where the book was left', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    const summary = scholarSummary();
    const moveDetails = buildMoveDetails(summary, gameToBatch(useGameStore.getState()), []);
    useReviewStore.setState({ status: 'done', summary, moveDetails });
    render(<ReviewPanel />);
    const block = screen.getByRole('region', { name: 'Opening' });
    // 1. e4 e5 2. Bc4 Nc6 is book (Bishop's Opening); 3. Qh5 is not (eval 0.30 → 0.20 for White).
    expect(block.textContent).toBe(
      "OpeningBishop's Opening (C23) · book until move 2 (…Nc6) · White left the book with " +
        "3. Qh5 (book: Nc3 (King's Gambit Declined: Classical, Svenonius Variation)) · " +
        'eval −0.1 for White',
    );
    act(() => useGameStore.getState().goTo(0));
    fireEvent.click(screen.getByTestId('opening-focus-leave'));
    expect(useGameStore.getState().ply).toBe(5);
    // The move card at the leave ply says so.
    expect(screen.getByTestId('move-card-book').textContent).toBe(
      "Left the book here; book moves: Nc3 (King's Gambit Declined: Classical, Svenonius Variation).",
    );
    act(() => useGameStore.getState().goTo(4));
    expect(screen.queryByTestId('move-card-book')).toBeNull();
  });

  it('done: the Opening block for a game that stayed in book or had no book moves', () => {
    act(() => useGameStore.getState().loadPgn('1. e4 e5 2. Nf3 Nc6'));
    useReviewStore.setState({ status: 'done', summary: scholarSummary(), moveDetails: {} });
    const { unmount } = render(<ReviewPanel />);
    expect(screen.getByRole('region', { name: 'Opening' }).textContent).toMatch(
      /· book until move 2 \(…Nc6\) · the whole game stayed in book$/,
    );
    unmount();
    // Every first move of the table is book, so "no book moves" is shown with a crafted focus.
    render(
      <OpeningFocusView
        focus={{ lastBookPly: 0, leftBy: 'white', leavePly: 1, bookMoveInstead: [{ san: 'e4' }] }}
      />,
    );
    expect(screen.getByRole('region', { name: 'Opening' }).textContent).toBe(
      'OpeningNo book moves · White left the book with 1. e4 (book: e4)',
    );
  });

  it('no Opening block for a custom start position', () => {
    act(() =>
      useGameStore.getState().loadPgn('[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]\n\n1. e4 Kd7'),
    );
    useReviewStore.setState({ status: 'done', summary: scholarSummary(), moveDetails: {} });
    render(<ReviewPanel />);
    expect(screen.queryByRole('region', { name: 'Opening' })).toBeNull();
  });

  it('done with clock data: time graph, per-player time summary, badge in the mistakes list', () => {
    act(() => useGameStore.getState().loadPgn(SCHOLAR_TIMED_PGN));
    const summary = scholarSummary();
    const moveDetails = buildMoveDetails(summary, gameToBatch(useGameStore.getState()), []);
    useReviewStore.setState({ status: 'done', summary, moveDetails });
    render(<ReviewPanel />);
    expect(screen.getByTestId('time-graph').getAttribute('aria-label')).toBe(
      'Clock graph over 7 moves: White ends with 0:49, Black with 0:05 remaining.',
    );
    // White: 0 + 2 + 8 + 1 s over 4 moves; Black: 0 + 20 + 35 s over 3 moves.
    expect(screen.getByTestId('time-avg-white').textContent).toBe('0:02.7');
    expect(screen.getByTestId('time-avg-black').textContent).toBe('0:18');
    expect(screen.getByTestId('time-trouble-white').textContent).toBe('0');
    expect(screen.getByTestId('time-trouble-black').textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: /Longest think of Black: 0:35 on 3\.\.\. Nf6/ }));
    expect(useGameStore.getState().ply).toBe(6);
    const black = screen.getByRole('region', { name: 'Black highlights' });
    expect(black.querySelector('[data-testid="time-trouble-badge"]')).toBeTruthy();
    const white = screen.getByRole('region', { name: 'White highlights' });
    expect(white.querySelector('[data-testid="time-trouble-badge"]')).toBeNull();
    // The commentary at the blunder shows the badge as well.
    expect(screen.getByTestId('move-card').textContent).toContain('time trouble');
  });

  it('done without clock data: no time graph or time summary', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    useReviewStore.setState({ status: 'done', summary: scholarSummary(), moveDetails: {} });
    render(<ReviewPanel />);
    expect(screen.queryByTestId('time-graph')).toBeNull();
    expect(screen.queryByTestId('time-summary')).toBeNull();
  });
});
