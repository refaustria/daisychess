import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type RoomStateMessage,
  type ServerMessage,
  type WelcomeMessage,
} from '@chesslab/engine-core';
import { buildApp, type BuildAppOptions } from '../app.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { fakeSpawner, registry, until } from '../../test/helpers.js';
import { TestClient } from '../../test/ws-client.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const apps: FastifyInstance[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    expect(c.invalid).toEqual([]);
    c.ws.terminate();
  }
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function start(
  config: Partial<Omit<ServerConfig, 'rooms'>> & { rooms?: Partial<ServerConfig['rooms']> } = {},
  extra: Partial<BuildAppOptions> = {},
): Promise<{ app: FastifyInstance; url: string }> {
  const base = loadConfig({});
  const app = await buildApp({
    config: { ...base, ...config, rooms: { ...base.rooms, ...config.rooms } },
    registry: registry({ id: 'fake', name: 'Fake Engine', maxInstances: 2 }),
    spawnEngine: fakeSpawner({ fake: ['--info-interval=3'] }),
    logger: false,
    ...extra,
  });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${port}/ws` };
}

async function client(
  url: string,
  token?: string,
): Promise<{ c: TestClient; welcome: WelcomeMessage }> {
  const c = await TestClient.connect(url);
  clients.push(c);
  c.send({
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'test' },
    ...(token ? { token } : {}),
  });
  const welcome = await c.waitFor((m): m is WelcomeMessage => m.type === 'welcome');
  return { c, welcome };
}

const isState = (m: ServerMessage): m is RoomStateMessage => m.type === 'room.state';

/** The next room.state after the ones seen so far. */
function nextState(
  c: TestClient,
  pred: (s: RoomStateMessage) => boolean = () => true,
): Promise<RoomStateMessage> {
  const seen = c.messages.length;
  return c.waitFor(
    (m): m is RoomStateMessage => isState(m) && c.messages.indexOf(m) >= seen && pred(m),
  );
}

async function createRoom(c: TestClient, extra: Record<string, unknown> = {}) {
  c.send({ type: 'room.create', nick: 'Alice', clock: null, color: 'white', ...extra });
  const seat = await c.waitFor((m) => m.type === 'room.seat');
  if (seat.type !== 'room.seat') throw new Error('no seat');
  await c.waitFor(isState);
  return seat;
}

async function game(url: string, extra: Record<string, unknown> = {}) {
  const { c: host } = await client(url);
  const seat = await createRoom(host, extra);
  const { c: guest } = await client(url);
  guest.send({ type: 'room.join', roomId: seat.roomId, nick: 'Bob' });
  const guestSeat = await guest.waitFor((m) => m.type === 'room.seat');
  await host.waitFor((m) => isState(m) && m.status === 'playing');
  await guest.waitFor((m) => isState(m) && m.status === 'playing');
  return {
    host,
    guest,
    roomId: seat.roomId,
    hostToken: seat.playerToken,
    guestToken: guestSeat.type === 'room.seat' ? guestSeat.playerToken : '',
  };
}

describe('rooms over /ws (ADR-013)', () => {
  it('a full game: create → join → moves → checkmate, with a spectator watching', async () => {
    const { url } = await start();
    const { c: host, welcome } = await client(url);
    expect(welcome.capabilities).toEqual({ analysis: true, rooms: true });
    const seat = await createRoom(host, {
      clock: { initialMs: 60_000, incrementMs: 1_000 },
      color: 'black',
    });
    expect(seat).toMatchObject({ type: 'room.seat', color: 'black' });
    expect(seat.roomId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(seat.playerToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(host.messages.find(isState)).toMatchObject({
      roomId: seat.roomId,
      status: 'waiting',
      you: 'black',
      players: { black: { nick: 'Alice', connected: true } },
      startFen: START,
      fen: START,
      moves: [],
      clock: { initialMs: 60_000, incrementMs: 1_000, white: 60_000, black: 60_000, running: null },
    });

    const { c: guest } = await client(url);
    guest.send({ type: 'room.join', roomId: seat.roomId, nick: '  Bob\u0000 ' });
    expect(await guest.waitFor((m) => m.type === 'room.seat')).toMatchObject({
      roomId: seat.roomId,
      color: 'white',
    });
    const started = await host.waitFor((m) => isState(m) && m.status === 'playing');
    expect(started).toMatchObject({
      players: {
        white: { nick: 'Bob', connected: true },
        black: { nick: 'Alice', connected: true },
      },
    });

    const { c: fan } = await client(url);
    fan.send({ type: 'room.join', roomId: seat.roomId });
    expect(await fan.waitFor(isState)).toMatchObject({
      you: 'spectator',
      spectators: 1,
      status: 'playing',
    });
    await host.waitFor((m) => isState(m) && m.spectators === 1);

    // Fool's mate: guest (White) gets mated.
    const moves = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
    for (const [i, uci] of moves.entries()) {
      const mover = i % 2 === 0 ? guest : host;
      mover.send({ type: 'room.move', roomId: seat.roomId, uci });
      const s = await nextState(mover, (st) => st.moves.length === i + 1);
      expect(s.moves).toEqual(moves.slice(0, i + 1));
      if (i === 1) expect(s.clock?.running).toBe('white');
      if (i === 0) expect(s.clock?.running).toBeNull();
    }
    for (const c of [host, guest, fan]) {
      const end = await c.waitFor((m) => isState(m) && m.status === 'finished');
      expect(end).toMatchObject({
        result: '0-1',
        reason: 'checkmate',
        moves,
        clock: { running: null },
      });
      expect(typeof (end as RoomStateMessage).serverTime).toBe('number');
    }
    // wrong-turn and illegal moves are answered with room.error to the sender only
    const { c: again } = await client(url);
    again.send({ type: 'room.move', roomId: seat.roomId, uci: 'e2e4' });
    expect(await again.waitFor((m) => m.type === 'room.error')).toMatchObject({
      roomId: seat.roomId,
      code: 'not_a_player',
    });
  });

  it('move validation errors: not_your_turn, illegal_move, bad_state (abort after move 2)', async () => {
    const { url } = await start();
    const { host, guest, roomId } = await game(url);
    guest.send({ type: 'room.move', roomId, uci: 'e7e5' });
    expect(await guest.waitFor((m) => m.type === 'room.error')).toMatchObject({
      code: 'not_your_turn',
    });
    host.send({ type: 'room.move', roomId, uci: 'e2e5' });
    expect(await host.waitFor((m) => m.type === 'room.error')).toMatchObject({
      code: 'illegal_move',
    });
    host.send({ type: 'room.move', roomId, uci: 'e2e4' });
    await nextState(guest, (s) => s.moves.length === 1);
    guest.send({ type: 'room.move', roomId, uci: 'e7e5' });
    await nextState(host, (s) => s.moves.length === 2);
    host.send({ type: 'room.abort', roomId });
    expect(
      await host.waitFor((m) => m.type === 'room.error' && m.code === 'bad_state'),
    ).toBeTruthy();
    host.send({ type: 'room.draw', roomId, action: 'offer' });
    expect((await nextState(guest, (s) => s.drawOffer === 'white')).drawOffer).toBe('white');
    guest.send({ type: 'room.draw', roomId, action: 'accept' });
    expect(await host.waitFor((m) => isState(m) && m.status === 'finished')).toMatchObject({
      result: '1/2-1/2',
      reason: 'agreement',
    });
  });

  it('reconnect: the player token re-takes the seat on a new socket; the clock kept running', async () => {
    const { url } = await start({ rooms: { claimGraceMs: 60_000 } });
    const { host, guest, roomId, guestToken } = await game(url, {
      clock: { initialMs: 60_000, incrementMs: 0 },
    });
    host.send({ type: 'room.move', roomId, uci: 'e2e4' });
    await nextState(guest, (s) => s.moves.length === 1);
    guest.send({ type: 'room.move', roomId, uci: 'e7e5' });
    await nextState(host, (s) => s.moves.length === 2);
    guest.ws.terminate();
    const gone = await nextState(host, (s) => s.players.black?.connected === false);
    expect(gone.claimableAt).toBeGreaterThan(gone.serverTime);
    expect(gone.claimableAt! - gone.serverTime).toBeLessThanOrEqual(60_000);
    host.send({ type: 'room.claim', roomId });
    expect(await host.waitFor((m) => m.type === 'room.error')).toMatchObject({
      code: 'bad_state',
      message: /claim in/,
    });

    const { c: back } = await client(url);
    back.send({ type: 'room.attach', roomId, playerToken: 'wrong'.padEnd(43, 'x') });
    expect(await back.waitFor((m) => m.type === 'room.error')).toMatchObject({
      code: 'bad_token',
      roomId,
    });
    back.send({ type: 'room.attach', roomId, playerToken: guestToken });
    const s = await back.waitFor(isState);
    expect(s).toMatchObject({
      you: 'black',
      status: 'playing',
      moves: ['e2e4', 'e7e5'],
      players: { black: { connected: true } },
    });
    expect(s.claimableAt).toBeUndefined();
    expect(s.clock?.running).toBe('white');
    host.send({ type: 'room.move', roomId, uci: 'g1f3' });
    await nextState(back, (st) => st.moves.length === 3);
    back.send({ type: 'room.move', roomId, uci: 'b8c6' });
    await nextState(host, (st) => st.moves.length === 4);
  });

  it('claim after the grace period wins; the server pushes a snapshot when it becomes possible', async () => {
    const { url } = await start({ rooms: { claimGraceMs: 300 } });
    const { host, guest, roomId } = await game(url);
    host.send({ type: 'room.move', roomId, uci: 'e2e4' });
    await nextState(guest, (s) => s.moves.length === 1);
    guest.send({ type: 'room.move', roomId, uci: 'e7e5' });
    await nextState(host, (s) => s.moves.length === 2);
    guest.send({ type: 'room.leave', roomId });
    const gone = await nextState(host, (s) => s.players.black?.connected === false);
    const passed = await nextState(host, (s) => s.serverTime >= (gone.claimableAt ?? Infinity));
    expect(passed.players.black?.connected).toBe(false);
    host.send({ type: 'room.claim', roomId });
    expect(await host.waitFor((m) => isState(m) && m.status === 'finished')).toMatchObject({
      result: '1-0',
      reason: 'abandoned',
    });
  });

  it('a waiting room expires and the link dies; room creation is rate limited per address', async () => {
    const { url } = await start({
      rooms: { waitingTtlMs: 1_000, createRateLimit: { max: 2, windowMs: 60_000 } },
    });
    const { c: host } = await client(url);
    const seat = await createRoom(host);
    expect(await host.waitFor((m) => isState(m) && m.status === 'finished')).toMatchObject({
      reason: 'abandoned',
    });
    const { c: late } = await client(url);
    late.send({ type: 'room.join', roomId: seat.roomId, nick: 'Late' });
    expect(await late.waitFor((m) => m.type === 'room.error')).toMatchObject({
      code: 'room_not_found',
    });
    await createRoom(host);
    host.send({ type: 'room.create', nick: 'Alice', clock: null, color: 'white' });
    expect(await host.waitFor((m) => m.type === 'room.error')).toMatchObject({
      code: 'too_many_rooms',
    });
  });

  it('envelope errors stay on `error`: invalid room messages and the room rate limit', async () => {
    const { url } = await start({}, { connection: { roomRateLimit: { max: 3, windowMs: 1_000 } } });
    const { c } = await client(url);
    c.send({ type: 'room.create', nick: '', clock: null, color: 'white' });
    expect(await c.waitFor((m) => m.type === 'error')).toMatchObject({
      code: 'invalid_message',
      message: /nick must not be empty/,
    });
    c.send({ type: 'room.move', roomId: 'short', uci: 'e2e4' });
    await until(() => c.messages.filter((m) => m.type === 'error').length === 2);
    for (let i = 0; i < 4; i++) c.send({ type: 'room.leave', roomId: 'x'.repeat(22) });
    expect(await c.waitFor((m) => m.type === 'error' && m.code === 'rate_limited')).toBeTruthy();
    expect(c.messages.filter((m) => m.type === 'room.error').length).toBe(3);
  });

  it('fair play: a player cannot analyze while the game runs; sessions are dropped at game start', async () => {
    const { url } = await start();
    const { c: host } = await client(url);
    host.send({ type: 'analyze', sessionId: 's', searchId: 1, engine: 'fake', fen: START }); // infinite
    await host.waitFor((m) => m.type === 'info');
    const seat = await createRoom(host);
    host.send({
      type: 'analyze',
      sessionId: 's',
      searchId: 2,
      engine: 'fake',
      fen: START,
      depth: 2,
    });
    await host.terminal('s', 2); // waiting room: analysis still allowed
    const { c: guest } = await client(url);
    guest.send({ type: 'room.join', roomId: seat.roomId, nick: 'Bob' });
    await host.waitFor((m) => isState(m) && m.status === 'playing');
    await host.waitFor((m) => m.type === 'bestmove' && m.searchId === 1); // the infinite search was stopped
    host.send({
      type: 'analyze',
      sessionId: 's',
      searchId: 3,
      engine: 'fake',
      fen: START,
      depth: 2,
    });
    expect(await host.terminal('s', 3)).toMatchObject({
      type: 'error',
      code: 'forbidden',
      sessionId: 's',
      searchId: 3,
    });
    guest.send({
      type: 'analyze',
      sessionId: 'g',
      searchId: 1,
      engine: 'fake',
      fen: START,
      depth: 2,
    });
    expect(await guest.terminal('g', 1)).toMatchObject({ type: 'error', code: 'forbidden' });
    host.send({ type: 'room.resign', roomId: seat.roomId });
    await host.waitFor((m) => isState(m) && m.status === 'finished');
    host.send({
      type: 'analyze',
      sessionId: 's',
      searchId: 4,
      engine: 'fake',
      fen: START,
      depth: 2,
    });
    expect(await host.terminal('s', 4)).toMatchObject({ type: 'bestmove' });
  });

  it('closing the socket leaves the room; a second room per connection leaves the first', async () => {
    const { url } = await start();
    const { host, guest, roomId } = await game(url);
    host.send({ type: 'room.create', nick: 'Alice', clock: null, color: 'white' });
    await nextState(guest, (s) => s.roomId === roomId && s.players.white?.connected === false);
    host.ws.terminate();
    const { app } = { app: apps[0]! };
    await until(() => app.chesslab.ws.rooms.stats().members === 1);
    expect(app.chesslab.ws.rooms.stats()).toMatchObject({ rooms: 2, waiting: 1, playing: 1 });
    const res = await app.inject({ method: 'GET', url: '/health/detail' });
    expect(res.json()).toMatchObject({ rooms: { rooms: 2, members: 1 } });
  });

  describe('access token (ADR-010, restricted mode of ADR-013)', () => {
    it('without or with a wrong token: restricted welcome, rooms work, analyze is unauthorized', async () => {
      const { url } = await start({ accessToken: 'secret-token' });
      for (const token of [undefined, 'wrong', 'secret-token ', '']) {
        const { c, welcome } = await client(url, token);
        expect(welcome.engines).toEqual([]);
        expect(welcome.capabilities).toEqual({ analysis: false, rooms: true });
        expect(welcome.limits.maxDepth).toBe(30);
        c.send({
          type: 'analyze',
          sessionId: 's',
          searchId: 1,
          engine: 'fake',
          fen: START,
          depth: 2,
        });
        expect(await c.terminal('s', 1)).toMatchObject({
          type: 'error',
          code: 'unauthorized',
          sessionId: 's',
          searchId: 1,
        });
        expect(c.closeCode).toBeNull();
        const seat = await createRoom(c);
        expect(seat.type).toBe('room.seat');
      }
      // a restricted host and a full-access guest can play each other
      const { c: host } = await client(url);
      const seat = await createRoom(host);
      const { c: guest, welcome } = await client(url, 'secret-token');
      expect(welcome.capabilities).toEqual({ analysis: true, rooms: true });
      expect(welcome.engines.map((e) => e.id)).toEqual(['fake']);
      guest.send({ type: 'room.join', roomId: seat.roomId, nick: 'Bob' });
      await host.waitFor((m) => isState(m) && m.status === 'playing');
      host.send({ type: 'room.move', roomId: seat.roomId, uci: 'e2e4' });
      await nextState(guest, (s) => s.moves.length === 1);
    });
  });
});
