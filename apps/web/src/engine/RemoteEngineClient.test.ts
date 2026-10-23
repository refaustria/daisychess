import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type EngineInfo } from '@chesslab/engine-core';
import { RemoteEngineClient, RemoteEngineError, randomSessionId, type RemoteEngineClientOptions } from './RemoteEngineClient';
import { FakeWebSocket, TEST_WELCOME } from './remoteTesting';
import { flush } from './testing';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const BLACK_TO_MOVE = '4k3/8/8/8/8/8/4Q3/4K3 b - - 0 1';

function setup(opts: Partial<RemoteEngineClientOptions> = {}, configure?: (s: FakeWebSocket) => void) {
  const sockets: FakeWebSocket[] = [];
  const client = new RemoteEngineClient({
    url: 'ws://test/ws',
    createSocket: (url) => {
      const s = new FakeWebSocket(url);
      configure?.(s);
      sockets.push(s);
      return s;
    },
    ...opts,
  });
  return { client, sockets, socket: () => sockets.at(-1)! };
}

async function loaded(opts: Partial<RemoteEngineClientOptions> = {}) {
  const env = setup(opts);
  await env.client.load();
  return env;
}

const info = (depth: number, cp: number, pv = ['e2e4']): EngineInfo => ({ depth, multipv: 1, score: { cp }, pv });

