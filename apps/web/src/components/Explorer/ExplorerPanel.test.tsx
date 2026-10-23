// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../../explorer/client';
import type { ExplorerFetch } from '../../explorer/client';
import { resetExplorerRuntime, setExplorerFetch, useExplorerStore } from '../../explorer/explorerStore';
import { CASTLING, EMPTY, htmlResponse, jsonResponse, LICHESS_E4, MASTERS_PGN, MASTERS_START } from '../../explorer/fixtures';
import { AUTH_STORAGE_KEY, resetLichessAuth } from '../../lichess/auth';
import { useLiveStore } from '../../live/liveStore';
import { usePlayStore } from '../../play/playStore';
import { currentFen, useGameStore } from '../../store/gameStore';
import { ExplorerPanel } from './ExplorerPanel';

vi.mock('../../explorer/client', async (orig) => {
  const actual = await orig<typeof import('../../explorer/client')>();
  return { ...actual, fetchExplorerGamePgn: vi.fn() };
});

let fetchMock: ReturnType<typeof vi.fn<ExplorerFetch>>;

beforeEach(() => {
  localStorage.clear();
  resetLichessAuth();
  resetExplorerRuntime();
  useExplorerStore.setState({ active: false, status: 'idle', key: undefined, data: undefined, error: undefined, db: 'masters', token: 'lip_t' });
  useGameStore.getState().reset();
  usePlayStore.setState({ mode: 'idle' });
  useLiveStore.setState({ status: 'idle' });
  fetchMock = vi.fn<ExplorerFetch>(async () => jsonResponse(MASTERS_START));
  setExplorerFetch(fetchMock);
  vi.mocked(client.fetchExplorerGamePgn).mockReset();
});

afterEach(() => {
  cleanup();
  setExplorerFetch(undefined);
});

async function renderReady() {
  const utils = render(<ExplorerPanel />);
  await screen.findByText('3,000 games');
  return utils;
}

