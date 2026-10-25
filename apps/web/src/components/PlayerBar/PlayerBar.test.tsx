// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLichessAuth } from '../../lichess/auth';
import type { LiveGame } from '../../live/LiveGameController';
import { resetLive, useLiveStore } from '../../live/liveStore';
import { SCHOLAR_TIMED_PGN } from '../../review/testFixtures';
import { useGameStore } from '../../store/gameStore';
import { PlayerBar, playerBarLabel, useBoardPlayers } from './PlayerBar';

function Bars() {
  const p = useBoardPlayers();
  return (
    <>
      <PlayerBar side="black" player={p.black} position="top" />
      <PlayerBar side="white" player={p.white} position="bottom" />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetLive();
  useLichessAuth.setState({ username: undefined });
  useGameStore.getState().reset();
});

describe('PlayerBar', () => {
  it('imported game with %clk: static clocks follow the displayed ply (M22-1)', () => {
    act(() => {
      useGameStore.getState().loadPgn(SCHOLAR_TIMED_PGN);
      useGameStore.getState().goTo(0);
    });
    render(<Bars />);
    const white = () => screen.getByTestId('pgn-clock-white');
    const black = () => screen.getByTestId('pgn-clock-black');
    expect(white().textContent).toBe('1:00');
    expect(black().textContent).toBe('1:00');
    act(() => useGameStore.getState().goTo(4));
    expect(white().textContent).toBe('0:58');
    expect(black().textContent).toBe('0:40');
    act(() => useGameStore.getState().goTo(6));
    expect(black().textContent).toBe('0:05.0');
    expect(black().dataset.state).toBe('idle');
    // Low time relative to the 1-minute initial time (min(20 s, 6 s)).
    expect(black().className).toMatch(/clockLow/);
    expect(white().className).not.toMatch(/clockLow/);
    expect(screen.getByTestId('player-bar-top').getAttribute('aria-label')).toBe('Black: Bob, 0:05.0');
  });

  it('name, subtitle and a large clock; aria-label summarises the bar', () => {
    render(
      <PlayerBar
        side="black"
        position="top"
        player={{
          name: 'Stockfish',
          subtitle: '1500 Elo',
          clock: { ms: 299_000, state: 'running', initialMs: 300_000, testId: 'c' },
        }}
      />,
    );
    const bar = screen.getByRole('group', { name: 'Black: Stockfish · 1500 Elo, 4:59' });
    expect(bar.getAttribute('data-testid')).toBe('player-bar-top');
    expect(bar.className).toMatch(/barToMove/);
    const clock = screen.getByTestId('c');
    expect(clock.textContent).toBe('4:59');
    expect(clock.className).toMatch(/clockLarge/);
    expect(clock.getAttribute('data-state')).toBe('running');
  });

  it('without a clock: the name only, not highlighted', () => {
    render(<PlayerBar side="white" position="bottom" player={{ name: 'White' }} />);
    const bar = screen.getByRole('group', { name: 'White: White' });
    expect(bar.className).not.toMatch(/barToMove/);
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('flagged clocks are named in the label', () => {
    expect(playerBarLabel('white', { name: 'You', clock: { ms: 0, state: 'flagged' } })).toBe(
      'White: You, 0:00.0 (flagged)',
    );
  });

  it('PGN headers from the game store', () => {
    act(() =>
      useGameStore.setState({ headers: { White: 'Anna', WhiteElo: '2100', Black: 'Ben' } }),
    );
    render(<Bars />);
    expect(screen.getByRole('group', { name: 'White: Anna · 2100' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Black: Ben' })).toBeTruthy();
  });

  it('captured pieces of the current position in the capturing side\'s bar', () => {
    act(() => useGameStore.getState().loadFen('4kn2/8/8/8/8/8/4P3/4K3 w - - 0 1'));
    // A fake move whose position lost black's knight (only `fen` is read).
    act(() =>
      useGameStore.setState({
        moves: [{ fen: '4k3/8/8/8/8/8/4P3/4K3 b - - 0 1' } as never],
        ply: 1,
      }),
    );
    render(<Bars />);
    expect(screen.getByTestId('captured-white').getAttribute('aria-label')).toBe(
      'captured: 1 knight, +1',
    );
    expect(screen.queryByTestId('captured-black')).toBeNull();
  });

  it('live game: lichess names and a ticking clock of the side to move', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t0 = Date.now();
    const game: LiveGame = {
      id: 'g1',
      color: 'black',
      opponent: { name: 'Opp', rating: 1600 },
      rated: true,
      clock: { initial: 600_000, increment: 0 },
      speed: 'rapid',
      status: 'started',
      moves: ['e2e4', 'e7e5'],
      firstToMove: 'white',
      wtime: 598_000,
      btime: 597_000,
      lastStateAt: t0,
    };
    useLichessAuth.setState({ username: 'Me' });
    useLiveStore.setState({ status: 'playing', game });
    render(<Bars />);
    expect(screen.getByTestId('clock-black').textContent).toBe('9:57');
    expect(screen.getByRole('group', { name: /^Black: Me · You, 9:57$/ })).toBeTruthy();
    expect(screen.getByTestId('clock-white').getAttribute('data-state')).toBe('running');
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByTestId('clock-white').textContent).toBe('9:55');
    expect(screen.getByRole('group', { name: 'White: Opp · 1600, 9:55' })).toBeTruthy();
  });
});
