import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomStateMessage, ServerMessage } from '@chesslab/engine-core';
import {
  DEFAULT_ROOM_CONFIG,
  RoomManager,
  newPlayerToken,
  newRoomId,
  type RoomClient,
  type RoomConfig,
} from './RoomManager.js';

class FakeClient implements RoomClient {
  static nextId = 1;
  readonly id = FakeClient.nextId++;
  readonly msgs: ServerMessage[] = [];
  started = 0;
  constructor(readonly ip = '10.0.0.1') {}
  deliver(msg: ServerMessage): void {
    this.msgs.push(msg);
  }
  onGameStarted(): void {
    this.started++;
  }
  /** Last message of a type. */
  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> {
    const m = [...this.msgs].reverse().find((x) => x.type === type);
    if (!m) throw new Error(`no ${type} in ${JSON.stringify(this.msgs.slice(-3))}`);
    return m as Extract<ServerMessage, { type: T }>;
  }
  state(): RoomStateMessage {
    return this.last('room.state');
  }
  seat() {
    return this.last('room.seat');
  }
  count(type: ServerMessage['type']): number {
    return this.msgs.filter((m) => m.type === type).length;
  }
}

const CFG: RoomConfig = {
  ...DEFAULT_ROOM_CONFIG,
  maxRooms: 3,
  maxSpectators: 2,
  createRateLimit: { max: 2, windowMs: 10_000 },
  waitingTtlMs: 100_000,
  finishedTtlMs: 50_000,
  idleTtlMs: 500_000,
  claimGraceMs: 60_000,
};

let clock: { t: number };
let wall: { t: number };
let mgr: RoomManager;
let ids: { rooms: number; tokens: number };

const silent = { info() {}, warn() {}, error() {}, debug() {} };

beforeEach(() => {
  vi.useFakeTimers();
  clock = { t: 1_000 };
  wall = { t: 1_700_000_000_000 };
  ids = { rooms: 0, tokens: 0 };
  mgr = new RoomManager({
    config: CFG,
    logger: silent,
    now: () => clock.t,
    wallNow: () => wall.t,
    newRoomId: () => `room${String(++ids.rooms).padStart(18, '0')}`,
    newPlayerToken: () => `tok${String(++ids.tokens).padStart(40, '0')}`,
    random: () => 0.9,
  });
});

afterEach(() => {
  mgr.close();
  vi.useRealTimers();
});

/** Advances the injected clocks and the fake timers together. */
function advance(ms: number): void {
  clock.t += ms;
  wall.t += ms;
  vi.advanceTimersByTime(ms);
}

function create(
  client: FakeClient,
  extra: Partial<{
    color: 'white' | 'black' | 'random';
    clock: { initialMs: number; incrementMs: number } | null;
  }> = {},
) {
  mgr.handle(client, { type: 'room.create', nick: 'Host', clock: null, color: 'white', ...extra });
  return client.seat().roomId;
}

function game(): { host: FakeClient; guest: FakeClient; roomId: string } {
  const host = new FakeClient();
  const guest = new FakeClient('10.0.0.2');
  const roomId = create(host);
  mgr.handle(guest, { type: 'room.join', roomId, nick: 'Guest' });
  return { host, guest, roomId };
}

