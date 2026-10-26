// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLichessAuth } from '../../lichess/auth';
import type { LiveGame } from '../../live/LiveGameController';
import { configureLive, resetLive, useLiveStore } from '../../live/liveStore';
import { resetRatingsCache } from '../../live/ratings';
import { fakeBoardApi, type FakeBoardApi } from '../../live/testing';
import { useUiStore } from '../../store/uiStore';
import { LivePanel } from './LivePanel';
import { PlayerBar, useBoardPlayers } from '../PlayerBar/PlayerBar';

/** The board's player bars (as in App), for the clocks that moved out of the panel. */
function Bars() {
  const p = useBoardPlayers();
  const top = p.orientation === 'white' ? 'black' : 'white';
  return (
    <>
      <PlayerBar side={top} player={p[top]} position="top" />
      <PlayerBar side={p.orientation} player={p[p.orientation]} position="bottom" />
    </>
  );
}

let api: FakeBoardApi;
const { clearPremoves: realClearPremoves } = useLiveStore.getState();

const game = (over: Partial<LiveGame> = {}): LiveGame => ({
  id: 'game1234',
  color: 'white',
  opponent: { name: 'Opp', rating: 1600, title: 'FM' },
  rated: true,
  clock: { initial: 600_000, increment: 5_000 },
  speed: 'rapid',
  status: 'started',
  moves: ['e2e4', 'e7e5'],
  firstToMove: 'white',
  wtime: 312_000,
  btime: 8_400,
  lastStateAt: Date.now(),
  ...over,
});

function login(scopes = ['board:play']) {
  useLichessAuth.setState({
    status: 'authenticated',
    token: 'tok',
    username: 'Me',
    scopes,
    error: undefined,
    source: 'oauth',
  });
}

beforeEach(() => {
  api = fakeBoardApi();
  configureLive({ api, sleep: async () => undefined });
});

afterEach(() => {
  cleanup();
  resetLive();
  useLiveStore.setState({ clearPremoves: realClearPremoves });
  useLichessAuth.setState({
    status: 'anonymous',
    token: undefined,
    username: undefined,
    scopes: [],
    source: undefined,
  });
});

