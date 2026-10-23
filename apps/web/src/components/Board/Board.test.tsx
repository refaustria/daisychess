// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const set = vi.fn();
const destroy = vi.fn();
const cancelPremove = vi.fn();
vi.mock('chessground', () => ({
  Chessground: vi.fn(() => ({ set, destroy, redrawAll: vi.fn(), cancelPremove })),
}));
vi.mock('chessground/assets/chessground.base.css', () => ({}));
vi.mock('chessground/assets/chessground.cburnett.css', () => ({}));

import { Chessground } from 'chessground';
import type { LiveGame } from '../../live/LiveGameController';
import { resetLive, useLiveStore } from '../../live/liveStore';
import { useGameStore } from '../../store/gameStore';
import { useSettingsStore } from '../../store/settingsStore';
import { Board } from './Board';

interface SetArg {
  fen?: string;
  orientation?: string;
  movable?: { dests: Map<string, string[]>; color: string | undefined };
  drawable?: { autoShapes: unknown[] };
}
const lastSet = (): SetArg =>
  set.mock.calls.filter((c) => (c[0] as SetArg).fen).at(-1)?.[0] as SetArg;

beforeEach(() => {
  set.mockClear();
  useGameStore.getState().reset();
});

describe('Board', () => {
  it('pushes fen and dests to chessground on state change', () => {
    render(<Board />);
    expect(lastSet().movable?.dests.get('e2')).toEqual(['e3', 'e4']);
    expect(lastSet().movable?.color).toBe('white');
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
    });
    expect(lastSet().fen).toContain('4P3');
    expect(lastSet().movable?.color).toBe('black');
    expect(lastSet().movable?.dests.get('e7')).toEqual(['e6', 'e5']);
    act(() => useGameStore.getState().flip());
    expect(lastSet().orientation).toBe('black');
  });

  it('passes shapes as autoShapes', () => {
    const shapes = [{ orig: 'e2', dest: 'e4', brush: 'green' }] as never[];
    render(<Board shapes={shapes} />);
    const call = set.mock.calls.filter((c) => (c[0] as SetArg).drawable).at(-1)?.[0] as SetArg;
    expect(call.drawable?.autoShapes).toEqual(shapes);
  });

  it('renders a preview fen read-only', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 b - - 0 1';
    render(<Board previewFen={fen} />);
    expect(lastSet().fen).toBe(fen);
    expect(lastSet().movable?.color).toBeUndefined();
    expect(lastSet().movable?.dests.size).toBe(0);
  });
});

type MoveEvent = (from: string, to: string) => void;
const moveHandler = (): MoveEvent =>
  (
    set.mock.calls.filter((c) => (c[0] as { events?: unknown }).events).at(-1)?.[0] as {
      events: { move: MoveEvent };
    }
  ).events.move;

