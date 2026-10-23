import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type ServerMessage } from '@chesslab/engine-core';
import { buildApp, type BuildAppOptions } from '../app.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { fakeSpawner, registry, until } from '../../test/helpers.js';
import { TestClient } from '../../test/ws-client.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** The fake engine crashes on `go` for full-move 999 and ignores `stop` for 998. */
const CRASH_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 999';
const HANG_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 998';

const apps: FastifyInstance[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    // Every message any test received must have passed ServerMessageSchema.
    expect(c.invalid).toEqual([]);
    c.ws.terminate();
  }
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function start(
  config: Partial<Omit<ServerConfig, 'limits'>> & { limits?: Partial<ServerConfig['limits']> } = {},
  extra: Partial<BuildAppOptions> = {},
): Promise<{ app: FastifyInstance; url: string }> {
  const base = loadConfig({});
  const app = await buildApp({
    config: { ...base, ...config, limits: { ...base.limits, ...config.limits } },
    registry: registry(
      { id: 'fake', name: 'Fake Engine', maxInstances: 2, options: { Threads: 2, Hash: 32 } },
      { id: 'fake2', maxInstances: 1 },
      { id: 'off', enabled: false },
    ),
    spawnEngine: fakeSpawner({ fake: ['--info-interval=3'], fake2: ['--info-interval=3'] }),
    logger: false,
    ...extra,
  });
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  return { app, url: `ws://127.0.0.1:${port}/ws` };
}

async function client(url: string): Promise<TestClient> {
  const { client: c } = await TestClient.connectAndHello(url);
  clients.push(c);
  return c;
}

function analyze(sessionId: string, searchId: number, extra: Record<string, unknown> = {}) {
  return { type: 'analyze', sessionId, searchId, engine: 'fake', fen: START, ...extra };
}

/**
 * Checks the per-session guarantees of ADR-006 over a message log:
 * exactly one terminal per search, no info after its terminal, and the terminal of each search
 * precedes every info of any later search of the same session.
 */
function checkOrdering(messages: ServerMessage[], sessionId: string, searchIds: number[]): void {
  const idx = (pred: (m: ServerMessage, i: number) => boolean) =>
    messages.map((m, i) => (pred(m, i) ? i : -1)).filter((i) => i >= 0);
  const isTerminal = (m: ServerMessage, id: number) =>
    (m.type === 'bestmove' || m.type === 'error') && m.sessionId === sessionId && m.searchId === id;
  const isInfo = (m: ServerMessage, id: number) =>
    m.type === 'info' && m.sessionId === sessionId && m.searchId === id;
  let prevTerminal = -1;
  for (const id of searchIds) {
    const terminals = idx((m) => isTerminal(m, id));
    expect(terminals, `terminals of search ${id}`).toHaveLength(1);
    const t = terminals[0]!;
    const infos = idx((m) => isInfo(m, id));
    for (const i of infos) {
      expect(i, `info of ${id} after its terminal`).toBeLessThan(t);
      expect(i, `info of ${id} before previous terminal`).toBeGreaterThan(prevTerminal);
    }
    expect(t).toBeGreaterThan(prevTerminal);
    prevTerminal = t;
  }
}

