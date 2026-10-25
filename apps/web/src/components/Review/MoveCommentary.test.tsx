// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMoveDetails } from '../../review/details';
import { gameToBatch } from '../../review/reviewStore';
import { SCHOLAR_TIMED_PGN, scholarSummary } from '../../review/testFixtures';
import { useGameStore } from '../../store/gameStore';
import { usePreviewStore } from '../../store/previewStore';
import { MoveCommentary } from './MoveCommentary';

const PGN = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

function setup() {
  act(() => {
    useGameStore.getState().loadPgn(PGN);
  });
  const summary = scholarSummary();
  const results = Array.from({ length: 8 }, () => ({}));
  results[5] = { pv: ['g7g6', 'h5f3', 'g8f6'] };
  const details = buildMoveDetails(summary, gameToBatch(useGameStore.getState()), results);
  render(<MoveCommentary summary={summary} details={details} />);
}

const card = () => screen.getByTestId('move-card');

beforeEach(() => usePreviewStore.getState().clear());
afterEach(cleanup);

describe('MoveCommentary', () => {
  it('is a polite live region following the ply', () => {
    setup();
    expect(card().querySelector('[aria-live="polite"]')).toBeTruthy();
    act(() => useGameStore.getState().goTo(0));
    expect(card().textContent).toContain('Start position');
    act(() => useGameStore.getState().goTo(1));
    expect(screen.getByTestId('move-card-played').textContent).toBe('1. e4✓');
    expect(card().textContent).toContain('Best');
    expect(screen.getByTestId('move-card-text').textContent).toBe(
      "Good move. Matches the engine's first choice.",
    );
    expect(screen.queryByTestId('move-card-better')).toBeNull();
  });

  it('blunder: class with loss, better move, line preview, explanation', () => {
    setup();
    act(() => useGameStore.getState().goTo(6));
    expect(screen.getByTestId('move-card-played').textContent).toBe('3... Nf6??');
    expect(card().textContent).toMatch(/Blunder \(−\d+%\)/);
    expect(screen.getByTestId('move-card-better').textContent).toContain('Better: 3... g6');
    expect(card().textContent).toContain('Eval +0.20 → M1 (allows mate in 1 for Black)');
    expect(screen.getByTestId('move-card-text').textContent).toBe(
      'Allows a forced mate. The engine prefers 3... g6, keeping the evaluation at +0.20.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: /Preview best line 3\.\.\. g6 4\. Qf3 Nf6/ }),
    );
    expect(usePreviewStore.getState().moves).toEqual(['g6', 'Qf3', 'Nf6']);
    expect(usePreviewStore.getState().fen).toMatch(/^r1bqkb1r\/pppp1p1p\/2n2np1\//);
  });

  it('inaccuracy and checkmate templates', () => {
    setup();
    act(() => useGameStore.getState().goTo(5));
    expect(card().textContent).toMatch(/Inaccuracy \(−\d+%\)/);
    expect(screen.getByTestId('move-card-text').textContent).toMatch(
      /^Loses \d+% winning chances\. The engine prefers 3\. Nf3/,
    );
    act(() => useGameStore.getState().goTo(7));
    expect(screen.getByTestId('move-card-text').textContent).toBe('Checkmate.');
  });

  it('prev/next jump between mistakes and blunders', () => {
    setup();
    act(() => useGameStore.getState().goTo(0));
    const prev = screen.getByRole('button', { name: 'Previous mistake' }) as HTMLButtonElement;
    const next = screen.getByRole('button', { name: 'Next mistake' }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    fireEvent.click(next);
    expect(useGameStore.getState().ply).toBe(6);
    expect(next.disabled).toBe(true);
    act(() => useGameStore.getState().goTo(7));
    fireEvent.click(prev);
    expect(useGameStore.getState().ply).toBe(6);
  });

  it('flags moves that are not part of the reviewed game', () => {
    setup();
    act(() => useGameStore.getState().goTo(5));
    act(() => {
      useGameStore.getState().makeMove('g7', 'g6');
    });
    expect(card().textContent).toContain('not part of the reviewed game');
    act(() => {
      useGameStore.getState().makeMove('h5', 'g6');
    });
    expect(card().textContent).toContain('not part of the reviewed game');
  });
});

describe('MoveCommentary with clock data (M22-1)', () => {
  function setupTimed() {
    act(() => {
      useGameStore.getState().loadPgn(SCHOLAR_TIMED_PGN);
    });
    const summary = scholarSummary();
    const details = buildMoveDetails(summary, gameToBatch(useGameStore.getState()), []);
    render(<MoveCommentary summary={summary} details={details} />);
  }

  it('shows the time used and left, and flags the blunder in time trouble', () => {
    setupTimed();
    act(() => useGameStore.getState().goTo(6));
    expect(screen.getByTestId('move-card-time').textContent).toBe(
      'Used 0:35 (88% of remaining) · 0:05 left',
    );
    expect(screen.getByTestId('time-trouble-badge').textContent).toBe('time trouble');
    // The inaccuracy at ply 5 (50 s left) is neither a mistake nor in time trouble.
    act(() => useGameStore.getState().goTo(5));
    expect(screen.getByTestId('move-card-time').textContent).toBe(
      'Used 0:08 (14% of remaining) · 0:50 left',
    );
    expect(screen.queryByTestId('time-trouble-badge')).toBeNull();
  });

  it('shows no time line without clock data', () => {
    setup();
    act(() => useGameStore.getState().goTo(6));
    expect(screen.queryByTestId('move-card-time')).toBeNull();
    expect(screen.queryByTestId('time-trouble-badge')).toBeNull();
  });
});