describe('RoomManager: create and join', () => {
  it('create answers room.seat + room.state; ids and tokens are generated', () => {
    const host = new FakeClient();
    create(host, { color: 'random' });
    expect(host.msgs.map((m) => m.type)).toEqual(['room.seat', 'room.state']);
    expect(host.seat()).toEqual({
      type: 'room.seat',
      roomId: 'room000000000000000001',
      playerToken: 'tok' + '0'.repeat(39) + '1',
      color: 'black',
    });
    expect(host.state()).toMatchObject({
      status: 'waiting',
      you: 'black',
      players: { black: { nick: 'Host', connected: true } },
      serverTime: wall.t,
    });
    expect(mgr.stats()).toEqual({ rooms: 1, waiting: 1, playing: 0, finished: 0, members: 1 });
    expect(newRoomId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newPlayerToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newPlayerToken()).not.toBe(newPlayerToken());
  });

  it('join takes the free seat, starts the game, tells both players (and their connections)', () => {
    const { host, guest, roomId } = game();
    expect(guest.seat()).toMatchObject({ roomId, color: 'black' });
    expect(guest.seat().playerToken).not.toBe(host.seat().playerToken);
    expect(host.state()).toMatchObject({
      status: 'playing',
      you: 'white',
      players: { white: { nick: 'Host' }, black: { nick: 'Guest' } },
    });
    expect(guest.state()).toMatchObject({ status: 'playing', you: 'black' });
    expect(host.started).toBe(1);
    expect(guest.started).toBe(1);
    expect(mgr.isPlaying(host)).toBe(true);
    expect(mgr.isPlaying(guest)).toBe(true);
  });

  it('join of an unknown room → room_not_found', () => {
    const c = new FakeClient();
    mgr.handle(c, { type: 'room.join', roomId: 'x'.repeat(22), nick: 'A' });
    expect(c.msgs).toEqual([
      {
        type: 'room.error',
        roomId: 'x'.repeat(22),
        code: 'room_not_found',
        message: expect.any(String),
      },
    ]);
  });

  it('spectators: without a nick, or when the seats are taken; capped with room_full', () => {
    const host = new FakeClient();
    const roomId = create(host);
    const lurker = new FakeClient();
    mgr.handle(lurker, { type: 'room.join', roomId });
    expect(lurker.state()).toMatchObject({ you: 'spectator', status: 'waiting', spectators: 1 });
    expect(lurker.count('room.seat')).toBe(0);
    expect(host.state().spectators).toBe(1);
    const guest = new FakeClient();
    mgr.handle(guest, { type: 'room.join', roomId, nick: 'Guest' });
    expect(guest.state().you).toBe('black');
    expect(lurker.state().status).toBe('playing');
    expect(lurker.started).toBe(0);
    const late = new FakeClient();
    mgr.handle(late, { type: 'room.join', roomId, nick: 'Late' });
    expect(late.state()).toMatchObject({ you: 'spectator', spectators: 2 });
    const over = new FakeClient();
    mgr.handle(over, { type: 'room.join', roomId, nick: 'Over' });
    expect(over.msgs).toEqual([
      { type: 'room.error', roomId, code: 'room_full', message: expect.any(String) },
    ]);
    expect(mgr.isPlaying(lurker)).toBe(false);
    // a spectator cannot act
    mgr.handle(lurker, { type: 'room.move', roomId, uci: 'e2e4' });
    expect(lurker.last('room.error').code).toBe('not_a_player');
  });

  it('joining a room one is already in just resends the state', () => {
    const { host, roomId } = game();
    const n = host.msgs.length;
    mgr.handle(host, { type: 'room.join', roomId, nick: 'Again' });
    expect(host.msgs.length).toBe(n + 1);
    expect(host.state().you).toBe('white');
    expect(host.state().players.white?.nick).toBe('Host');
  });

  it('a connection is in one room at a time: creating another leaves the first', () => {
    const { host, guest, roomId } = game();
    const second = create(host);
    expect(second).not.toBe(roomId);
    expect(guest.state().players.white?.connected).toBe(false);
    expect(guest.state().claimableAt).toBe(wall.t + CFG.claimGraceMs);
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' });
    expect(host.last('room.error').code).toBe('not_a_player');
  });

  it('limits: creation rate per address and the room cap → too_many_rooms', () => {
    const a = new FakeClient('1.1.1.1');
    create(a);
    create(a);
    mgr.handle(a, { type: 'room.create', nick: 'H', clock: null, color: 'white' });
    expect(a.last('room.error')).toMatchObject({ code: 'too_many_rooms', message: /address/ });
    const b = new FakeClient('2.2.2.2');
    create(b); // 3 rooms = cap
    const c = new FakeClient('3.3.3.3');
    mgr.handle(c, { type: 'room.create', nick: 'H', clock: null, color: 'white' });
    expect(c.last('room.error')).toMatchObject({
      code: 'too_many_rooms',
      message: /no free rooms/,
    });
    advance(10_000); // rate window over, but the cap still holds
    mgr.handle(a, { type: 'room.create', nick: 'H', clock: null, color: 'white' });
    expect(a.last('room.error').message).toMatch(/no free rooms/);
  });
});