describe('LivePanel', () => {
  it('not logged in: explains and offers the lichess login', () => {
    const login = vi.fn(() => Promise.resolve());
    useLichessAuth.setState({ login });
    render(<LivePanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Log in with lichess' }));
    expect(login).toHaveBeenCalled();
    expect(api.calls).not.toContain('streamEvents');
  });

  it('not logged in: also offers the personal token with the prefilled create link', () => {
    render(<LivePanel />);
    fireEvent.click(screen.getByText('Use a personal access token'));
    expect(screen.getByLabelText('Personal access token')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Create a token on lichess' }).getAttribute('href'),
    ).toContain('scopes[]=board:play');
  });

  it('token without board:play: explains the scope, no OAuth button, offers replacing the token', () => {
    login(['challenge:read']);
    useLichessAuth.setState({ source: 'token' });
    render(<LivePanel />);
    expect(screen.getByText(/personal token doesn't include/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Log in/ })).toBeNull();
    expect(screen.getByLabelText('Personal access token')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Create a new token/ }).getAttribute('href')).toContain(
      'scopes[]=board:play',
    );
  });

  it('pasted token with board:play: shows the play UI, no login prompt', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/token/test'))
        return new Response(
          JSON.stringify({
            [String(init?.body)]: { scopes: 'board:play,challenge:read,challenge:write' },
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({ id: 'me', username: 'Me' }), { status: 200 });
    }) as typeof fetch;
    try {
      render(<LivePanel />);
      fireEvent.click(screen.getByText('Use a personal access token'));
      fireEvent.change(screen.getByLabelText('Personal access token'), {
        target: { value: 'lip_abc' },
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Save lichess token' }));
      });
      expect(await screen.findByTestId('live-panel')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /Log in/ })).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      localStorage.clear();
    }
  });

  it('logged in without board:play: asks to log in again', () => {
    login(['challenge:read']);
    render(<LivePanel />);
    expect(screen.getByRole('button', { name: 'Log in again' })).toBeTruthy();
    expect(screen.getByText(/grant the board:play permission/)).toBeTruthy();
  });

  it('idle: connects, lists challenges and ongoing games, starts a quick pairing', async () => {
    login();
    useLiveStore.setState({
      challenges: [
        {
          id: 'c1234567',
          status: 'created',
          challenger: { id: 'bob', name: 'Bob', rating: 1700 },
          rated: true,
          speed: 'blitz',
          variant: 'standard',
          color: 'random',
          clock: { limit: 300, increment: 3 },
        },
      ],
      ongoing: [
        {
          gameId: 'g7654321',
          color: 'black',
          opponent: { name: 'Eve' },
          rated: false,
          speed: 'rapid',
          isMyTurn: true,
        },
      ],
    });
    render(<LivePanel />);
    expect(api.calls).toContain('streamEvents');
    expect(screen.getByTestId('challenge').textContent).toContain('Bob (1700)');
    expect(screen.getByTestId('challenge').textContent).toContain('5+3 · rated');
    expect(screen.getByText(/your move/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: '15+10' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Find an opponent' }));
    });
    expect(api.seeks[0]!.params).toEqual({ rated: true, time: 15, increment: 10, color: 'random' });
    expect(screen.getByRole('status').textContent).toMatch(
      /Looking for an opponent \(15\+10 rated\)/,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(api.seeks[0]!.cancelled).toBe(true);
  });

  it('playing: own rating shows next to the opponent, in the bars and in the panel', () => {
    login();
    useLiveStore.setState({
      status: 'playing',
      game: game({ me: { name: 'Me', rating: 1500, provisional: true } }),
    });
    render(
      <>
        <LivePanel />
        <Bars />
      </>,
    );
    expect(screen.getByTestId('live-me').textContent).toContain('You (1500?)');
    expect(screen.getByRole('group', { name: /^White: Me · 1500\?/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /^Black: FM Opp · 1600/ })).toBeTruthy();
  });

  it('overview: shows the own ratings from /api/account once', async () => {
    login();
    resetRatingsCache();
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            username: 'Me',
            perfs: {
              bullet: { games: 3, rating: 1400, prov: true },
              blitz: { games: 120, rating: 1650 },
              puzzle: { games: 9, rating: 2000 },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { unmount } = render(<LivePanel />);
      await screen.findByTestId('live-ratings');
      expect(screen.getByTestId('live-rating-bullet').textContent).toContain('1400?');
      expect(screen.getByTestId('live-rating-blitz').textContent).toContain('1650');
      expect(screen.queryByTestId('live-rating-rapid')).toBeNull();
      unmount();
      render(<LivePanel />);
      await screen.findByTestId('live-ratings');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      resetRatingsCache();
    }
  });

  it('playing: opponent, clocks in the board bars (tenths under 10 s), status, abort only before move 2, resign confirm', async () => {
    login();
    useLiveStore.setState({ status: 'playing', game: game() });
    render(
      <>
        <LivePanel />
        <Bars />
      </>,
    );
    expect(screen.getByTestId('live-opponent').textContent).toBe('FM Opp (1600)');
    // The panel itself shows no clocks any more (they are in the bars beside the board).
    expect(screen.getByTestId('live-game').querySelector('[role="timer"]')).toBeNull();
    expect(screen.getByTestId('player-bar-top').getAttribute('aria-label')).toBe(
      'Black: FM Opp · 1600, 0:08.4',
    );
    const mine = screen.getByTestId('clock-white');
    const theirs = screen.getByTestId('clock-black');
    expect(mine.getAttribute('aria-live')).toBe('off');
    expect(mine.getAttribute('data-active')).toBe('true');
    expect(theirs.textContent).toBe('0:08.4');
    expect(theirs.className).toMatch(/clockLow/);
    expect(screen.getByTestId('live-status').textContent).toBe('Your move');
    expect(screen.getByTestId('live-status').getAttribute('aria-live')).toBe('polite');
    expect(screen.queryByRole('button', { name: 'Abort' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resign' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes, resign' }));
    });
    expect(api.calls).toContain('resign game1234');
    act(() => useLiveStore.setState({ game: game({ moves: ['e2e4'] }) }));
    expect(screen.getByTestId('live-status').textContent).toBe('Waiting for opponent');
    expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy();
  });

  it('playing: shows the premove queue with a Clear button', () => {
    login();
    const clearPremoves = vi.fn();
    useLiveStore.setState({
      status: 'playing',
      game: game({ moves: [] }),
      premoves: ['e2e4', 'g1f3'],
      clearPremoves,
    });
    render(<LivePanel />);
    expect(screen.getByTestId('live-premoves').textContent).toBe(
      'Premoves: e4, Nf3 (Esc to clear)Clear',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(clearPremoves).toHaveBeenCalled();
  });

  it('playing: draw offer banner and claim victory', async () => {
    login();
    useLiveStore.setState({
      status: 'playing',
      game: game({ drawOffer: 'opponent', opponentGone: { claimAt: Date.now() - 1 } }),
    });
    render(<LivePanel />);
    expect(screen.getByRole('alert').textContent).toContain('offers a draw');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    });
    expect(api.calls).toContain('draw game1234 yes');
    expect(screen.getByTestId('live-status').textContent).toMatch(/Opponent left/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Claim victory' }));
    });
    expect(api.calls).toContain('claimVictory game1234');
  });

  it('finished: result, New game and Review this game', () => {
    login();
    useLiveStore.setState({
      status: 'finished',
      game: game({ status: 'mate', reason: 'mate', winner: 'black' }),
    });
    useUiStore.setState({ activeTab: 'live' });
    render(<LivePanel />);
    expect(screen.getByTestId('live-result').textContent).toBe('0-1');
    expect(screen.getByText('You lost')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review this game' }));
    expect(useUiStore.getState().activeTab).toBe('review');
    fireEvent.click(screen.getByRole('button', { name: 'New game' }));
    expect(useLiveStore.getState().status).toBe('idle');
  });
});
