import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type {
  AnalyzeMessage,
  EngineDescriptor,
  Limits,
  NodeRelayMessage,
} from '@daisychess/engine-core';
import { EnginePool } from '../engines/EnginePool.js';
import { LocalBackend } from '../sessions/LocalBackend.js';
import { FakeHub, type FakeHubLink } from '../../test/fake-hub.js';
import { fakeSpawner, registry, until } from '../../test/helpers.js';
import { NodeLink, type LinkSocket, type NodeLinkOptions } from './NodeLink.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const TOKEN = `dcn_abcdefgh_${'a'.repeat(32)}`;
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const LIMITS: Limits = {
  maxDepth: 20,
  maxMultipv: 3,
  maxThreads: 2,
  maxHash: 64,
  maxMovetimeMs: 60_000,
  maxSessionsPerConnection: 2,
  maxNodes: 10_000,
};
const ENGINES: EngineDescriptor[] = [
  { id: 'fake', name: 'Fake', enabled: true, defaults: { threads: 2, hash: 64 } },
];

const analyze = (over: Partial<AnalyzeMessage> = {}): AnalyzeMessage => ({
  type: 'analyze',
  sessionId: 's1',
  searchId: 1,
  engine: 'fake',
  fen: FEN,
  depth: 5,
  ...over,
});

let hub: FakeHub | null = null;
let link: NodeLink | null = null;
let pool: EnginePool | null = null;

afterEach(async () => {
  await link?.close();
  await pool?.shutdown();
  await hub?.close();
  link = null;
  pool = null;
  hub = null;
});

interface Setup {
  hub: FakeHub;
  link: NodeLink;
  pool: EnginePool;
  exit: ReturnType<typeof vi.fn>;
}

async function setup(
  over: Partial<NodeLinkOptions> = {},
  engineFlags: string[] = [],
  hubOpts: { autoPong?: boolean } = {},
): Promise<Setup> {
  hub = await FakeHub.start(hubOpts);
  pool = new EnginePool(registry({ id: 'fake', name: 'Fake', maxInstances: 2 }), {
    maxSessions: 2,
    idleMs: 60_000,
    spawn: fakeSpawner({ fake: engineFlags }),
    logger: silent,
  });
  const p = pool;
  const exit = vi.fn();
  link = new NodeLink({
    hubUrl: hub.url,
    token: TOKEN,
    version: '0.3.0',
    engines: ENGINES,
    limits: LIMITS,
    maxSessions: 2,
    pool: true,
    backend: new LocalBackend(p),
    engineStatus: () =>
      p.stats().map((e) => ({ id: e.id, busy: e.busy, idle: e.idle, degraded: e.degraded })),
    logger: silent,
    sessionIdleMs: 60_000,
    exit,
    reconnectMinMs: 20,
    reconnectMaxMs: 100,
    random: () => 0.5,
    load1: () => 0.25,
    ...over,
  });
  link.start();
  return { hub, link, pool: p, exit };
}

/** Connects, answers the hello with a welcome and waits for the first status. */
async function registered(s: Setup, welcome = {}): Promise<FakeHubLink> {
  const l = await s.hub.link(0);
  await l.waitFor('node.hello');
  l.welcome(welcome);
  await l.waitFor('node.status');
  return l;
}

function open(l: FakeHubLink, cid = 'c1', limits: Limits = LIMITS): void {
  l.send({ type: 'client.open', cid, limits, shared: true, tier: 'standard' });
}

async function terminal(
  l: FakeHubLink,
  cid: string,
  searchId: number,
  sessionId = 's1',
): Promise<NodeRelayMessage> {
  const f = await l.waitFor(
    'client.msg',
    (m) =>
      m.cid === cid &&
      m.msg.sessionId === sessionId &&
      (m.msg.type === 'bestmove' || m.msg.type === 'error') &&
      m.msg.searchId === searchId,
  );
  return f.msg;
}

