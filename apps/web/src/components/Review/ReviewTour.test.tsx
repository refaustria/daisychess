// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureGameLedger } from '../../puzzles/gameLedger';
import { buildMoveDetails } from '../../review/details';
import { gameToBatch, useReviewStore } from '../../review/reviewStore';
import { scholarSummary } from '../../review/testFixtures';
import { setTourTimer, setTourUserSide, useTourStore } from '../../review/tourStore';
import { useGameStore } from '../../store/gameStore';
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
