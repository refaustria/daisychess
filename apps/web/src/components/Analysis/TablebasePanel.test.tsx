// @vitest-environment jsdom
import type { TbMove, TbPosition } from '@daisychess/endgames';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  configureTablebase,
  resetTablebaseStore,
  useTablebaseStore,
} from '../../endgames/tablebaseStore';
import { usePlayStore } from '../../play/playStore';
import { useGameStore } from '../../store/gameStore';
import { useSettingsStore } from '../../store/settingsStore';
import { moveResult, TablebasePanel, tbHeadline, tbStatusText } from './TablebasePanel';

const KQK = '8/8/8/8/8/2k5/8/KQ6 w - - 0 1';
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const move = (
  uci: string,
  san: string,
  category: TbMove['category'],
  extra: Partial<TbMove> = {},
): TbMove => ({
  uci,
  san,
  category,
  zeroing: false,
  checkmate: false,
  stalemate: false,
  ...extra,
});

const POS: TbPosition = {
  fen: KQK,
  category: 'win',
  dtm: 17,
  dtz: 15,
  moves: [
    move('b1b3', 'Qb3+', 'draw', { dtz: 0 }),
    move('b1d1', 'Qd1', 'loss', { dtm: -18, dtz: -18 }),
    move('b1e1', 'Qe1+', 'loss', { dtm: -16, dtz: -14 }),
    move('a1a2', 'Ka2', 'blessed-loss', { dtz: -120 }),
  ],
};

beforeEach(() => {
  resetTablebaseStore();
  useSettingsStore.setState({ tablebase: 'online' });
  act(() => {
    useGameStore.getState().loadFen(KQK);
  });
});
afterEach(() => {
  cleanup();
  configureTablebase(null);
  resetTablebaseStore();
});

const showAnswer = (source: 'lichess' | 'local' = 'lichess', fen = KQK) =>
  useTablebaseStore.setState({ current: { fen, status: 'done', answer: { pos: POS, source } } });

describe('helpers', () => {
  it('tbHeadline', () => {
    expect(tbHeadline({ result: 'white', mateIn: 14, dtz: 15, exact50: true })).toBe(
      'White wins — mate in 14 · DTZ 15',
    );
    expect(tbHeadline({ result: 'black', dtz: -3, exact50: true })).toBe('Black wins · DTZ 3');
    expect(tbHeadline({ result: 'draw', exact50: true })).toBe('Draw');
    expect(tbHeadline({ result: 'draw', exact50: false, dtz: 101 })).toBe('Draw (50-move rule)');
  });

  it('moveResult: the mover’s word from the opponent’s category', () => {
    expect(moveResult({ category: 'loss' })).toEqual({ word: 'Win', by50: false });
    expect(moveResult({ category: 'win' })).toEqual({ word: 'Loss', by50: false });
    expect(moveResult({ category: 'draw' })).toEqual({ word: 'Draw', by50: false });
    expect(moveResult({ category: 'blessed-loss' })).toEqual({ word: 'Draw', by50: true });
    expect(moveResult({ category: 'cursed-win' })).toEqual({ word: 'Draw', by50: true });
  });

  it('tbStatusText', () => {
    expect(tbStatusText({ status: 'loading' })).toBe('Looking up…');
    expect(tbStatusText({ status: 'unavailable', reason: 'unavailable' })).toBe(
      'Not available offline',
    );
    expect(tbStatusText({ status: 'unavailable', reason: 'needs-download', pack: 'rook' })).toBe(
      'Not available offline (needs the rook endgames download)',
    );
    expect(tbStatusText({ status: 'disabled', reason: 'off' })).toBeNull();
    expect(tbStatusText({ status: 'idle' })).toBeNull();
  });
});

