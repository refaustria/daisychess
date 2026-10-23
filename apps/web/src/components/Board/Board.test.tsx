// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const set = vi.fn();
const destroy = vi.fn();
vi.mock('chessground', () => ({ Chessground: vi.fn(() => ({ set, destroy, redrawAll: vi.fn() })) }));
vi.mock('chessground/assets/chessground.base.css', () => ({}));
vi.mock('chessground/assets/chessground.cburnett.css', () => ({}));

import { useGameStore } from '../../store/gameStore';
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
afterEach(cleanup);
