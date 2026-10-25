// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMoveDetails } from '../../review/details';
import { gameToBatch, useReviewStore } from '../../review/reviewStore';
import { scholarSummary } from '../../review/testFixtures';
import { setTourTimer, useTourStore } from '../../review/tourStore';
import { useGameStore } from '../../store/gameStore';
import { ReviewTour } from './ReviewTour';

beforeEach(() => {
  setTourTimer({ set: () => 0, clear: () => {} });
  useGameStore.getState().loadPgn('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0');
  const summary = scholarSummary();
  const moveDetails = buildMoveDetails(
    summary,
    gameToBatch(useGameStore.getState()),
    Array.from({ length: 8 }, () => ({})),
  );
  useReviewStore.setState({ status: 'done', summary, moveDetails });
  useTourStore.setState({ status: 'idle', started: new Set() });
});
afterEach(() => {
  cleanup();
  useTourStore.getState().stop();
  setTourTimer(undefined);
});

describe('ReviewTour', () => {
  it('offers a replay, shows progress and text, and the controls work', () => {
    render(<ReviewTour />);
    act(() => screen.getByRole('button', { name: 'Replay tour' }).click());
    expect(screen.getByText('Tour: 0 of 2 highlights')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('');

    act(() => screen.getByRole('button', { name: 'Skip to next highlight' }).click());
    expect(screen.getByText('Tour: 1 of 2 highlights')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/^3\.\.\. Nf6\?\? Blunder/);

    fireEvent.click(screen.getByRole('button', { name: 'Pause tour' }));
    expect(screen.getByTestId('review-tour').getAttribute('data-status')).toBe('paused');
    fireEvent.click(screen.getByRole('button', { name: 'Resume tour' }));
    expect(screen.getByTestId('review-tour').getAttribute('data-status')).toBe('playing');

    fireEvent.click(screen.getByRole('button', { name: 'Stop tour' }));
    expect(screen.getByRole('status').textContent).toBe('Tour stopped.');
    expect(screen.getByRole('button', { name: 'Replay tour' })).toBeTruthy();
  });

  it('shows the finished message', () => {
    render(<ReviewTour />);
    act(() => screen.getByRole('button', { name: 'Replay tour' }).click());
    act(() => {
      for (let i = 0; i < 3; i++) useTourStore.getState().skip();
    });
    expect(screen.getByRole('status').textContent).toContain('Tour finished');
    expect(useGameStore.getState().ply).toBe(7);
  });
});
