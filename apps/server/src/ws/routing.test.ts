import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  type AnalysisDeniedReason,
  type EngineDescriptor,
  type ReviewStoredMessage,
} from '@daisychess/engine-core';
import type { EnginePool, PoolLogger } from '../engines/EnginePool.js';
import { ReviewStore, loadSqlite } from '../review/ReviewStore.js';
import type { AnalysisChannel } from '../sessions/AnalysisChannel.js';
import type { AnalysisRouter, RouteResult } from '../sessions/AnalysisRouter.js';
import type { AnalysisClientMessage, Deliver } from '../sessions/ClientSessions.js';
import { DEFAULT_ROOM_CONFIG } from '../rooms/RoomManager.js';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { fakeSpawner, registry } from '../../test/helpers.js';
import { fixtureReview, SCHOLAR } from '../../test/review-fixtures.js';
import { TestClient } from '../../test/ws-client.js';
import { attachWebSocketServer, type WsServerHandle } from './server.js';

const silent: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };
const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ENGINES: EngineDescriptor[] = [
  { id: 'sf', name: 'SF', enabled: true, defaults: { threads: 1, hash: 16 } },
];
const sqlite = await loadSqlite();

const apps: FastifyInstance[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) {
    expect(c.invalid).toEqual([]);
    c.ws.terminate();
  }
  await Promise.all(apps.splice(0).map((a) => a.close()));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A channel that answers every analyze with bestmove; `kill()` plays a node loss. */
class ScriptedChannel implements AnalysisChannel {
  readonly handled: AnalysisClientMessage[] = [];
  closed = false;
  readonly lost: Promise<void>;
  private resolveLost!: () => void;
  constructor(
    private readonly deliver: Deliver,
    private readonly autoAnswer = true,
  ) {
    this.lost = new Promise((r) => (this.resolveLost = r));
  }
  get sessionCount() {
    return 0;
  }
  handle(m: AnalysisClientMessage) {
    this.handled.push(m);
    if (m.type === 'analyze' && this.autoAnswer) {
      this.deliver({
        type: 'bestmove',
        sessionId: m.sessionId,
        searchId: m.searchId,
        bestMove: null,
        reason: 'completed',
      });
    }
  }
  retireAll() {}
  close() {
    this.closed = true;
    return Promise.resolve();
  }
  kill() {
    for (const m of this.handled) {
      if (m.type !== 'analyze') continue;
      this.deliver({
        type: 'error',
        code: 'engine_crashed',
        message: 'engine node lost',
        sessionId: m.sessionId,
        searchId: m.searchId,
      });
    }
    this.resolveLost();
  }
}

async function serve(
  router: AnalysisRouter,
  reviewStore: ReviewStore | null = null,
): Promise<{ url: string; ws: WsServerHandle }> {
  const app = Fastify({ logger: false });
  const ws = attachWebSocketServer(app, {
    // The pool is not used when a router is given (only the default LocalRouter needs it).
    pool: {} as EnginePool,
    router: () => router,
    limits: DEFAULT_LIMITS,
    engines: ENGINES,
    sessionIdleMs: 60_000,
    serverVersion: '9.9.9',
    logger: silent,
    roomConfig: DEFAULT_ROOM_CONFIG,
    reviewStore,
    reviewPutPerIpPerDay: 100,
    allowedOrigins: '*',
  });
  app.addHook('preClose', () => ws.close());
  apps.push(app);
  await app.listen({ port: 0, host: '127.0.0.1' });
  return { url: `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`, ws };
}

async function connect(url: string): Promise<TestClient> {
  const c = await TestClient.connect(url);
  clients.push(c);
  return c;
}

const hello = (token?: string) => ({
  type: 'hello',
  protocolVersion: PROTOCOL_VERSION,
  ...(token === undefined ? {} : { token }),
});
const analyze = (sessionId: string, searchId: number) => ({
  type: 'analyze',
  sessionId,
  searchId,
  engine: 'sf',
  fen: FEN,
});