describe('TablebasePanel', () => {
  it('header with source and result, ranked move table best first', () => {
    showAnswer();
    render(<TablebasePanel fen={KQK} />);
    expect(screen.getByTestId('tablebase-head').textContent).toBe(
      'Tablebase (lichess): White wins — mate in 9 · DTZ 15',
    );
    const table = screen.getByRole('table', { name: 'Tablebase moves, best first' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.getAttribute('data-uci'))).toEqual(['b1e1', 'b1d1', 'a1a2', 'b1b3']);
    expect(within(rows[0]!).getByText('Win').getAttribute('data-result')).toBe('win');
    expect(rows[0]!.textContent).toContain('14');
    expect(rows[0]!.textContent).toContain('16');
    expect(within(rows[2]!).getByText('Draw*').getAttribute('title')).toMatch(/50-move rule/);
    expect(within(rows[3]!).getByText('Draw').getAttribute('data-result')).toBe('draw');
  });

  it('local answers say "on this device"', () => {
    showAnswer('local');
    render(<TablebasePanel fen={KQK} />);
    expect(screen.getByTestId('tablebase-head').textContent).toMatch(
      /^Tablebase \(on this device\):/,
    );
  });

  it('a click plays the move on the board', () => {
    showAnswer();
    render(<TablebasePanel fen={KQK} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play Qe1+' }));
    const g = useGameStore.getState();
    expect(g.moves.map((m) => m.san)).toEqual(['Qe1+']);
  });

  it('never plays into another position (the board moved on)', () => {
    showAnswer();
    render(<TablebasePanel fen={KQK} />);
    act(() => {
      useGameStore.getState().loadFen(START);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Play Qe1+' }));
    expect(useGameStore.getState().moves).toHaveLength(0);
  });

  it('looking up, not available offline, hidden for other FENs and refusals', () => {
    useTablebaseStore.setState({ current: { fen: KQK, status: 'loading' } });
    const { rerender } = render(<TablebasePanel fen={KQK} />);
    expect(screen.getByTestId('tablebase-status').textContent).toBe('Looking up…');
    act(() =>
      useTablebaseStore.setState({
        current: { fen: KQK, status: 'unavailable', reason: 'needs-download', pack: 'rook' },
      }),
    );
    expect(screen.getByTestId('tablebase-status').textContent).toBe(
      'Not available offline (needs the rook endgames download)',
    );
    act(() =>
      useTablebaseStore.setState({ current: { fen: KQK, status: 'disabled', reason: 'off' } }),
    );
    expect(screen.queryByTestId('tablebase-panel')).toBeNull();
    // An answer of another position is never shown.
    act(() => showAnswer('lichess', START));
    rerender(<TablebasePanel fen={KQK} />);
    expect(screen.queryByTestId('tablebase-panel')).toBeNull();
  });

  it('asks the store for its FEN (debounced lookup); refusals need no request', async () => {
    const probe = vi.fn(async () => POS);
    configureTablebase({
      lichess: {
        probe,
        available: () => true,
        blockedUntil: () => 0,
        blockedReason: () => null,
        requestCount: () => 0,
        abortAll: () => undefined,
      },
      local: {
        probe: async () => null,
        coverage: async () => ({ wdl: false, dtz: false, missing: [] }),
        reset: () => undefined,
        running: () => false,
      },
      cache: { get: async () => undefined, put: async () => undefined },
      lock: () => null,
      setting: () => 'online',
    });
    vi.useFakeTimers();
    try {
      render(<TablebasePanel fen={KQK} />);
      expect(screen.getByTestId('tablebase-status').textContent).toBe('Looking up…');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('tablebase-head').textContent).toMatch(/White wins/);
      cleanup();
      render(<TablebasePanel fen={START} />);
      expect(useTablebaseStore.getState().current).toMatchObject({
        fen: START,
        status: 'disabled',
      });
      expect(screen.queryByTestId('tablebase-panel')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is hidden during a human game (fair play)', () => {
    showAnswer();
    const mode = usePlayStore.getState().mode;
    render(<TablebasePanel fen={KQK} />);
    expect(screen.getByTestId('tablebase-panel')).toBeTruthy();
    try {
      act(() => usePlayStore.setState({ mode: 'playing' }));
      expect(screen.queryByTestId('tablebase-panel')).toBeNull();
    } finally {
      act(() => usePlayStore.setState({ mode }));
    }
  });
});
