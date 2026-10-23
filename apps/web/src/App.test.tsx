// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('chessground', () => ({
  Chessground: vi.fn(() => ({ set: vi.fn(), redrawAll: vi.fn(), destroy: vi.fn() })),
}));
vi.mock('chessground/assets/chessground.base.css', () => ({}));
vi.mock('chessground/assets/chessground.cburnett.css', () => ({}));

import { App } from './App';
import { useGameStore } from './store/gameStore';

beforeEach(() => useGameStore.getState().reset());

describe('App', () => {
  it('renders title, controls and status', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'ChessLab' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New game' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Flip' })).toBeTruthy();
    expect(screen.getByTestId('status').textContent).toBe('White to move');
  });

  it('updates status and responds to keyboard navigation', () => {
    render(<App />);
    const s = useGameStore.getState();
    act(() => {
      for (const [f, t] of [
        ['f2', 'f3'],
        ['e7', 'e5'],
        ['g2', 'g4'],
        ['d8', 'h4'],
      ] as const) {
        s.makeMove(f, t);
      }
    });
    expect(screen.getByTestId('status').textContent).toBe('Checkmate — Black wins');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(useGameStore.getState().ply).toBe(3);
    fireEvent.keyDown(window, { key: 'Home' });
    expect(useGameStore.getState().ply).toBe(0);
    fireEvent.keyDown(window, { key: 'End' });
    expect(useGameStore.getState().ply).toBe(4);
    expect((screen.getByLabelText('FEN') as HTMLInputElement).value).toContain('rnb1kbnr');
  });
});
afterEach(cleanup);