describe('Connection: channel created at hello from the router', () => {
  it('composes welcome from the route (limits, engines, node) and opens the channel once', async () => {
    const channels: ScriptedChannel[] = [];
    const limits = { ...DEFAULT_LIMITS, maxThreads: 2 };
    const router: AnalysisRouter = {
      restrictedLimits: DEFAULT_LIMITS,
      route: () => ({
        ok: true,
        route: {
          limits,
          engines: ENGINES,
          node: { name: 'fast-box', operator: 'bojan', shared: true },
          open: (d) => {
            const ch = new ScriptedChannel(d);
            channels.push(ch);
            return ch;
          },
        },
      }),
    };
    const { url } = await serve(router);
    const c = await connect(url);
    c.send(hello('t'));
    expect(await c.waitFor((m) => m.type === 'welcome')).toEqual({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: '9.9.9',
      limits,
      engines: ENGINES,
      capabilities: { analysis: true, rooms: true, reviewStore: false },
      node: { name: 'fast-box', operator: 'bojan', shared: true },
    });
    c.send(analyze('s', 1));
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'bestmove' });
    expect(channels).toHaveLength(1);
    c.ws.close();
    await c.waitClosed();
    await new Promise((r) => setTimeout(r, 20));
    expect(channels[0]!.closed).toBe(true);
  });

  it('a denied route: restricted welcome with analysisDenied; analyze → unauthorized, stop → session_not_found', async () => {
    const { url } = await serve({
      restrictedLimits: DEFAULT_LIMITS,
      route: () => ({ ok: false, reason: 'node_offline' }),
    });
    const c = await connect(url);
    c.send(hello('t'));
    expect(await c.waitFor((m) => m.type === 'welcome')).toEqual({
      type: 'welcome',
      protocolVersion: PROTOCOL_VERSION,
      serverVersion: '9.9.9',
      limits: DEFAULT_LIMITS,
      engines: [],
      capabilities: { analysis: false, rooms: true, reviewStore: false },
      analysisDenied: 'node_offline',
    });
    c.send(analyze('s', 1));
    expect(await c.terminal('s', 1)).toMatchObject({ type: 'error', code: 'unauthorized' });
    c.send({ type: 'release', sessionId: 's' });
    c.send({ type: 'stop', sessionId: 's' });
    expect(
      await c.waitFor((m) => m.type === 'error' && m.code === 'session_not_found'),
    ).toMatchObject({
      sessionId: 's',
    });
    // Rooms still work.
    c.send({
      type: 'room.create',
      color: 'white',
      clock: { initialMs: 60_000, incrementMs: 0 },
      nick: 'a',
    });
    expect(await c.waitFor((m) => m.type === 'room.seat')).toBeTruthy();
    expect(c.closeCode).toBeNull();
  });

  it('an asynchronous route keeps messages sent before welcome, in order, and answers them after it', async () => {
    let release!: (r: RouteResult) => void;
    const channels: ScriptedChannel[] = [];
    const { url } = await serve({
      restrictedLimits: DEFAULT_LIMITS,
      route: () =>
        new Promise<RouteResult>((resolve) => {
          release = resolve;
        }),
    });
    const c = await connect(url);
    c.send(hello('t'));
    c.send(analyze('s', 1));
    c.send({ type: 'ping', t: 5 });
    c.send(analyze('s', 2));
    await new Promise((r) => setTimeout(r, 50));
    expect(c.messages).toEqual([]);
    release({
      ok: true,
      route: {
        limits: DEFAULT_LIMITS,
        engines: ENGINES,
        open: (d) => {
          const ch = new ScriptedChannel(d);
          channels.push(ch);
          return ch;
        },
      },
    });
    await c.terminal('s', 2);
    expect(c.messages.map((m) => m.type)).toEqual(['welcome', 'bestmove', 'pong', 'bestmove']);
  });

  it('a lost channel: terminals first, then the socket closes with 1012', async () => {
    const channels: ScriptedChannel[] = [];
    const { url, ws } = await serve({
      restrictedLimits: DEFAULT_LIMITS,
      route: () => ({
        ok: true,
        route: {
          limits: DEFAULT_LIMITS,
          engines: ENGINES,
          open: (d) => {
            const ch = new ScriptedChannel(d, false);
            channels.push(ch);
            return ch;
          },
        },
      }),
    });
    const c = await connect(url);
    c.send(hello('t'));
    await c.waitFor((m) => m.type === 'welcome');
    c.send(analyze('a', 1));
    c.send(analyze('b', 7));
    await new Promise((r) => setTimeout(r, 30));
    channels[0]!.kill();
    expect(await c.waitClosed()).toBe(1012);
    expect(c.messages.slice(1)).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'engine_crashed',
        sessionId: 'a',
        searchId: 1,
      }),
      expect.objectContaining({
        type: 'error',
        code: 'engine_crashed',
        sessionId: 'b',
        searchId: 7,
      }),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(ws.connections.size).toBe(0);
  });

  it('a route whose open() throws closes 1011; a throwing router too', async () => {
    const { url } = await serve({
      restrictedLimits: DEFAULT_LIMITS,
      route: (h) => {
        if (h.token === 'boom') throw new Error('router bug');
        return {
          ok: true,
          route: {
            limits: DEFAULT_LIMITS,
            engines: ENGINES,
            open: () => {
              throw new TypeError('invalid route');
            },
          },
        };
      },
    });
    for (const token of ['x', 'boom']) {
      const c = await connect(url);
      c.send(hello(token));
      expect(await c.waitClosed()).toBe(1011);
      expect(c.messages.at(-1)).toMatchObject({ type: 'error', code: 'internal_error' });
    }
  });

  it.skipIf(!sqlite)(
    'review writes: allowed when denied for capacity (valid token), refused for bad tokens',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-routing-'));
      dirs.push(dir);
      const store = await ReviewStore.open(
        { path: path.join(dir, 'r.sqlite'), maxBytes: 10_000_000 },
        silent,
      );
      const reasons: Record<string, AnalysisDeniedReason> = {
        full: 'no_capacity',
        off: 'node_offline',
        spent: 'budget_exhausted',
        bad: 'bad_token',
        old: 'expired',
        gone: 'revoked',
      };
      const { url } = await serve(
        {
          restrictedLimits: DEFAULT_LIMITS,
          route: (h) => ({ ok: false, reason: reasons[h.token ?? ''] ?? 'no_token' }),
        },
        store,
      );
      const results: Record<string, unknown> = {};
      for (const token of [...Object.keys(reasons), undefined]) {
        const c = await connect(url);
        c.send(hello(token));
        await c.waitFor((m) => m.type === 'welcome');
        c.send(fixtureReview(SCHOLAR));
        const stored = await c.waitFor((m): m is ReviewStoredMessage => m.type === 'review.stored');
        results[token ?? 'none'] = stored.stored || stored.reason;
      }
      expect(results).toEqual({
        full: true,
        off: true,
        spent: true,
        bad: 'unauthorized',
        old: 'unauthorized',
        gone: 'unauthorized',
        none: 'unauthorized',
      });
    },
  );
});

describe('LocalRouter (standalone) through buildApp', () => {
  it('analysisDenied is no_token without a token and bad_token with a wrong one; welcome has no node', async () => {
    const app = await buildApp({
      config: { ...loadConfig({ REVIEW_STORE: 'off' }), accessToken: 'secret' },
      registry: registry({ id: 'fake' }),
      spawnEngine: fakeSpawner(),
      logger: false,
    });
    apps.push(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
    const seen: unknown[] = [];
    for (const token of [undefined, 'wrong', 'secret']) {
      const c = await TestClient.connect(url, {
        headers: { origin: url.replace('ws://', 'http://').replace('/ws', '') },
      });
      clients.push(c);
      c.send(hello(token));
      const w = await c.waitFor((m) => m.type === 'welcome');
      seen.push(w.type === 'welcome' ? [w.analysisDenied, w.node, w.engines.length] : null);
    }
    expect(seen).toEqual([
      ['no_token', undefined, 0],
      ['bad_token', undefined, 0],
      [undefined, undefined, 1],
    ]);
  });
});
