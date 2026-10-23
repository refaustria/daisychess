// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '../../store/settingsStore';
import { CapturedPieces } from './CapturedPieces';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// White captured two pawns and a knight; black captured nothing.
const AFTER = 'r1bqkbnr/ppp2ppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

afterEach(cleanup);

describe('CapturedPieces', () => {
  it('renders nothing without captures or advantage', () => {
    const { container } = render(<CapturedPieces side="white" startFen={START} fen={START} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the captured black pieces and the advantage in white\'s bar', () => {
    render(<CapturedPieces side="white" startFen={START} fen={AFTER} />);
    const el = screen.getByRole('img', { name: 'captured: 1 knight, 2 pawns, +5' });
    expect(el.className).toMatch(/piece-set-/);
    expect(el.querySelectorAll('piece.black.knight')).toHaveLength(1);
    expect(el.querySelectorAll('piece.black.pawn')).toHaveLength(2);
    expect(screen.getByTestId('advantage-white').textContent).toBe('+5');
  });

  it("black's bar shows nothing when black captured nothing and is behind", () => {
    const { container } = render(<CapturedPieces side="black" startFen={START} fen={AFTER} />);
    expect(container.firstChild).toBeNull();
  });

  it('equal trade: icons on both sides, no advantage number', () => {
    const fen = 'rnbqkbnr/ppp1pppp/8/8/8/8/PPP1PPPP/RNBQKBNR w KQkq - 0 1';
    render(<CapturedPieces side="black" startFen={START} fen={fen} />);
    expect(screen.getByRole('img', { name: 'captured: 1 pawn' })).toBeTruthy();
    expect(screen.queryByTestId('advantage-black')).toBeNull();
  });

  it('uses the selected piece set', () => {
    act(() => useSettingsStore.setState({ pieceSet: 'letters' }));
    render(<CapturedPieces side="white" startFen={START} fen={AFTER} />);
    expect(screen.getByTestId('captured-white').className).toMatch(/piece-set-letters/);
    act(() => useSettingsStore.setState({ pieceSet: 'cburnett' }));
  });
});