describe('WebSocket /ws', () => {
  it('handshakes: welcome carries limits and engines from config and registry', async () => {
    const { url } = await start({ limits: { maxDepth: 20 } });
    const { client: c, welcome } = await TestClient.connectAndHello(url);
    clients.push(c);
    expect(welcome).toEqual({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: '0.0.0',
      limits: {
        maxDepth: 20,
        maxMultipv: 5,
        maxThreads: 4,
        maxHash: 512,
        maxMovetimeMs: 600_000,
        maxSessionsPerConnection: 2,
      },
      engines: [
        { id: 'fake', name: 'Fake Engine', enabled: true, defaults: { threads: 2, hash: 32 } },
        { id: 'fake2', name: 'fake2', enabled: true, defaults: { threads: 1, hash: 16 } },
        { id: 'off', name: 'off', enabled: false, defaults: { threads: 1, hash: 16 } },
      ],
    });
    c.send({ type: 'ping', t: 42 });
    expect(await c.waitFor((m) => m.type === 'pong')).toEqual({ type: 'pong', t: 42 });
  });

  it('requires hello first, rejects a protocol mismatch with close 1008', async () => {
    const { url } = await start();
    const c = await TestClient.connect(url);
    clients.push(c);
    c.send(analyze('s', 1));
    expect(await c.waitFor((m) => m.type === 'error')).toMatchObject({
      code: 'handshake_required',
      sessionId: 's',
      searchId: 1,
    });
    c.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION + 1 });
    expect(
      await c.waitFor((m) => m.type === 'error' && m.code === 'protocol_mismatch'),
    ).toBeTruthy();
    expect(await c.waitClosed()).toBe(1008);
  });

  it('answers malformed input with invalid_message', async () => {
    const { url } = await start();
    const c = await client(url);
    c.send('not json');
    c.send({ type: 'bogus' });
    c.send(analyze('s', 3, { fen: 'not a fen' }));
    c.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await until(() => c.messages.filter((m) => m.type === 'error').length === 4);
    const errors = c.messages.filter((m) => m.type === 'error');
    expect(errors.every((e) => e.type === 'error' && e.code === 'invalid_message')).toBe(true);
    // the invalid analyze carries its ids so the client can settle the handle
    expect(errors[2]).toMatchObject({ sessionId: 's', searchId: 3 });
  });

  it('closes frames larger than MAX_MESSAGE_BYTES', async () => {
    const { url } = await start();
    const c = await client(url);
    c.send({ type: 'ping', pad: 'x'.repeat(20_000) });
    expect(await c.waitClosed()).toBe(1009);
  });

  it('streams info and ends with exactly one bestmove (completed)', async () => {
    const { url } = await start();
    const c = await client(url);
    c.send(analyze('s', 1, { depth: 5, multipv: 2 }));
    const end = await c.terminal('s', 1);
    expect(end).toEqual({
      type: 'bestmove',
      sessionId: 's',
      searchId: 1,
      bestMove: { move: 'e2e4', ponder: 'e7e5' },
      reason: 'completed',
    });
    const infos = c.messages.filter((m) => m.type === 'info');
    expect(infos).toHaveLength(10);
    expect(infos[0]).toMatchObject({
      sessionId: 's',
      searchId: 1,
      info: { depth: 1, multipv: 1, score: { cp: 9 }, pv: ['e2e4', 'e7e5', 'g1f3'] },
    });
    checkOrdering(c.messages, 's', [1]);
  });

  it('replacing a running search delivers its bestmove (stopped) before any info of the new one', async () => {
    const { url } = await start();
    const c = await client(url);
    c.send(analyze('s', 1)); // infinite
    await c.waitFor((m) => m.type === 'info' && m.searchId === 1);
    c.send(analyze('s', 2, { depth: 4 }));
    expect(await c.terminal('s', 2)).toMatchObject({ type: 'bestmove', reason: 'completed' });
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'bestmove', reason: 'stopped' });
    expect(c.messages.some((m) => m.type === 'info' && m.searchId === 2)).toBe(true);
    checkOrdering(c.messages, 's', [1, 2]);
  });

  it('rapid-fire analyze: every search gets exactly one terminal, in order', async () => {
    const { url } = await start();
    const c = await client(url);
    const ids = Array.from({ length: 15 }, (_, i) => i + 1);
    for (const id of ids) c.send(analyze('s', id, id === 15 ? { depth: 3 } : {}));
    expect(await c.terminal('s', 15)).toMatchObject({ type: 'bestmove', reason: 'completed' });
    await new Promise((r) => setTimeout(r, 50));
    checkOrdering(c.messages, 's', ids);
    for (const id of ids.slice(0, -1)) {
      expect(await c.terminal('s', id)).toMatchObject({ type: 'bestmove', reason: 'stopped' });
    }
  });

  it('stop ends the search with reason stopped; stop on an idle session is a no-op', async () => {
    const { url } = await start();
    const c = await client(url);
    c.send(analyze('s', 1));
    await c.waitFor((m) => m.type === 'info');
    c.send({ type: 'stop', sessionId: 's' });
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'bestmove', reason: 'stopped' });
    c.send({ type: 'stop', sessionId: 's' });
    c.send({ type: 'stop', sessionId: 'unknown' });
    expect(await c.waitFor((m) => m.type === 'error')).toMatchObject({
      code: 'session_not_found',
      sessionId: 'unknown',
    });
    expect(c.messages.filter((m) => m.type === 'bestmove')).toHaveLength(1);
    checkOrdering(c.messages, 's', [1]);
  });

  it('stop right after analyze supersedes the queued search', async () => {
    const { url } = await start();
    const c = await client(url);
    c.send(analyze('s', 1));
    c.send({ type: 'stop', sessionId: 's' });
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'bestmove', reason: 'stopped' });
  });

  it('enforces limits with limit_exceeded', async () => {
    const { url } = await start({ limits: { maxDepth: 10, maxSessionsPerConnection: 2 } });
    const c = await client(url);
    c.send(analyze('s', 1, { depth: 11 }));
    expect(await c.terminal('s', 1)).toMatchObject({
      type: 'error',
      code: 'limit_exceeded',
      message: 'depth 11 exceeds the server limit of 10',
    });
    c.send(analyze('s', 2, { multipv: 6 }));
    expect(await c.terminal('s', 2)).toMatchObject({ code: 'limit_exceeded' });
    c.send(analyze('a', 1, { depth: 2 }));
    c.send(analyze('b', 1, { depth: 2, engine: 'fake2' }));
    c.send(analyze('c', 1, { depth: 2 }));
    expect(await c.terminal('c', 1)).toMatchObject({ code: 'limit_exceeded' });
    expect(await c.terminal('a', 1)).toMatchObject({ type: 'bestmove' });
    expect(await c.terminal('b', 1)).toMatchObject({ type: 'bestmove' });
    // releasing a session makes room again
    c.send({ type: 'release', sessionId: 'a' });
    c.send(analyze('c', 2, { depth: 2 }));
    expect(await c.terminal('c', 2)).toMatchObject({ type: 'bestmove', reason: 'completed' });
  });

  it('rejects unknown and disabled engines', async () => {
    const { url } = await start();
    const c = await client(url);
    c.send(analyze('s', 1, { engine: 'nope' }));
    c.send(analyze('s', 2, { engine: 'off' }));
    expect(await c.terminal('s', 1)).toMatchObject({ code: 'unknown_engine' });
    expect(await c.terminal('s', 2)).toMatchObject({ code: 'unknown_engine' });
  });

  it('reports no_capacity when the global session cap is reached', async () => {
    const { app, url } = await start({ maxSessions: 1 });
    const a = await client(url);
    const b = await client(url);
    a.send(analyze('s', 1));
    await a.waitFor((m) => m.type === 'info');
    b.send(analyze('s', 1));
    expect(await b.terminal('s', 1)).toMatchObject({ type: 'error', code: 'no_capacity' });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({ sessions: 1 });
    // after a releases, b can analyze
    a.send({ type: 'release', sessionId: 's' });
    expect(await a.terminal('s', 1)).toMatchObject({ reason: 'stopped' });
    await until(() => app.chesslab.pool.sessions === 0);
    b.send(analyze('s', 2, { depth: 2 }));
    expect(await b.terminal('s', 2)).toMatchObject({ type: 'bestmove', reason: 'completed' });
  });

  it('switching engines within a session releases the old lease', async () => {
    const { app, url } = await start();
    const c = await client(url);
    c.send(analyze('s', 1, { depth: 2 }));
    await c.terminal('s', 1);
    c.send(analyze('s', 2, { depth: 2, engine: 'fake2' }));
    expect(await c.terminal('s', 2)).toMatchObject({ type: 'bestmove' });
    const stats = app.chesslab.pool.stats();
    expect(stats.find((s) => s.id === 'fake')).toMatchObject({ busy: 0 });
    expect(stats.find((s) => s.id === 'fake2')).toMatchObject({ busy: 1 });
  });

  it('engine crash during a search → engine_crashed with ids; the session recovers', async () => {
    const { app, url } = await start();
    const c = await client(url);
    c.send(analyze('s', 1, { fen: CRASH_FEN }));
    expect(await c.terminal('s', 1)).toMatchObject({
      type: 'error',
      code: 'engine_crashed',
      sessionId: 's',
      searchId: 1,
    });
    await until(() => app.chesslab.pool.sessions === 0);
    c.send(analyze('s', 2, { depth: 2 }));
    expect(await c.terminal('s', 2)).toMatchObject({ type: 'bestmove', reason: 'completed' });
    checkOrdering(c.messages, 's', [1, 2]);
    expect(c.messages.filter((m) => m.type === 'bestmove' && m.searchId === 1)).toHaveLength(0);
  });

  it('an engine that ignores stop is dropped: engine_crashed for the search, process killed', async () => {
    const { app, url } = await start({}, { connection: { stopTimeoutMs: 200 } });
    const c = await client(url);
    c.send(analyze('s', 1, { fen: HANG_FEN }));
    await c.waitFor((m) => m.type === 'info');
    c.send(analyze('s', 2, { depth: 2 }));
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'error', code: 'engine_crashed' });
    expect(await c.terminal('s', 2, 8_000)).toMatchObject({
      type: 'bestmove',
      reason: 'completed',
    });
    checkOrdering(c.messages, 's', [1, 2]);
    expect(app.chesslab.pool.instanceCount('fake')).toBeLessThanOrEqual(2);
  });

  it('an idle session gives its engine back after SESSION_IDLE_MS and is recreated on demand', async () => {
    const { app, url } = await start({ sessionIdleMs: 150 });
    const c = await client(url);
    c.send(analyze('s', 1, { depth: 2 }));
    await c.terminal('s', 1);
    expect(app.chesslab.pool.sessions).toBe(1);
    await until(() => app.chesslab.pool.sessions === 0);
    c.send(analyze('s', 2, { depth: 2 }));
    expect(await c.terminal('s', 2)).toMatchObject({ type: 'bestmove', reason: 'completed' });
    expect(app.chesslab.pool.sessions).toBe(1);
  });

  it('caps the wall time of infinite searches (reason: limit)', async () => {
    const { url } = await start({ limits: { maxMovetimeMs: 200 } });
    const c = await client(url);
    c.send(analyze('s', 1));
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'bestmove', reason: 'limit' });
  });

  it('rate-limits analyze to 20 per second', async () => {
    const { url } = await start();
    const c = await client(url);
    for (let id = 1; id <= 25; id++) c.send(analyze('s', id, { depth: 1 }));
    await until(() =>
      [21, 22, 23, 24, 25].every((id) =>
        c.messages.some((m) => m.type === 'error' && m.searchId === id),
      ),
    );
    expect(c.messages.filter((m) => m.type === 'error' && m.code === 'rate_limited')).toHaveLength(
      5,
    );
    await c.terminal('s', 20);
    checkOrdering(
      c.messages,
      's',
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('releases every session when the client disconnects', async () => {
    const { app, url } = await start();
    const c = await client(url);
    c.send(analyze('a', 1));
    c.send(analyze('b', 1, { engine: 'fake2' }));
    await c.waitFor((m) => m.type === 'info' && m.sessionId === 'a');
    await c.waitFor((m) => m.type === 'info' && m.sessionId === 'b');
    expect(app.chesslab.pool.sessions).toBe(2);
    await c.close();
    await until(() => app.chesslab.pool.sessions === 0 && app.chesslab.ws.connections.size === 0);
    await until(() => app.chesslab.pool.stats().every((s) => s.busy === 0 && s.idle <= 1));
    const health = (await app.inject({ method: 'GET', url: '/health' })).json() as {
      engines: { id: string; busy: number; idle: number }[];
      sessions: number;
    };
    expect(health.sessions).toBe(0);
    expect(health.engines.find((e) => e.id === 'fake')).toMatchObject({ busy: 0, idle: 1 });
  });

  it('server shutdown closes clients with 1001 and kills all engine processes', async () => {
    const { app, url } = await start();
    const c = await client(url);
    c.send(analyze('s', 1));
    await c.waitFor((m) => m.type === 'info');
    const pids = app.chesslab.pool.stats();
    expect(pids[0]?.busy).toBe(1);
    const closed = c.waitClosed();
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect(await closed).toBe(1001);
    expect(app.chesslab.pool.instanceCount('fake')).toBe(0);
  });

  it('rejects upgrades on other paths', async () => {
    const { url } = await start();
    const ws = new WebSocket(url.replace('/ws', '/other'));
    const err = await new Promise<Error>((resolve) => ws.once('error', resolve));
    expect(err.message).toMatch(/404/);
  });

  it('closes connections that never say hello', async () => {
    const { url } = await start({}, { connection: { handshakeTimeoutMs: 100 } });
    const c = await TestClient.connect(url);
    clients.push(c);
    expect(await c.waitClosed()).toBe(1008);
  });
});
