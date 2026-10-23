// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportPanel } from './ImportPanel';
import { currentFen, useGameStore } from '../../store/gameStore';

afterEach(cleanup);
beforeEach(() => useGameStore.getState().reset());

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('ImportPanel', () => {
  it('loads a valid FEN', () => {
    const onLoaded = vi.fn();
    render(<ImportPanel onLoaded={onLoaded} />);
    const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    type('Position to import', fen);
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(currentFen(useGameStore.getState())).toBe(fen);
    expect(onLoaded).toHaveBeenCalled();
  });

  it('shows an error for an invalid FEN', () => {
    render(<ImportPanel />);
    type('Position to import', 'nonsense');
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    expect(screen.getByText('Invalid FEN')).toBeTruthy();
  });

  it('loads a PGN and goes to ply 0', () => {
    render(<ImportPanel />);
    type('PGN text', '1. e4 e5 2. Nf3 *');
    fireEvent.click(screen.getByRole('button', { name: 'Load PGN' }));
    const s = useGameStore.getState();
    expect(s.moves).toHaveLength(3);
    expect(s.ply).toBe(0);
  });

  it('shows an error for an invalid PGN', () => {
    render(<ImportPanel />);
    type('PGN text', '1. e4 e4 e4');
    fireEvent.click(screen.getByRole('button', { name: 'Load PGN' }));
    expect(screen.getByText('Invalid PGN')).toBeTruthy();
  });

  it('offers a picker for multi-game PGN', () => {
    render(<ImportPanel />);
    type(
      'PGN text',
      '[Event "A"]\n[White "Ann"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n\n' +
        '[Event "B"]\n[White "Cy"]\n[Black "Di"]\n[Result "0-1"]\n\n1. d4 d5 2. c4 0-1',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load PGN' }));
    expect(useGameStore.getState().moves).toHaveLength(0);
    expect(screen.getByRole('option', { name: 'Ann – Bob (1-0)' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Game'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open game' }));
    const s = useGameStore.getState();
    expect(s.moves).toHaveLength(3);
    expect(s.headers.White).toBe('Cy');
    expect(s.ply).toBe(0);
  });
});
