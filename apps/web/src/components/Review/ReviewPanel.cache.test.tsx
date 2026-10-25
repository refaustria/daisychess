// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadOpenings } from '../../openings';
import { buildMoveDetails } from '../../review/details';
import { gameToBatch, useReviewStore } from '../../review/reviewStore';
import { scholarSummary } from '../../review/testFixtures';
import { useGameStore } from '../../store/gameStore';
import { ReviewPanel } from './ReviewPanel';

const PGN = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';
const start = vi.fn(() => Promise.resolve(undefined));
const reset = vi.fn();
const startButton = () => screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;

function showStored(preset: 'fast' | 'deep', fromCache: boolean): void {
  const summary = scholarSummary();
  const g = useGameStore.getState();
  useReviewStore.setState({
    status: 'done',
    progress: { done: 8, total: 8 },
    summary,
    moveDetails: buildMoveDetails(summary, gameToBatch(g), []),
    runsOn: { kind: 'server', name: 'Stockfish 19', threads: 8 },
    reviewed: g.moves,
    stored: {
      preset,
      createdAt: new Date(new Date().getFullYear(), 9, 25, 10).getTime(),
      engine: { kind: 'server', name: 'Stockfish 19', threads: 8 },
      fromCache,
      source: 'local',
    },
  });
}

beforeEach(() => {
  start.mockClear();
  reset.mockClear();
  useGameStore.getState().reset();
  act(() => useGameStore.getState().loadPgn(PGN));
  useReviewStore.setState({
    status: 'idle',
    summary: undefined,
    moveDetails: {},
    autoNotice: false,
    engineNotice: undefined,
    stored: undefined,
    reviewed: undefined,
    start,
    reset,
  });
});
afterEach(cleanup);
beforeAll(loadOpenings);

describe('ReviewPanel: review cache (ADR-016)', () => {
  it('a review loaded from the cache shows the cache label; Start is disabled for deep and fast', () => {
    showStored('deep', true);
    render(<ReviewPanel />);
    expect(screen.getByText('Loaded from cache (reviewed 25 Oct, deep, server)')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(startButton().disabled).toBe(true);
    expect(screen.getByTestId('review-already').textContent).toBe('Already reviewed (deep)');
    fireEvent.click(screen.getByRole('radio', { name: /Fast/ }));
    expect(startButton().disabled).toBe(true);
  });

  it('a stored Fast review: Deep can still be started, Fast cannot', () => {
    showStored('fast', false);
    render(<ReviewPanel />);
    // Just finished (not from the cache): the usual engine line.
    expect(screen.getByText('Reviewed on server (Stockfish 19, 8 threads).')).toBeTruthy();
    expect(startButton().disabled).toBe(false); // Deep is preselected
    fireEvent.click(startButton());
    expect(reset).toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith({ depth: 18 });
    fireEvent.click(screen.getByRole('radio', { name: /Fast/ }));
    expect(startButton().disabled).toBe(true);
    expect(screen.getByTestId('review-already').textContent).toBe('Already reviewed (fast)');
  });

  it('the stored review of another game does not disable Start', () => {
    showStored('deep', true);
    act(() => useGameStore.getState().loadPgn('1. d4 d5 2. c4'));
    render(<ReviewPanel />);
    expect(startButton().disabled).toBe(false);
    expect(screen.queryByTestId('review-already')).toBeNull();
  });
});