describe('ExplorerPanel', () => {
  it('shows totals, W/D/L, moves and top games', async () => {
    await renderReady();
    expect(screen.getByRole('img', { name: 'Results: White 33%, draw 40%, Black 27%' })).toBeTruthy();
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(4); // header + 3 moves
    expect(rows[1]?.textContent).toContain('1,400');
    expect(rows[1]?.textContent).toContain('2400');
    const games = within(screen.getByRole('list', { name: 'Top games' })).getAllByRole('listitem');
    expect(games[0]?.textContent).toContain('Carlsen, M. (2882)');
    expect(games[0]?.textContent).toContain('(won)');
    expect(games[0]?.textContent).toContain('2019-06');
    expect(games[1]?.textContent).toContain('(draw)');
  });

  it('activates the store on mount and deactivates on unmount', async () => {
    const { unmount } = await renderReady();
    expect(useExplorerStore.getState().active).toBe(true);
    unmount();
    expect(useExplorerStore.getState().active).toBe(false);
  });

  it('clicking a move plays it on the board', async () => {
    await renderReady();
    const spy = vi.spyOn(useGameStore.getState(), 'makeMove');
    fireEvent.click(screen.getByRole('button', { name: 'Play e4' }));
    expect(spy).toHaveBeenCalledWith('e2', 'e4', undefined);
    expect(useGameStore.getState().moves.map((m) => m.san)).toEqual(['e4']);
    spy.mockRestore();
  });

  it('plays from a non-tip position (branches like makeMove)', async () => {
    useGameStore.getState().makeMove('d2', 'd4');
    useGameStore.getState().goTo(0);
    await renderReady();
    fireEvent.click(screen.getByRole('button', { name: 'Play e4' }));
    expect(useGameStore.getState().moves.map((m) => m.san)).toEqual(['e4']);
  });

  it('resolves castling (explorer sends e1h1) via SAN', async () => {
    useGameStore.getState().loadFen('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
    fetchMock.mockResolvedValue(jsonResponse(CASTLING));
    render(<ExplorerPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Play O-O' }));
    expect(useGameStore.getState().moves[0]?.san).toBe('O-O');
  });

  it('fair play: no requests and the lock line while a human game runs; resumes afterwards', async () => {
    usePlayStore.setState({ mode: 'playing' });
    render(<ExplorerPanel />);
    expect(screen.getByTestId('explorer-locked').textContent).toBe('Paused while playing against the engine');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400)); // longer than the debounce
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useExplorerStore.getState().active).toBe(false);
    expect(screen.queryByRole('table')).toBeNull();

    act(() => usePlayStore.setState({ mode: 'finished' }));
    await screen.findByText('3,000 games');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('explorer-locked')).toBeNull();

    // A live game locks it again: the data disappears, nothing new is requested.
    act(() => useLiveStore.setState({ status: 'playing' }));
    expect(screen.getByTestId('explorer-locked').textContent).toBe('Disabled during a live game (lichess fair play)');
    expect(screen.queryByRole('table')).toBeNull();
    act(() => useGameStore.getState().makeMove('e2', 'e4'));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => useLiveStore.setState({ status: 'idle' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('Load fetches the PGN, loads it and jumps to the explored position', async () => {
    useGameStore.getState().makeMove('e2', 'e4');
    vi.mocked(client.fetchExplorerGamePgn).mockResolvedValue(MASTERS_PGN);
    const onLoaded = vi.fn();
    render(<ExplorerPanel onLoaded={onLoaded} />);
    const loadPgn = vi.spyOn(useGameStore.getState(), 'loadPgn');
    fireEvent.click(await screen.findByRole('button', { name: 'Load Carlsen, M. – Caruana, F.' }));
    await screen.findByText('Loaded: Carlsen, M. – Caruana, F.');
    expect(client.fetchExplorerGamePgn).toHaveBeenCalledWith('masters', 'mAsTer01', { token: 'lip_t' });
    expect(loadPgn).toHaveBeenCalledWith(MASTERS_PGN);
    expect(useGameStore.getState().moves).toHaveLength(4);
    expect(useGameStore.getState().ply).toBe(1); // after 1. e4
    expect(onLoaded).toHaveBeenCalled();
    loadPgn.mockRestore();
  });

  it('shows a load error', async () => {
    vi.mocked(client.fetchExplorerGamePgn).mockRejectedValue(new client.ExplorerError('network', 'Could not reach'));
    await renderReady();
    fireEvent.click(screen.getAllByRole('button', { name: /^Load / })[0] as HTMLElement);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach');
    expect(currentFen(useGameStore.getState())).toContain('rnbqkbnr/pppppppp');
  });

  it('lichess db: opening name, recent games with speed', async () => {
    useExplorerStore.setState({ db: 'lichess' });
    fetchMock.mockResolvedValue(jsonResponse(LICHESS_E4));
    render(<ExplorerPanel />);
    expect((await screen.findByTestId('explorer-opening')).textContent).toBe("B00 King's Pawn");
    const item = within(screen.getByRole('list', { name: 'Recent games' })).getByRole('listitem');
    expect(item.textContent).toContain('alice (1800)');
    expect(item.textContent).toContain('Blitz · 2024-03');
    expect(screen.getByRole('group', { name: 'Ratings' })).toBeTruthy();
  });

  it('db toggle switches the database', async () => {
    await renderReady();
    fetchMock.mockResolvedValue(jsonResponse(LICHESS_E4));
    fireEvent.click(screen.getByRole('radio', { name: 'Lichess' }));
    expect(useExplorerStore.getState().db).toBe('lichess');
    await screen.findByText('100 games', {}, { timeout: 2000 });
  });

  it('empty position → not found', async () => {
    fetchMock.mockResolvedValue(jsonResponse(EMPTY));
    render(<ExplorerPanel />);
    expect(await screen.findByText('Position not found in database')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('401 without token → token help, Advanced opens; saving a token refetches', async () => {
    useExplorerStore.setState({ token: '' });
    fetchMock.mockImplementation(async (_u, init) =>
      init.headers.Authorization ? jsonResponse(MASTERS_START) : htmlResponse(401),
    );
    render(<ExplorerPanel />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/requires authentication/);
    expect(screen.getByRole('button', { name: 'Log in with lichess' }).getAttribute('title')).toContain('board:play');
    expect(screen.getByRole('link', { name: 'create a lichess token' }).getAttribute('href')).toContain(
      'lichess.org/account/oauth/token/create',
    );
    const details = screen.getByText('Advanced').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    const input = screen.getByLabelText('or paste a token');
    expect(input.getAttribute('type')).toBe('password');
    fireEvent.change(input, { target: { value: 'lip_new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('3,000 games');
    expect(useExplorerStore.getState().token).toBe('lip_new');
  });

  it('uses the lichess login token over the pasted one (requests and game loads)', async () => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'lio_login', username: 'Alice', scopes: [] }));
    resetLichessAuth();
    vi.mocked(client.fetchExplorerGamePgn).mockResolvedValue(MASTERS_PGN);
    await renderReady();
    expect(fetchMock.mock.calls[0]?.[1].headers.Authorization).toBe('Bearer lio_login');
    expect(screen.getByTestId('explorer-auth').textContent).toBe('Using your lichess login (Alice)');
    fireEvent.click(screen.getByRole('button', { name: 'Load Carlsen, M. – Caruana, F.' }));
    await screen.findByText('Loaded: Carlsen, M. – Caruana, F.');
    expect(client.fetchExplorerGamePgn).toHaveBeenCalledWith('masters', 'mAsTer01', { token: 'lio_login' });
  });

  it('401 with a token → rejected message', async () => {
    fetchMock.mockResolvedValue(htmlResponse(401));
    render(<ExplorerPanel />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/rejected the token/);
  });

  it('429 → rate limited with seconds', async () => {
    fetchMock.mockResolvedValue(htmlResponse(429, { 'Retry-After': '42' }));
    render(<ExplorerPanel />);
    expect((await screen.findByRole('alert')).textContent).toContain('retrying in 42 s');
  });

  it('network error → Retry', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('x'));
    render(<ExplorerPanel />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('3,000 games');
  });

  it('status is announced politely', async () => {
    await renderReady();
    const status = screen.getAllByRole('status')[0] as HTMLElement;
    expect(status.getAttribute('aria-live')).toBe('polite');
    act(() => useGameStore.getState().makeMove('e2', 'e4'));
    await waitFor(() => expect(status.textContent).toBe('Loading explorer…'));
  });
});