async function collect(it: AsyncIterable<EngineInfo>): Promise<EngineInfo[]> {
  const out: EngineInfo[] = [];
  for await (const i of it) out.push(i);
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('randomSessionId', () => {
  it('produces 16 characters of the protocol alphabet', () => {
    const ids = new Set(Array.from({ length: 50 }, randomSessionId));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
});

describe('RemoteEngineClient handshake', () => {
  it('sends hello, stores welcome and selects the first enabled engine', async () => {
    const statuses: string[] = [];
    const { client, socket } = setup({ clientInfo: { name: 'test', version: '1' } });
    client.onStatus((s) => statuses.push(s));
    expect(client.status).toBe('idle');
    await client.load();
    expect(socket().url).toBe('ws://test/ws');
    expect(socket().sent).toEqual([
      { type: 'hello', protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '1' } },
    ]);
    expect(statuses).toEqual(['connecting', 'ready']);
    expect(client.engineName).toBe('Stockfish 19');
    expect(client.engineId).toBe('stockfish');
    expect(client.limits).toEqual(TEST_WELCOME.limits);
    expect(client.engines).toHaveLength(2);
    expect(client.serverVersion).toBe('0.0.0-test');
    expect(client.capabilities()).toEqual({ threads: true, build: 'Stockfish 19@0.0.0-test', threadCount: 4 });
  });

  it('is idempotent', async () => {
    const { client, sockets } = setup();
    await Promise.all([client.load(), client.load()]);
    await client.load();
    expect(sockets).toHaveLength(1);
  });

  it('rejects on protocol_mismatch and can be retried', async () => {
    let first = true;
    const { client, sockets } = setup({}, (s) => {
      if (first) {
        s.welcome = { type: 'error', code: 'protocol_mismatch', message: 'server speaks protocol 2' };
        first = false;
      }
    });
    const err = await client.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteEngineError);
    expect((err as RemoteEngineError).code).toBe('protocol_mismatch');
    expect((err as Error).message).toMatch(/protocol 2/);
    expect(client.status).toBe('error');
    expect(sockets[0]!.closedWith).not.toBeNull();
    await client.load();
    expect(client.status).toBe('ready');
    expect(sockets).toHaveLength(2);
  });

  it('rejects when the server closes before welcome', async () => {
    const { client, socket } = setup({}, (s) => (s.welcome = null));
    const p = client.load();
    await flush();
    socket().serverClose(1006);
    await expect(p).rejects.toThrow(/Cannot connect to engine server at ws:\/\/test\/ws \(code 1006\)/);
    expect(client.status).toBe('error');
  });

  it('times out without welcome', async () => {
    vi.useFakeTimers();
    const { client, socket } = setup({ handshakeTimeoutMs: 500 }, (s) => (s.welcome = null));
    const p = client.load();
    const assertion = expect(p).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
    expect(socket().closedWith).not.toBeNull();
  });

  it('rejects an unknown or disabled engineId', async () => {
    await expect(setup({ engineId: 'nope' }).client.load()).rejects.toThrow(/no engine "nope"/);
    await expect(setup({ engineId: 'fairy' }).client.load()).rejects.toThrow(/disabled/);
    const { client } = setup({ engineId: 'stockfish' });
    await client.load();
    expect(client.engineId).toBe('stockfish');
  });

  it('dispose during load rejects the handshake and closes the socket', async () => {
    const { client, socket } = setup({}, (s) => (s.welcome = null));
    const p = client.load();
    await flush();
    await client.dispose();
    await expect(p).rejects.toThrow(/disposed/);
    expect(client.status).toBe('closed');
    expect(socket().closedWith?.code).toBe(1000);
    await expect(client.load()).rejects.toThrow(/disposed/);
  });
});

describe('RemoteEngineClient analyze', () => {
  it('fails before load', async () => {
    const { client } = setup();
    await expect(collect(client.analyze(START, {}))).rejects.toThrow(/not loaded/);
  });

  it('streams White-POV infos and completes on bestmove', async () => {
    const { client, socket } = await loaded();
    const handle = client.analyze(BLACK_TO_MOVE, { depth: 10 });
    const [msg] = socket().ofType('analyze');
    expect(msg).toEqual({
      type: 'analyze',
      sessionId: client.sessionId,
      searchId: 1,
      engine: 'stockfish',
      fen: BLACK_TO_MOVE,
      depth: 10,
    });
    const s = { sessionId: client.sessionId, searchId: 1 };
    socket().emit({ type: 'info', ...s, info: info(1, -900, ['e8d8']) });
    socket().emit({ type: 'info', ...s, info: { depth: 2, multipv: 1, score: { mate: -3 }, pv: ['e8d8'] } });
    socket().emit({ type: 'bestmove', ...s, bestMove: { move: 'e8d8' }, reason: 'completed' });
    const infos = await collect(handle);
    expect(infos.map((i) => i.score)).toEqual([{ cp: 900 }, { mate: 3 }]);
    expect(await handle.bestMove).toEqual({ move: 'e8d8' });
  });

  it('ignores messages of other sessions and unknown searches', async () => {
    const { client, socket } = await loaded();
    const handle = client.analyze(START, { depth: 5 });
    socket().emit({ type: 'info', sessionId: 'other', searchId: 1, info: info(1, 50) });
    socket().emit({ type: 'info', sessionId: client.sessionId, searchId: 99, info: info(1, 60) });
    socket().emitRaw('{"type":"bogus"}');
    socket().emit({ type: 'info', sessionId: client.sessionId, searchId: 1, info: info(2, 20) });
    socket().emit({ type: 'bestmove', sessionId: client.sessionId, searchId: 1, bestMove: null, reason: 'completed' });
    expect((await collect(handle)).map((i) => i.depth)).toEqual([2]);
    expect(await handle.bestMove).toBeNull();
  });

  it('replace: old handle ends on its bestmove stopped, new handle gets only new infos', async () => {
    const { client, socket } = await loaded();
    const sid = client.sessionId;
    const first = client.analyze(START, {});
    socket().emit({ type: 'info', sessionId: sid, searchId: 1, info: info(1, 10) });
    const second = client.analyze(BLACK_TO_MOVE, {});
    // Sent immediately; no separate stop.
    expect(socket().sent.map((m) => m.type)).toEqual(['hello', 'analyze', 'analyze']);
    expect(socket().ofType('analyze')[1]!.searchId).toBe(2);
    // Late info of the old search, then its terminal message, then the new search.
    socket().emit({ type: 'info', sessionId: sid, searchId: 1, info: info(2, 11) });
    socket().emit({ type: 'bestmove', sessionId: sid, searchId: 1, bestMove: { move: 'e2e4' }, reason: 'stopped' });
    socket().emit({ type: 'info', sessionId: sid, searchId: 2, info: info(1, -500, ['e8d8']) });
    socket().emit({ type: 'bestmove', sessionId: sid, searchId: 2, bestMove: { move: 'e8d8' }, reason: 'completed' });
    expect((await collect(first)).map((i) => i.score)).toEqual([{ cp: 10 }, { cp: 11 }]);
    expect(await first.bestMove).toEqual({ move: 'e2e4' });
    expect((await collect(second)).map((i) => i.score)).toEqual([{ cp: 500 }]);
  });

  it('breaking out of a superseded iterator sends no stop; of the current one sends stop', async () => {
    const { client, socket } = await loaded();
    const sid = client.sessionId;
    const first = client.analyze(START, {});
    const second = client.analyze(START, {});
    await first[Symbol.asyncIterator]().return?.();
    expect(socket().ofType('stop')).toHaveLength(0);
    await second[Symbol.asyncIterator]().return?.();
    expect(socket().ofType('stop')).toEqual([{ type: 'stop', sessionId: sid }]);
  });

  it('stop() sends stop and resolves once the terminal messages arrived', async () => {
    const { client, socket } = await loaded();
    const sid = client.sessionId;
    await client.stop(); // idle: no message (would provoke session_not_found)
    expect(socket().ofType('stop')).toHaveLength(0);
    const handle = client.analyze(START, {});
    let stopped = false;
    const p = client.stop().then(() => (stopped = true));
    expect(socket().ofType('stop')).toHaveLength(1);
    await flush();
    expect(stopped).toBe(false);
    socket().emit({ type: 'bestmove', sessionId: sid, searchId: 1, bestMove: { move: 'e2e4' }, reason: 'stopped' });
    await p;
    expect(await collect(handle)).toEqual([]);
  });

  it('an error with searchId fails only that handle', async () => {
    const { client, socket } = await loaded();
    const sid = client.sessionId;
    const first = client.analyze(START, {});
    const second = client.analyze(START, {});
    socket().emit({ type: 'error', code: 'no_capacity', message: 'busy', sessionId: sid, searchId: 2 });
    socket().emit({ type: 'bestmove', sessionId: sid, searchId: 1, bestMove: null, reason: 'stopped' });
    await expect(collect(second)).rejects.toMatchObject({ code: 'no_capacity', message: 'Engine server: busy' });
    expect(await collect(first)).toEqual([]);
    expect(client.status).toBe('ready');
    // The client keeps working.
    const third = client.analyze(START, { depth: 1 });
    socket().emit({ type: 'bestmove', sessionId: sid, searchId: 3, bestMove: { move: 'd2d4' }, reason: 'completed' });
    expect(await third.bestMove).toEqual({ move: 'd2d4' });
  });

  it('a session-level error fails all handles; session_not_found is ignored', async () => {
    const { client, socket } = await loaded();
    const sid = client.sessionId;
    const first = client.analyze(START, {});
    socket().emit({ type: 'error', code: 'session_not_found', message: 'no session', sessionId: sid });
    socket().emit({ type: 'error', code: 'engine_crashed', message: 'crash', sessionId: sid });
    await expect(collect(first)).rejects.toMatchObject({ code: 'engine_crashed' });
    expect(client.status).toBe('ready');
  });

  it('socket close fails all handles and sets status closed; load() reconnects', async () => {
    const { client, socket, sockets } = await loaded();
    const statuses: string[] = [];
    client.onStatus((s, e) => statuses.push(e ? `${s}: ${e}` : s));
    const first = client.analyze(START, {});
    const second = client.analyze(START, {});
    socket().serverClose(1011, 'boom');
    await expect(collect(first)).rejects.toThrow(/closed \(code 1011: boom\)/);
    await expect(collect(second)).rejects.toMatchObject({ code: 'closed' });
    expect(statuses).toEqual(['closed: Connection to engine server closed (code 1011: boom)']);
    await expect(collect(client.analyze(START, {}))).rejects.toThrow(/Not connected/);
    await client.load();
    expect(sockets).toHaveLength(2);
    expect(client.status).toBe('ready');
    client.analyze(START, {});
    // searchIds stay unique per client instance.
    expect(socket().ofType('analyze')[0]!.searchId).toBe(3);
  });

  it('a connection-level error fails all handles and closes the socket', async () => {
    const { client, socket } = await loaded();
    const handle = client.analyze(START, {});
    socket().emit({ type: 'error', code: 'rate_limited', message: 'too many messages' });
    await expect(collect(handle)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(client.status).toBe('closed');
    expect(socket().closedWith).not.toBeNull();
  });

  it('fails the connection when a stopped search never ends', async () => {
    vi.useFakeTimers();
    const { client, socket } = setup({ responseTimeoutMs: 1_000 });
    const p = client.load();
    await vi.advanceTimersByTimeAsync(0);
    await p;
    const handle = client.analyze(START, {});
    void client.stop();
    const assertion = expect(collect(handle)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    expect(client.status).toBe('closed');
    expect(socket().closedWith).not.toBeNull();
  });
});

describe('RemoteEngineClient limits and options', () => {
  it('clamps multipv, depth, threads and hash to welcome.limits', async () => {
    const { client, socket } = await loaded();
    await client.setOptions({ Threads: 12, Hash: 4096 });
    client.analyze(START, { depth: 60, multipv: 9 });
    expect(socket().ofType('analyze')[0]).toMatchObject({ depth: 30, multipv: 5, threads: 4, hash: 512 });
    expect(client.capabilities().threadCount).toBe(4);
  });

  it('fails fast when movetime exceeds the limit, and on invalid input', async () => {
    const { client, socket } = setup({}, (s) => {
      s.welcome = { ...TEST_WELCOME, limits: { ...TEST_WELCOME.limits, maxMovetimeMs: 60_000 } };
    });
    await client.load();
    await expect(collect(client.analyze(START, { movetime: 120_000 }))).rejects.toMatchObject({
      code: 'limit_exceeded',
      message: 'movetime 120000 exceeds the server limit of 60000',
    });
    await expect(collect(client.analyze('not a fen', {}))).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(collect(client.analyze(START, { depth: 0 }))).rejects.toThrow(/depth/);
    expect(socket().ofType('analyze')).toHaveLength(0);
    client.analyze(START, { movetime: 1_000 });
    expect(socket().ofType('analyze')[0]).toMatchObject({ searchId: 1, movetime: 1_000 });
  });

  it('setOptions maps Threads/Hash/MultiPV onto the next analyze and rejects other options', async () => {
    const { client, socket } = await loaded();
    await client.setOptions({ Threads: 2, hash: '64', MultiPV: 3 });
    expect(client.capabilities().threadCount).toBe(2);
    client.analyze(START, {});
    client.analyze(START, { multipv: 2 });
    const [a, b] = socket().ofType('analyze');
    expect(a).toMatchObject({ threads: 2, hash: 64, multipv: 3 });
    expect(b).toMatchObject({ threads: 2, hash: 64, multipv: 2 });
    await expect(client.setOptions({ 'Debug Log File': '/tmp/x' })).rejects.toThrow(/not supported/);
    await expect(client.setOptions({ Threads: 0 })).rejects.toThrow(/positive integer/);
    await expect(client.setOptions({ Threads: true })).rejects.toThrow(/positive integer/);
    await expect(client.setOptions({ toString: 1 })).rejects.toThrow(/not supported/);
  });
});

describe('RemoteEngineClient dispose', () => {
  it('sends release, closes with 1000 and completes running iterators', async () => {
    const { client, socket } = await loaded();
    const handle = client.analyze(START, {});
    await client.dispose();
    expect(socket().sent.at(-1)).toEqual({ type: 'release', sessionId: client.sessionId });
    expect(socket().closedWith?.code).toBe(1000);
    expect(await collect(handle)).toEqual([]);
    expect(await handle.bestMove).toBeNull();
    expect(client.status).toBe('closed');
    await expect(collect(client.analyze(START, {}))).rejects.toThrow(/disposed/);
  });

  it('does not send release when no session was created', async () => {
    const { client, socket } = await loaded();
    await client.dispose();
    expect(socket().ofType('release')).toHaveLength(0);
  });
});
