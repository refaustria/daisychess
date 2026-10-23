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
