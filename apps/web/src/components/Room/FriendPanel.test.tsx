// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayStore } from '../../play/playStore';
import { configureRoom, resetRoom, useRoomStore } from '../../room/roomStore';
import { fakeSockets, ROOM_ID, roomState, settle, TOKEN_A } from '../../room/testing';
import { NICK_KEY, writeSeat } from '../../room/storage';
import type { RoomStateMessage } from '@chesslab/engine-core';
import { useGameStore } from '../../store/gameStore';
import { PlayerBar, useBoardPlayers } from '../PlayerBar/PlayerBar';
import { FriendPanel } from './FriendPanel';

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

let net: ReturnType<typeof fakeSockets>;

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  net = fakeSockets();
  configureRoom({ createSocket: net.create, reconnectDelay: () => 0 });
  useGameStore.getState().reset();
  usePlayStore.setState({ mode: 'idle' });
});

afterEach(() => {
  cleanup();
  resetRoom();
});

const emit = (m: Parameters<ReturnType<typeof net.last>['emit']>[0]) => act(() => net.last().emit(m));

async function created() {
  render(
    <>
      <Bars />
      <FriendPanel />
    </>,
  );
  fireEvent.change(screen.getByTestId('friend-nick'), { target: { value: 'Alice' } });
  fireEvent.click(screen.getByRole('radio', { name: 'White' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Time control' }), { target: { value: 'none' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
  await act(() => settle());
  expect(net.last().ofType('room.create')).toEqual([
    { type: 'room.create', nick: 'Alice', clock: null, color: 'white' },
  ]);
  emit({ type: 'room.seat', roomId: ROOM_ID, playerToken: TOKEN_A, color: 'white' });
  emit(roomState({ status: 'waiting', players: { white: { nick: 'Alice', connected: true } } }));
}

describe('FriendPanel', () => {
  it('create form: nickname required, creates the link, shows it with Copy and waiting', async () => {
    render(<FriendPanel />);
    expect((screen.getByRole('button', { name: 'Create link' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    await created();
    expect((screen.getByTestId('friend-link') as HTMLInputElement).value).toBe(`${location.origin}/#/room/${ROOM_ID}`);
    expect(screen.getByTestId('friend-waiting').textContent).toContain('Waiting for your friend…');
    expect(screen.getByTestId('player-bar-bottom').textContent).toContain('Alice');
    expect(screen.getByTestId('player-bar-top').textContent).toContain('Waiting for your friend…');
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fireEvent.click(screen.getByTestId('friend-copy'));
    await act(() => settle());
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/#/room/${ROOM_ID}`);
    expect(screen.getByTestId('friend-copy').textContent).toContain('Copied!');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel link' }));
    expect(net.last().ofType('room.abort')).toHaveLength(1);
  });

  it('playing: opponent, draw offer, abort → resign, claim countdown and button', async () => {
    await created();
    emit(roomState());
    expect(screen.getByTestId('friend-opponent').textContent).toContain('Bob');
    expect(screen.getByTestId('friend-status').textContent).toContain('Your move');
    expect(screen.getByRole('button', { name: 'Abort' })).toBeTruthy();
    emit(roomState({ moves: ['e2e4', 'e7e5'], drawOffer: 'black' }));
    expect(screen.getByText('Bob offers a draw.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(net.last().ofType('room.draw')).toEqual([{ type: 'room.draw', roomId: ROOM_ID, action: 'accept' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Resign' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, resign' }));
    expect(net.last().ofType('room.resign')).toHaveLength(1);

    const gone: RoomStateMessage = roomState({
      moves: ['e2e4', 'e7e5'],
      players: { white: { nick: 'Alice', connected: true }, black: { nick: 'Bob', connected: false } },
    });
    emit({ ...gone, claimableAt: gone.serverTime + 42_000 });
    expect(screen.getByTestId('friend-claim').textContent).toContain('Bob disconnected, claim in 42 s');
    expect(screen.queryByRole('button', { name: 'Claim victory' })).toBeNull();
    expect(screen.getByTestId('player-bar-top').textContent).toContain('disconnected');
    const ready = roomState({ ...gone, serverTime: gone.serverTime + 42_001 });
    emit({ ...ready, claimableAt: gone.serverTime + 42_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Claim victory' }));
    expect(net.last().ofType('room.claim')).toHaveLength(1);
  });

  it('finished: result with reason and play again', async () => {
    await created();
    emit(roomState({ moves: ['e2e4', 'e7e5'], status: 'finished', result: '1-0', reason: 'resign' }));
    expect(screen.getByTestId('friend-result').textContent).toContain('1-0');
    expect(screen.getByTestId('friend-result-text').textContent).toContain('You won — resignation');
    fireEvent.click(screen.getByRole('button', { name: 'Play again (new link)' }));
    await act(() => settle());
    expect(net.last().ofType('room.create').at(-1)).toMatchObject({ color: 'black', nick: 'Alice' });
  });

  it('join card prefilled from the stored nickname; a full room means watching', async () => {
    localStorage.setItem(NICK_KEY, 'Carol');
    resetRoom();
    configureRoom({ createSocket: net.create, reconnectDelay: () => 0 });
    act(() => useRoomStore.getState().openLink(ROOM_ID));
    render(<FriendPanel />);
    expect((screen.getByTestId('friend-nick') as HTMLInputElement).value).toBe('Carol');
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await act(() => settle());
    expect(net.last().ofType('room.join')).toEqual([{ type: 'room.join', roomId: ROOM_ID, nick: 'Carol' }]);
    emit(roomState({ you: 'spectator', spectators: 1 }));
    expect(screen.getByTestId('friend-watching').textContent).toContain('Watching Alice vs Bob');
  });

  it('expired link and reconnect states', async () => {
    writeSeat(ROOM_ID, { playerToken: TOKEN_A, color: 'white', nick: 'Alice' });
    act(() => useRoomStore.getState().openLink(ROOM_ID));
    render(<FriendPanel />);
    expect(screen.getByText('Reconnecting to your game…')).toBeTruthy();
    await act(() => settle());
    emit({ type: 'room.error', roomId: ROOM_ID, code: 'room_not_found', message: 'gone' });
    expect(screen.getByTestId('friend-expired').textContent).toContain('This game link has expired');
  });

  it('clocks in the player bars', async () => {
    await created();
    emit(
      roomState({
        moves: ['e2e4', 'e7e5'],
        clock: { initialMs: 300_000, incrementMs: 0, white: 299_000, black: 287_000, running: 'white' },
      }),
    );
    expect(screen.getByTestId('friend-clock-white').textContent).toMatch(/4:5\d/);
    expect(screen.getByTestId('friend-clock-black').textContent).toContain('4:47');
  });
});
