// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MoveList } from './MoveList';
import { useGameStore } from '../../store/gameStore';

afterEach(cleanup);
beforeEach(() => useGameStore.getState().reset());

const play = (...m: [string, string][]) =>
  act(() => {
    for (const [f, t] of m) useGameStore.getState().makeMove(f, t);
  });

describe('MoveList', () => {
  it('renders numbered pairs and highlights the current ply', () => {
    render(<MoveList />);
    play(['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']);
    expect(screen.getByText('1.')).toBeTruthy();
    expect(screen.getByText('2.')).toBeTruthy();
    expect(screen.getByRole('button', { name: '1. e4' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1... e5' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '2. Nf3' }).getAttribute('aria-current')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: '1. e4' }).getAttribute('aria-current')).toBeNull();
  });

  it('click calls goTo', () => {
    render(<MoveList />);
    play(['e2', 'e4'], ['e7', 'e5']);
    fireEvent.click(screen.getByRole('button', { name: '1. e4' }));
    expect(useGameStore.getState().ply).toBe(1);
  });

  it('shows players and result at the end of a finished game', () => {
    act(() => {
      useGameStore
        .getState()
        .loadPgn('[White "Ann"]\n[Black "Bob"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1');
    });
    render(<MoveList />);
    expect(screen.getByText('Ann – Bob')).toBeTruthy();
    expect(screen.getAllByText('0-1').length).toBeGreaterThan(1);
  });
});

describe('MoveList opening', () => {
  it('shows ECO and name, follows the current ply, hides for custom FEN', async () => {
    const { loadOpenings } = await import('../../openings');
    await loadOpenings();
    render(<MoveList />);
    expect(screen.queryByText('C40')).toBeNull();
    play(['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3']);
    expect(screen.getByText('C40')).toBeTruthy();
    expect(screen.getByText("King's Knight Opening")).toBeTruthy();
    expect(screen.getByTestId('opening').getAttribute('aria-live')).toBe('polite');
    fireEvent.click(screen.getByRole('button', { name: '1. e4' }));
    expect(screen.getByText('B00')).toBeTruthy();
    expect(screen.getByText("King's Pawn Game")).toBeTruthy();
    act(() => {
      useGameStore
        .getState()
        .loadFen('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b - - 1 2');
    });
    expect(screen.queryByText('B00')).toBeNull();
    expect(screen.queryByText('C40')).toBeNull();
  });
});

describe('MoveList review badges', () => {
  it('shows class glyphs with tooltip once a review is done', async () => {
    const { useReviewStore } = await import('../../review/reviewStore');
    const { scholarSummary } = await import('../../review/testFixtures');
    act(() => {
      useGameStore.getState().loadPgn('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#');
    });
    const { container } = render(<MoveList />);
    expect(container.querySelector('[data-class]')).toBeNull();
    act(() => useReviewStore.setState({ status: 'done', summary: scholarSummary() }));
    const blunder = container.querySelector('[data-class="blunder"]')!;
    expect(blunder.textContent).toBe('??');
    expect(blunder.getAttribute('title')).toMatch(/^Blunder/);
    expect(container.querySelector('[data-class="inaccuracy"]')!.textContent).toBe('?!');
    act(() => useReviewStore.setState({ status: 'idle', summary: undefined }));
  });
});

describe('MoveList tablebase badge (ADR-025 §4)', () => {
  const KQK_PGN = '[SetUp "1"]\n[FEN "8/8/8/8/8/2k5/8/KQ6 w - - 0 1"]\n\n1. Qb3+ Kxb3';
  const reviewedMove = (ply: number, san: string, uci: string, mover: 'white' | 'black') => ({
    ply,
    san,
    uci,
    mover,
    evalBefore: { cp: 0 },
    evalAfter: { cp: 0 },
    winProbBefore: 50,
    winProbAfter: 50,
    winProbLoss: ply === 1 ? 50 : 0,
    classification: ply === 1 ? ('blunder' as const) : ('best' as const),
  });
  const verdict = (uci: string, san: string, kind: 'thrown' | 'only' | 'kept') => ({
    uci,
    san,
    before: kind === 'thrown' ? ('win' as const) : ('draw' as const),
    after: 'draw' as const,
    kind,
    keepers: kind === 'only' ? [uci] : ['b1e1'],
  });

  it('shows TB with data-tb, title and aria-label for plies with a verdict of the shown review', async () => {
    const { useReviewStore } = await import('../../review/reviewStore');
    act(() => {
      useGameStore.getState().loadPgn(KQK_PGN);
    });
    const moves = useGameStore.getState().moves;
    const counts = {
      best: 0,
      excellent: 0,
      good: 0,
      inaccuracy: 0,
      mistake: 0,
      blunder: 0,
      forced: 0,
    };
    const summary = {
      white: { accuracy: 10, counts },
      black: { accuracy: 90, counts },
      moves: [reviewedMove(1, 'Qb3+', 'b1b3', 'white'), reviewedMove(2, 'Kxb3', 'c3b3', 'black')],
    };
    const { container } = render(<MoveList />);
    act(() => useReviewStore.setState({ status: 'done', summary, reviewed: moves }));
    expect(container.querySelector('[data-tb]')).toBeNull();
    act(() =>
      useReviewStore.setState({
        tablebase: {
          status: 'done',
          missed: 0,
          reviewed: moves,
          verdicts: { 1: verdict('b1b3', 'Qb3+', 'thrown'), 2: verdict('c3b3', 'Kxb3', 'only') },
        },
      }),
    );
    const thrown = container.querySelector('[data-tb="thrown"]')!;
    expect(thrown.textContent).toBe('TB');
    expect(thrown.getAttribute('title')).toBe('Tablebase: throws away the win');
    expect(thrown.getAttribute('aria-label')).toBe('Tablebase: throws away the win');
    // Next to the class glyph of the same move.
    expect(thrown.previousElementSibling?.getAttribute('data-class')).toBe('blunder');
    const only = container.querySelector('[data-tb="only"]')!;
    expect(only.getAttribute('title')).toBe('Tablebase: only move');
    // The move buttons keep their names.
    expect(screen.getByRole('button', { name: '1. Qb3+' })).toBeTruthy();

    // An overlay of another review, or a verdict of another move: no badge.
    act(() =>
      useReviewStore.setState({
        tablebase: { ...useReviewStore.getState().tablebase!, reviewed: [] },
      }),
    );
    expect(container.querySelector('[data-tb]')).toBeNull();
    act(() =>
      useReviewStore.setState({
        tablebase: {
          status: 'done',
          missed: 0,
          reviewed: moves,
          verdicts: { 1: verdict('b1d1', 'Qd1', 'kept') },
        },
      }),
    );
    expect(container.querySelector('[data-tb]')).toBeNull();
    act(() => useReviewStore.getState().reset());
  });
});
