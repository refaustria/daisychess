import type { RoomStateMessage, WelcomeMessage } from '@daisychess/engine-core';
import { FakeWebSocket, TEST_WELCOME } from '../engine/remoteTesting';
import { START_FEN } from '../store/gameStore';

export const ROOM_ID = 'Room_0123456789abcdef';
export const TOKEN_A = 'tokA_0123456789abcdefghijklmnopqrstuvwxyz0';
export const TOKEN_B = 'tokB_0123456789abcdefghijklmnopqrstuvwxyz0';

/** A welcome of a server with rooms (restricted: no token sent). */
export const ROOM_WELCOME: WelcomeMessage = {
  ...TEST_WELCOME,
  engines: [],
  capabilities: { analysis: false, rooms: true },
};

let serverTime = 1_000_000;

/** A `room.state` with defaults (playing, Alice white vs Bob black, user = white, no clock). */
export function roomState(p: Partial<RoomStateMessage> = {}): RoomStateMessage {
  serverTime += 10;
  return {
    type: 'room.state',
    roomId: ROOM_ID,
    status: 'playing',
    players: { white: { nick: 'Alice', connected: true }, black: { nick: 'Bob', connected: true } },
    you: 'white',
    spectators: 0,
    startFen: START_FEN,
    fen: START_FEN,
    moves: [],
    clock: null,
    serverTime,
    ...p,
  };
}

/** Collects the fake sockets the room connection creates; each answers `hello` with `welcome`. */
export function fakeSockets(welcome: WelcomeMessage = ROOM_WELCOME) {
  const sockets: FakeWebSocket[] = [];
  return {
    sockets,
    create: (url: string): FakeWebSocket => {
      const s = new FakeWebSocket(url);
      s.welcome = welcome;
      sockets.push(s);
      return s;
    },
    last: (): FakeWebSocket => sockets.at(-1)!,
  };
}

/** Lets microtasks and zero-delay timers run. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}
