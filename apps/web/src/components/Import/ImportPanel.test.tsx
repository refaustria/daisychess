// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportPanel } from './ImportPanel';
import * as online from '../../import';
import { AUTH_STORAGE_KEY, lichessFetch, resetLichessAuth } from '../../lichess/auth';
import { currentFen, useGameStore } from '../../store/gameStore';

vi.mock('../../import', async (orig) => {
  const actual = await orig<typeof import('../../import')>();
  return { ...actual, fetchOnlineGames: vi.fn(), fetchOnlineGamePgn: vi.fn() };
});

afterEach(cleanup);
beforeEach(() => {
  useGameStore.getState().reset();
  localStorage.clear();
  resetLichessAuth();
  vi.mocked(online.fetchOnlineGames).mockReset();
  vi.mocked(online.fetchOnlineGamePgn).mockReset();
});

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

  describe('online games', () => {
    const game: online.OnlineGame = {
      id: 'g1',
      site: 'lichess',
      white: { name: 'Alice', rating: 1800 },
      black: { name: 'Bob', rating: 1750 },
      result: '1-0',
      date: '2023-11-14T22:13:20.000Z',
      timeControl: '3+2',
      opening: 'Italian Game',
    };
    const game2: online.OnlineGame = { ...game, id: 'g2', white: { name: 'Cy' }, black: { name: 'alice' } };

    it('has a site radiogroup defaulting to lichess', () => {
      render(<ImportPanel />);
      const group = screen.getByRole('radiogroup', { name: 'Site' });
      expect(group).toBeTruthy();
      expect((screen.getByRole('radio', { name: 'lichess' }) as HTMLInputElement).checked).toBe(true);
      fireEvent.click(screen.getByRole('radio', { name: 'chess.com' }));
      expect((screen.getByRole('radio', { name: 'chess.com' }) as HTMLInputElement).checked).toBe(true);
    });

    it('fetches, lists rows, loads the PGN on click and remembers the username', async () => {
      vi.mocked(online.fetchOnlineGames).mockResolvedValue([game, game2]);
      vi.mocked(online.fetchOnlineGamePgn).mockResolvedValue('[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 2. Nf3 1-0');
      const onLoaded = vi.fn();
      render(<ImportPanel onLoaded={onLoaded} />);
      type('Username', 'Alice');
      fireEvent.click(screen.getByRole('button', { name: 'Fetch games' }));
      await screen.findByText(/Alice \(1800\)/);
      expect(online.fetchOnlineGames).toHaveBeenCalledWith('lichess', 'Alice');
      expect(screen.getAllByText(/1-0 · 2023-11-14 · 3\+2 · Italian Game/)).toHaveLength(2);
      expect(screen.getAllByText(/\(you, /)).toHaveLength(2);
      expect(JSON.parse(localStorage.getItem('chesslab.import.online') ?? '{}').users.lichess).toBe('Alice');

      fireEvent.click(screen.getAllByRole('button', { name: /Alice \(1800\)/ })[0] as HTMLElement);
      await waitFor(() => expect(onLoaded).toHaveBeenCalled());
      const s = useGameStore.getState();
      expect(s.moves).toHaveLength(3);
      expect(s.ply).toBe(0);
      expect(s.headers.White).toBe('Alice');
      expect(screen.getByText('Loaded: Alice – Bob')).toBeTruthy();
    });

    it('submits on Enter and shows the specific error', async () => {
      vi.mocked(online.fetchOnlineGames).mockRejectedValue(
        new online.OnlineImportError('not-found', 'User "ghost" not found on lichess'),
      );
      render(<ImportPanel />);
      type('Username', 'ghost');
      fireEvent.keyDown(screen.getByLabelText('Username'), { key: 'Enter' });
      expect((await screen.findByRole('alert')).textContent).toBe('User "ghost" not found on lichess');
    });

    it('hides "My games" when not logged in with lichess', () => {
      render(<ImportPanel />);
      expect(screen.queryByRole('button', { name: 'My games' })).toBeNull();
    });

    it('"My games" fetches the logged-in user\'s games with the lichess login', async () => {
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'lio_x', username: 'Alice', scopes: [] }));
      localStorage.setItem('chesslab.import.online', JSON.stringify({ site: 'chesscom', users: { chesscom: 'cc' } }));
      resetLichessAuth();
      vi.mocked(online.fetchOnlineGames).mockResolvedValue([game]);
      vi.mocked(online.fetchOnlineGamePgn).mockResolvedValue('[White "Alice"]\n[Black "Bob"]\n\n1. e4 e5 1-0');
      render(<ImportPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'My games' }));
      expect(online.fetchOnlineGames).toHaveBeenCalledWith('lichess', 'Alice', { fetch: lichessFetch });
      expect((screen.getByRole('radio', { name: 'lichess' }) as HTMLInputElement).checked).toBe(true);
      expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('Alice');
      const row = await screen.findByRole('button', { name: /Alice \(1800\)/ });
      fireEvent.click(row);
      await waitFor(() => expect(online.fetchOnlineGamePgn).toHaveBeenCalledWith(game, { fetch: lichessFetch }));
    });

    it('restores the saved username per site', () => {
      localStorage.setItem(
        'chesslab.import.online',
        JSON.stringify({ site: 'chesscom', users: { lichess: 'li', chesscom: 'cc' } }),
      );
      render(<ImportPanel />);
      expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('cc');
      fireEvent.click(screen.getByRole('radio', { name: 'lichess' }));
      expect((screen.getByLabelText('Username') as HTMLInputElement).value).toBe('li');
    });
  });
});