describe('RoomManager: playing', () => {
  it('moves are validated and broadcast; errors go to the sender only', () => {
    const { host, guest, roomId } = game();
    mgr.handle(guest, { type: 'room.move', roomId, uci: 'e7e5' });
    expect(guest.last('room.error')).toMatchObject({ roomId, code: 'not_your_turn' });
    expect(host.count('room.error')).toBe(0);
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' });
    expect(host.state().moves).toEqual(['e2e4']);
    expect(guest.state().moves).toEqual(['e2e4']);
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' });
    expect(host.last('room.error').code).toBe('not_your_turn');
    mgr.handle(guest, { type: 'room.move', roomId, uci: 'e7e6' });
    mgr.handle(guest, { type: 'room.move', roomId, uci: 'e7e6' });
    expect(guest.last('room.error').code).toBe('not_your_turn');
  });

  it('draw offers, resign, abort', () => {
    const { host, guest, roomId } = game();
    mgr.handle(host, { type: 'room.draw', roomId, action: 'offer' });
    expect(guest.state().drawOffer).toBe('white');
    mgr.handle(guest, { type: 'room.draw', roomId, action: 'decline' });
    expect(host.state().drawOffer).toBeUndefined();
    mgr.handle(host, { type: 'room.abort', roomId });
    expect(guest.state()).toMatchObject({ status: 'finished', reason: 'abort' });
    expect(guest.state().result).toBeUndefined();
    expect(mgr.isPlaying(host)).toBe(false);
    expect(mgr.stats().finished).toBe(1);
    const g2 = game();
    mgr.handle(g2.guest, { type: 'room.resign', roomId: g2.roomId });
    expect(g2.host.state()).toMatchObject({ status: 'finished', result: '1-0', reason: 'resign' });
  });

  it('the flag timer ends the game and broadcasts timeout', () => {
    const host = new FakeClient();
    const roomId = create(host, { clock: { initialMs: 30_000, incrementMs: 0 } });
    const guest = new FakeClient();
    mgr.handle(guest, { type: 'room.join', roomId, nick: 'G' });
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' });
    mgr.handle(guest, { type: 'room.move', roomId, uci: 'e7e5' });
    expect(host.state().clock).toMatchObject({ white: 30_000, running: 'white' });
    advance(29_999);
    expect(host.state().status).toBe('playing');
    advance(1);
    expect(host.state()).toMatchObject({
      status: 'finished',
      result: '0-1',
      reason: 'timeout',
      clock: { white: 0, running: null },
    });
    expect(guest.state().reason).toBe('timeout');
  });

  it('a late move after the flag publishes the timeout before the error', () => {
    const host = new FakeClient();
    const roomId = create(host, { clock: { initialMs: 30_000, incrementMs: 0 } });
    const guest = new FakeClient();
    mgr.handle(guest, { type: 'room.join', roomId, nick: 'G' });
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' });
    mgr.handle(guest, { type: 'room.move', roomId, uci: 'e7e5' });
    clock.t += 31_000; // the timer has not fired yet (fake timers not advanced)
    mgr.handle(host, { type: 'room.move', roomId, uci: 'g1f3' });
    const types = host.msgs.slice(-2).map((m) => m.type);
    expect(types).toEqual(['room.state', 'room.error']);
    expect(host.state().reason).toBe('timeout');
    expect(guest.state().reason).toBe('timeout');
  });
});