describe('Board promotion dialog', () => {
  const WHITE_PROMO = '7k/P7/8/8/8/8/8/K7 w - - 0 1';
  const BLACK_PROMO = '7k/8/8/8/8/8/p7/7K b - - 0 1';
  beforeEach(() => useGameStore.setState({ orientation: 'white' }));

  it('asks for the piece (keyboard R) instead of defaulting to a queen', () => {
    useGameStore.getState().loadFen(WHITE_PROMO);
    render(<Board />);
    act(() => moveHandler()('a7', 'a8'));
    const dialog = screen.getByRole('dialog', { name: 'Choose promotion piece' });
    expect(useGameStore.getState().moves).toHaveLength(0);
    const buttons = dialog.querySelectorAll('button');
    expect([...buttons].map((b) => b.dataset.piece)).toEqual(['q', 'n', 'r', 'b']);
    // Queen on a8 (top-left for White), stacked downwards; white pieces; queen focused.
    expect((buttons[0] as HTMLElement).style.left).toBe('0%');
    expect((buttons[0] as HTMLElement).style.top).toBe('0%');
    expect((buttons[3] as HTMLElement).style.top).toBe('37.5%');
    expect(dialog.querySelector('piece')?.className).toBe('queen white');
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(window, { key: 'r' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useGameStore.getState().moves[0]?.san).toBe('a8=R+');
  });

  it('black promotion by mouse, positioned from the bottom when White is at the bottom', () => {
    useGameStore.getState().loadFen(BLACK_PROMO);
    render(<Board />);
    act(() => moveHandler()('a2', 'a1'));
    const knight = screen.getByRole('button', { name: /knight/ });
    expect(knight.style.top).toBe('75%'); // a1 is row 7; knight is second from the edge
    expect(knight.querySelector('piece')?.className).toBe('knight black');
    fireEvent.click(knight);
    expect(useGameStore.getState().moves[0]?.san).toBe('a1=N');
  });

  it('orientation black: top edge for Black, file mirrored', () => {
    useGameStore.getState().loadFen(BLACK_PROMO);
    act(() => useGameStore.setState({ orientation: 'black' }));
    render(<Board />);
    act(() => moveHandler()('a2', 'a1'));
    const queen = screen.getByRole('button', { name: /queen/ });
    expect(queen.style.left).toBe('87.5%');
    expect(queen.style.top).toBe('0%');
  });

  it('Escape cancels and restores the position on the board', () => {
    useGameStore.getState().loadFen(WHITE_PROMO);
    render(<Board />);
    const before = set.mock.calls.length;
    act(() => moveHandler()('a7', 'a8'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useGameStore.getState().moves).toHaveLength(0);
    const resynced = set.mock.calls.slice(before).some((c) => (c[0] as SetArg).fen);
    expect(resynced).toBe(true);
  });

  it('non-promotion moves go straight to the store', () => {
    render(<Board />);
    act(() => moveHandler()('e2', 'e4'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useGameStore.getState().moves).toHaveLength(1);
  });
});

describe('Board movableColor', () => {
  it('only lets the given colour move, on its turn; null locks the board', () => {
    const { rerender } = render(<Board movableColor="white" />);
    expect(lastSet().movable?.color).toBe('white');
    rerender(<Board movableColor="black" />);
    expect(lastSet().movable?.color).toBeUndefined();
    expect(lastSet().movable?.dests.size).toBe(0);
    rerender(<Board movableColor={null} />);
    expect(lastSet().movable?.color).toBeUndefined();
  });
});

describe('Board during a live game', () => {
  const live = (color: 'white' | 'black'): LiveGame => ({
    id: 'game1234',
    color,
    opponent: { name: 'Opp' },
    rated: false,
    clock: null,
    speed: 'rapid',
    status: 'started',
    moves: [],
    firstToMove: 'white',
    wtime: 0,
    btime: 0,
    lastStateAt: 0,
  });
  afterEach(() => {
    resetLive();
    useSettingsStore.setState({ premoves: 'single' });
    useLiveStore.setState({ addPremove: liveActions.addPremove, clearPremoves: liveActions.clearPremoves });
  });
  const liveActions = {
    addPremove: useLiveStore.getState().addPremove,
    clearPremoves: useLiveStore.getState().clearPremoves,
  };

  it('overrides movableColor: the user colour moves on its turn, premoves on the other turn', () => {
    useLiveStore.setState({ status: 'playing', game: live('black') });
    render(<Board movableColor={null} />);
    // White to move: Black may only premove.
    expect(lastSet().movable?.color).toBe('black');
    expect(lastSet().movable?.dests.size).toBe(0);
    const cfg = set.mock.calls.filter((c) => (c[0] as SetArg).fen).at(-1)?.[0] as { premovable?: { enabled: boolean } };
    expect(cfg.premovable?.enabled).toBe(true);
    // chessground reports the premove; it lands in the live store.
    const init = vi.mocked(Chessground).mock.calls.at(-1)![1] as {
      premovable: { events: { set(o: string, d: string): void; unset(): void } };
    };
    // chessground reports premoves to the game's queue; the board mirrors the queue.
    const addPremove = vi.fn();
    const clearPremoves = vi.fn();
    useLiveStore.setState({ addPremove, clearPremoves });
    act(() => init.premovable.events.set('e7', 'e5'));
    expect(addPremove).toHaveBeenCalledWith('e7e5');
    act(() => init.premovable.events.unset());
    expect(clearPremoves).toHaveBeenCalledTimes(1);
    act(() => useLiveStore.setState({ premoves: ['e7e5'] }));
    act(() => useLiveStore.setState({ premoves: [] }));
    // Cleared by the game (played or dropped): chessground's premove highlight goes too.
    expect(cancelPremove).toHaveBeenCalled();
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
    });
    expect(lastSet().movable?.color).toBe('black');
    expect(lastSet().movable?.dests.get('e7')).toEqual(['e6', 'e5']);
  });

  it('queue mode: queued premoves are drawn as numbered arrows; Escape and right-click clear them', () => {
    useSettingsStore.setState({ premoves: 'queue' });
    const clearPremoves = vi.fn();
    useLiveStore.setState({ status: 'playing', game: live('black'), premoves: ['e7e5', 'g8f6'], clearPremoves });
    render(<Board />);
    const shapes = set.mock.calls.map((c) => (c[0] as SetArg).drawable?.autoShapes).filter(Boolean).at(-1);
    expect(shapes).toEqual([
      { orig: 'e7', dest: 'e5', brush: 'paleGrey', label: { text: '1' } },
      { orig: 'g8', dest: 'f6', brush: 'paleGrey', label: { text: '2' } },
    ]);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(clearPremoves).toHaveBeenCalledTimes(1);
    fireEvent.mouseDown(screen.getByTestId('board'), { button: 2 });
    expect(clearPremoves).toHaveBeenCalledTimes(2);
    useSettingsStore.setState({ premoves: 'none' });
    expect(lastSet().movable?.color).toBe('black');
  });

  it('premoves off: no premove on the opponent turn', () => {
    useSettingsStore.setState({ premoves: 'none' });
    useLiveStore.setState({ status: 'playing', game: live('black') });
    render(<Board />);
    const cfg = set.mock.calls.filter((c) => (c[0] as SetArg).fen).at(-1)?.[0] as { premovable?: { enabled: boolean } };
    expect(cfg.premovable?.enabled).toBe(false);
    expect(lastSet().movable?.color).toBeUndefined();
    useSettingsStore.setState({ premoves: 'single' });
  });

  it('browsing an earlier move locks the board', () => {
    act(() => {
      useGameStore.getState().makeMove('e2', 'e4');
      useGameStore.getState().goTo(0);
    });
    useLiveStore.setState({ status: 'playing', game: live('white') });
    render(<Board />);
    expect(lastSet().movable?.color).toBeUndefined();
  });
});

afterEach(cleanup);
