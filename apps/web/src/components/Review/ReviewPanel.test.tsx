// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayStore } from '../../play/playStore';
import { buildMoveDetails } from '../../review/details';
import { gameToBatch, useReviewStore } from '../../review/reviewStore';
import { scholarSummary } from '../../review/testFixtures';
import { useGameStore } from '../../store/gameStore';
import { ReviewPanel } from './ReviewPanel';

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
    start,
    cancel,
    reset,
    dismissAutoNotice,
  });
});
afterEach(cleanup);

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
});
