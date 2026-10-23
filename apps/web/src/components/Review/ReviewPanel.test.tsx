// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReviewStore } from '../../review/reviewStore';
import { scholarSummary } from '../../review/testFixtures';
import { useGameStore } from '../../store/gameStore';
import { ReviewPanel } from './ReviewPanel';

const PGN = '[White "Ann"]\n[Black "Bob"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';
const start = vi.fn(() => Promise.resolve(undefined));
const cancel = vi.fn();
const reset = vi.fn();

beforeEach(() => {
  start.mockClear();
  cancel.mockClear();
  reset.mockClear();
  useGameStore.getState().reset();
  useReviewStore.setState({
    status: 'idle',
    progress: { done: 0, total: 0 },
    summary: undefined,
    error: undefined,
    start,
    cancel,
    reset,
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

  it('done: accuracy, counts, key moment navigation', () => {
    act(() => useGameStore.getState().loadPgn(PGN));
    useReviewStore.setState({ status: 'done', summary: scholarSummary() });
    render(<ReviewPanel />);
    expect(screen.getByTestId('accuracy-white').textContent).toBe('87%');
    expect(screen.getByTestId('accuracy-black').textContent).toBe('62%');
    expect(screen.getByText('Ann')).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export annotated PGN' })).toBeTruthy();
    const moment = screen.getByRole('button', { name: /3\.\.\. Nf6\?\?/ });
    expect(moment.textContent).toContain('best was g6');
    fireEvent.click(moment);
    expect(useGameStore.getState().ply).toBe(6);
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    expect(reset).toHaveBeenCalled();
    expect(start).toHaveBeenCalled();
  });

  it('error: shows message and retries', () => {
    useReviewStore.setState({ status: 'error', error: 'boom' });
    render(<ReviewPanel />);
    expect(screen.getByRole('alert').textContent).toContain('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(start).toHaveBeenCalled();
  });
});