describe('NodeLink (fake hub)', () => {
  it('registers: node.hello carries token, version, platform, engines, limits, caps; then status', async () => {
    const s = await setup();
    const l = await s.hub.link(0);
    const hello = await l.waitFor('node.hello');
    expect(hello).toEqual({
      type: 'node.hello',
      linkVersion: 1,
      nodeToken: TOKEN,
      node: { version: '0.3.0', platform: process.platform, arch: process.arch },
      engines: ENGINES,
      limits: LIMITS,
      maxSessions: 2,
      pool: true,
    });
    expect(s.link.stats()).toMatchObject({ state: 'handshaking', connected: false, nodeId: null });
    l.welcome({ heartbeatMs: 5_000 });
    const status = await l.waitFor('node.status');
    expect(status).toEqual({
      type: 'node.status',
      sessions: 0,
      maxSessions: 2,
      load1: 0.25,
      engines: [{ id: 'fake', busy: 0, idle: 0, degraded: false }],
    });
    expect(s.link.stats()).toMatchObject({
      state: 'connected',
      connected: true,
      nodeId: 'abcdefgh',
      name: 'fast-box',
      hubVersion: '0.1.0',
    });
    expect(s.link.stats().lastPongAt).not.toBeNull();
    expect(JSON.stringify(s.link.stats())).not.toContain(TOKEN);
    expect(l.invalid).toEqual([]);
  });

  it('relays a search end to end in order; a replacing analyze ends the old search first', async () => {
    const s = await setup({}, ['--info-interval=5']);
    const l = await registered(s);
    open(l);
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ depth: 4 }) });
    const end = await terminal(l, 'c1', 1);
    expect(end).toMatchObject({
      type: 'bestmove',
      reason: 'completed',
      bestMove: { move: 'e2e4' },
    });
    const first = l.relayed('c1');
    expect(first.at(-1)).toBe(end);
    expect(first.filter((m) => m.type === 'info').length).toBeGreaterThan(0);
    // Session status changes are reported (lease taken).
    await l.waitFor('node.status', (f) => f.sessions === 1);

    // Infinite search 2, replaced by 3: bestmove(2, stopped) precedes every info of 3.
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ searchId: 2, depth: undefined }) });
    await l.waitFor('client.msg', (m) => m.msg.type === 'info' && m.msg.searchId === 2);
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ searchId: 3, depth: 3 }) });
    await terminal(l, 'c1', 3);
    const seq = l.relayed('c1').filter((m) => m.searchId !== 1);
    const end2 = seq.findIndex((m) => m.type === 'bestmove' && m.searchId === 2);
    const firstInfo3 = seq.findIndex((m) => m.type === 'info' && m.searchId === 3);
    expect(seq[end2]).toMatchObject({ reason: 'stopped' });
    expect(end2).toBeGreaterThanOrEqual(0);
    expect(firstInfo3).toBeGreaterThan(end2);
    expect(seq.filter((m) => m.type !== 'info').length).toBe(2); // exactly one terminal each
    expect(l.invalid).toEqual([]);
  });

  it('clamps the hub-given limits to its own and the own limits to the hub-given ones', async () => {
    const s = await setup();
    const l = await registered(s);
    // The hub "allows" depth 99 and 8 threads: the node still enforces its own 20 / 2.
    open(l, 'wide', { ...LIMITS, maxDepth: 99, maxThreads: 8 });
    l.send({ type: 'client.msg', cid: 'wide', msg: analyze({ depth: 30 }) });
    expect(await terminal(l, 'wide', 1)).toMatchObject({ type: 'error', code: 'limit_exceeded' });
    l.send({ type: 'client.msg', cid: 'wide', msg: analyze({ searchId: 2, threads: 4 }) });
    expect(await terminal(l, 'wide', 2)).toMatchObject({ type: 'error', code: 'limit_exceeded' });
    // A narrower client: depth 3 and one session.
    open(l, 'narrow', { ...LIMITS, maxDepth: 3, maxSessionsPerConnection: 1 });
    l.send({ type: 'client.msg', cid: 'narrow', msg: analyze({ depth: 5 }) });
    expect(await terminal(l, 'narrow', 1)).toMatchObject({
      type: 'error',
      code: 'limit_exceeded',
      message: expect.stringContaining('3'),
    });
    l.send({ type: 'client.msg', cid: 'narrow', msg: analyze({ searchId: 2, depth: 3 }) });
    expect(await terminal(l, 'narrow', 2)).toMatchObject({ type: 'bestmove' });
    l.send({
      type: 'client.msg',
      cid: 'narrow',
      msg: analyze({ sessionId: 's2', searchId: 1, depth: 2 }),
    });
    expect(await terminal(l, 'narrow', 1, 's2')).toMatchObject({
      type: 'error',
      code: 'limit_exceeded',
    });
  });

  it('client.close stops and releases, then acknowledges; unknown cids are ignored and counted', async () => {
    const s = await setup();
    const l = await registered(s);
    open(l);
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ depth: undefined }) });
    await l.waitFor('client.msg', (m) => m.msg.type === 'info');
    expect(s.pool.sessions).toBe(1);
    l.send({ type: 'client.close', cid: 'c1' });
    await l.waitFor('client.closed', (f) => f.cid === 'c1');
    expect(s.pool.sessions).toBe(0);
    // Nothing for c1 after the ack; the running search was not "terminated" towards the hub.
    expect(l.relayed('c1').some((m) => m.type === 'bestmove')).toBe(false);
    await l.waitFor('node.status', (f) => f.sessions === 0 && l.of('node.status').length > 1);

    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ searchId: 2 }) });
    l.send({ type: 'client.msg', cid: 'ghost', msg: { type: 'stop', sessionId: 's1' } });
    await until(() => s.link.stats().counters.unknownCid === 2);
    // client.close is idempotent: an unknown cid is acknowledged at once.
    l.send({ type: 'client.close', cid: 'ghost' });
    await l.waitFor('client.closed', (f) => f.cid === 'ghost');
    expect(s.link.stats().clients).toBe(0);
  });

  it('caps info at N per second per search but always delivers bestmove', async () => {
    const s = await setup({ infoPerSecondPerSearch: 5 }, ['--info-interval=2']);
    const l = await registered(s);
    open(l);
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ depth: 20 }) });
    expect(await terminal(l, 'c1', 1)).toMatchObject({ type: 'bestmove', reason: 'completed' });
    const infos = l.relayed('c1').filter((m) => m.type === 'info');
    expect(infos.length).toBeLessThanOrEqual(5 * 2); // ≈ 40 ms of searching → 1-2 windows
    expect(infos.length).toBeGreaterThan(0);
    expect(s.link.stats().counters.droppedInfoRate).toBeGreaterThan(0);
  });

  it('drops info (never bestmove) while the socket buffers more than the limit', async () => {
    let pressure = false;
    const s = await setup({
      connect: (url) => {
        const ws = new WebSocket(url, { perMessageDeflate: false });
        const real = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!;
        Object.defineProperty(ws, 'bufferedAmount', {
          get: () => (pressure ? 2 * 1024 * 1024 : (real.get!.call(ws) as number)),
        });
        return ws as LinkSocket;
      },
    });
    const l = await registered(s);
    open(l);
    pressure = true;
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ depth: 8 }) });
    expect(await terminal(l, 'c1', 1)).toMatchObject({ type: 'bestmove', reason: 'completed' });
    expect(l.relayed('c1').filter((m) => m.type === 'info')).toEqual([]);
    expect(s.link.stats().counters.droppedInfoBackpressure).toBeGreaterThan(0);
    pressure = false;
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ searchId: 2, depth: 2 }) });
    await terminal(l, 'c1', 2);
    expect(l.relayed('c1').some((m) => m.type === 'info' && m.searchId === 2)).toBe(true);
  });

  it('exits non-zero on node.error bad_token and does not reconnect', async () => {
    const s = await setup();
    const l = await s.hub.link(0);
    await l.waitFor('node.hello');
    l.send({ type: 'node.error', code: 'bad_token', message: 'unknown node' });
    l.ws.close(1008, 'bad_token');
    await until(() => s.exit.mock.calls.length > 0);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.link.linkState).toBe('fatal');
    expect(s.link.stats().lastEnd).toMatchObject({ reason: 'bad_token', message: 'unknown node' });
    await new Promise((r) => setTimeout(r, 200)); // reconnect delay is 20-100 ms
    expect(s.hub.links).toHaveLength(1);
    expect(s.exit).toHaveBeenCalledTimes(1);
  });

  it('exits non-zero on link.close replaced, after closing every session', async () => {
    const s = await setup();
    const l = await registered(s);
    open(l);
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ depth: undefined }) });
    await l.waitFor('client.msg', (m) => m.msg.type === 'info');
    l.send({ type: 'link.close', reason: 'replaced', code: 4000 });
    await until(() => s.exit.mock.calls.length > 0);
    expect(s.exit).toHaveBeenCalledWith(1);
    expect(s.pool.sessions).toBe(0);
    expect(s.hub.links).toHaveLength(1);
  });

  it('reconnects with backoff after a non-fatal end and after a lost link; sessions are closed', async () => {
    const s = await setup();
    const l0 = await registered(s);
    l0.send({ type: 'node.error', code: 'rate_limited', message: 'slow down' });
    const l1 = await s.hub.link(1);
    await l1.waitFor('node.hello');
    expect(s.exit).not.toHaveBeenCalled();
    l1.welcome();
    await l1.waitFor('node.status');
    open(l1);
    l1.send({ type: 'client.msg', cid: 'c1', msg: analyze({ depth: undefined }) });
    await l1.waitFor('client.msg', (m) => m.msg.type === 'info');
    l1.ws.terminate(); // the hub vanishes mid-search
    await until(() => s.pool.sessions === 0);
    const l2 = await s.hub.link(2);
    await l2.waitFor('node.hello');
    expect(s.link.stats()).toMatchObject({ reconnects: 2, clients: 0 });
    // A cid of the old link is unknown on the new one.
    l2.welcome();
    await l2.waitFor('node.status');
    l2.send({ type: 'client.msg', cid: 'c1', msg: { type: 'stop', sessionId: 's1' } });
    await until(() => s.link.stats().counters.unknownCid === 1);
  });

  it('drops a link whose hub stops answering pings, then reconnects', async () => {
    const s = await setup({}, [], { autoPong: false });
    const l0 = await registered(s, { heartbeatMs: 1_000 });
    const closed = await l0.waitClosed(6_000);
    expect(closed.code).toBe(1006);
    expect(s.link.stats().lastEnd).toMatchObject({ reason: 'heartbeat' });
    await s.hub.link(1, 2_000);
  }, 10_000);

  it('drain: node.drain, refuses new clients, waits for running searches, then closes 1000', async () => {
    const s = await setup();
    const l = await registered(s);
    open(l);
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ depth: undefined, movetime: 300 }) });
    await l.waitFor('client.msg', (m) => m.msg.type === 'info');
    const drained = s.link.drain('shutdown');
    await l.waitFor('node.drain');
    expect(l.of('node.drain')[0]).toEqual({ type: 'node.drain', reason: 'shutdown' });
    expect(s.link.linkState).toBe('draining');
    open(l, 'late');
    await l.waitFor('client.closed', (f) => f.cid === 'late');
    expect(await terminal(l, 'c1', 1)).toMatchObject({ type: 'bestmove' });
    await drained;
    expect((await l.waitClosed()).code).toBe(1000);
    expect(l.of('client.closed').map((f) => f.cid)).toEqual(['late', 'c1']);
    expect(s.pool.sessions).toBe(0);
    expect(s.link.linkState).toBe('stopped');
    await new Promise((r) => setTimeout(r, 150));
    expect(s.hub.links).toHaveLength(1); // no reconnect after a drain
  });

  it('drain gives up after the hub drainMs and closes everything', async () => {
    const s = await setup();
    const l = await registered(s, { drainMs: 200 });
    open(l);
    l.send({ type: 'client.msg', cid: 'c1', msg: analyze({ depth: undefined }) });
    await l.waitFor('client.msg', (m) => m.msg.type === 'info');
    const t0 = Date.now();
    await s.link.drain();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(180);
    expect(s.pool.sessions).toBe(0);
    expect((await l.waitClosed()).code).toBe(1000);
    // The infinite search was never terminated towards the hub (the hub sends engine_crashed).
    expect(l.relayed('c1').some((m) => m.type === 'bestmove')).toBe(false);
  });

  it('drain without a link resolves at once and stops reconnecting', async () => {
    const s = await setup({ hubUrl: 'ws://127.0.0.1:1/link' });
    await until(() => s.link.linkState === 'backoff');
    await s.link.drain();
    expect(s.link.linkState).toBe('stopped');
    expect(s.link.stats().nextRetryAt).toBeNull();
  });
});