describe('RoomManager: disconnect, attach, claim', () => {
  it('disconnect marks the player gone; the opponent sees claimableAt and a snapshot when it passes', () => {
    const { host, guest, roomId } = game();
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' });
    mgr.handle(guest, { type: 'room.move', roomId, uci: 'e7e5' });
    mgr.disconnect(guest);
    expect(host.state()).toMatchObject({
      players: { black: { connected: false } },
      claimableAt: wall.t + 60_000,
    });
    mgr.handle(host, { type: 'room.claim', roomId });
    expect(host.last('room.error')).toMatchObject({
      code: 'bad_state',
      message: 'you can claim in 60 s',
    });
    const n = host.count('room.state');
    advance(60_000);
    expect(host.count('room.state')).toBe(n + 1);
    expect(host.state().claimableAt).toBe(wall.t);
    mgr.handle(host, { type: 'room.claim', roomId });
    expect(host.state()).toMatchObject({ status: 'finished', result: '1-0', reason: 'abandoned' });
    // the guest's connection is gone: nothing more is delivered to it
    expect(guest.state().status).toBe('playing');
  });

  it('attach by token re-takes the seat on a new connection; a wrong token is refused', () => {
    const { host, guest, roomId } = game();
    const token = guest.seat().playerToken;
    mgr.disconnect(guest);
    const again = new FakeClient();
    mgr.handle(again, { type: 'room.attach', roomId, playerToken: 'wrong'.padEnd(43, 'x') });
    expect(again.last('room.error')).toMatchObject({ roomId, code: 'bad_token' });
    mgr.handle(again, { type: 'room.attach', roomId: 'y'.repeat(22), playerToken: token });
    expect(again.last('room.error').code).toBe('room_not_found');
    mgr.handle(again, { type: 'room.attach', roomId, playerToken: token });
    expect(again.state()).toMatchObject({ you: 'black', players: { black: { connected: true } } });
    expect(again.state().claimableAt).toBeUndefined();
    expect(again.count('room.seat')).toBe(0);
    expect(host.state().players.black?.connected).toBe(true);
    mgr.handle(again, { type: 'room.move', roomId, uci: 'e7e5' });
    expect(again.last('room.error').code).toBe('not_your_turn');
    expect(mgr.isPlaying(again)).toBe(true);
  });

  it('attach while the old connection is still there demotes it to spectator', () => {
    const { host, guest, roomId } = game();
    const tab2 = new FakeClient();
    mgr.handle(tab2, { type: 'room.attach', roomId, playerToken: host.seat().playerToken });
    expect(tab2.state().you).toBe('white');
    expect(host.state().you).toBe('spectator');
    expect(guest.state().players.white?.connected).toBe(true);
    expect(guest.state().spectators).toBe(1);
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' });
    expect(host.last('room.error').code).toBe('not_a_player');
    mgr.handle(tab2, { type: 'room.move', roomId, uci: 'e2e4' });
    expect(guest.state().moves).toEqual(['e2e4']);
    // the demoted tab closing does not mark the seat disconnected
    mgr.disconnect(host);
    expect(guest.state().players.white?.connected).toBe(true);
    // attach of the seat one already holds just resends the state
    const n = tab2.msgs.length;
    mgr.handle(tab2, { type: 'room.attach', roomId, playerToken: host.seat().playerToken });
    expect(tab2.msgs.length).toBe(n + 1);
  });

  it('leave: a player is marked disconnected and can come back; wrong room → room_not_found', () => {
    const { host, guest, roomId } = game();
    mgr.handle(guest, { type: 'room.leave', roomId: 'z'.repeat(22) });
    expect(guest.last('room.error').code).toBe('room_not_found');
    mgr.handle(guest, { type: 'room.leave', roomId });
    expect(host.state().players.black?.connected).toBe(false);
    expect(mgr.stats().members).toBe(1);
    mgr.handle(guest, { type: 'room.attach', roomId, playerToken: guest.seat().playerToken });
    expect(host.state().players.black?.connected).toBe(true);
  });

  it('both players gone: the game is abandoned after the grace period', () => {
    const { host, guest, roomId } = game();
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' });
    mgr.disconnect(host);
    advance(10_000);
    mgr.disconnect(guest);
    advance(59_999);
    expect(mgr.stats().playing).toBe(1);
    advance(1);
    expect(mgr.stats()).toMatchObject({ playing: 0, finished: 1 });
    // finished TTL: the room disappears
    advance(CFG.finishedTtlMs);
    expect(mgr.stats().rooms).toBe(0);
    const back = new FakeClient();
    mgr.handle(back, { type: 'room.attach', roomId, playerToken: host.seat().playerToken });
    expect(back.last('room.error').code).toBe('room_not_found');
  });
});

describe('RoomManager: TTLs', () => {
  it('a waiting room expires: the host learns it, the link is dead', () => {
    const host = new FakeClient();
    const roomId = create(host);
    advance(CFG.waitingTtlMs - 1);
    expect(mgr.stats().waiting).toBe(1);
    advance(1);
    expect(host.state()).toMatchObject({ status: 'finished', reason: 'abandoned' });
    expect(mgr.stats().rooms).toBe(0);
    const guest = new FakeClient();
    mgr.handle(guest, { type: 'room.join', roomId, nick: 'G' });
    expect(guest.last('room.error').code).toBe('room_not_found');
  });

  it('a playing room without moves expires into abandoned, then is deleted', () => {
    const { host, guest, roomId } = game();
    advance(CFG.idleTtlMs - 1);
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' }); // activity resets the TTL
    advance(CFG.idleTtlMs - 1);
    expect(mgr.stats().playing).toBe(1);
    advance(1);
    expect(guest.state()).toMatchObject({
      status: 'finished',
      reason: 'abandoned',
      moves: ['e2e4'],
    });
    expect(mgr.stats().finished).toBe(1);
    advance(CFG.finishedTtlMs);
    expect(mgr.stats().rooms).toBe(0);
  });

  it('a finished room is kept for the finished TTL (reconnect sees the result), then deleted', () => {
    const { host, guest, roomId } = game();
    mgr.handle(host, { type: 'room.resign', roomId });
    mgr.disconnect(host);
    mgr.disconnect(guest);
    advance(CFG.finishedTtlMs - 1);
    const back = new FakeClient();
    mgr.handle(back, { type: 'room.attach', roomId, playerToken: host.seat().playerToken });
    expect(back.state()).toMatchObject({
      status: 'finished',
      result: '0-1',
      reason: 'resign',
      you: 'white',
    });
    advance(1);
    expect(mgr.stats().rooms).toBe(0);
  });

  it('close() drops everything and ignores further requests', () => {
    const { host, roomId } = game();
    mgr.close();
    expect(mgr.stats().rooms).toBe(0);
    const n = host.msgs.length;
    mgr.handle(host, { type: 'room.move', roomId, uci: 'e2e4' });
    expect(host.msgs.length).toBe(n);
    expect(vi.getTimerCount()).toBe(0);
  });
});
