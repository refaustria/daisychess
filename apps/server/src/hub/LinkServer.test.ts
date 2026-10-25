import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  LINK_PROTOCOL_VERSION,
  formatToken,
  parseHubToNodeMessage,
  type HubToNodeMessage,
  type Limits,
  type NodeHelloMessage,
  type NodeToHubMessage,
} from '@daisychess/engine-core';
import type { AnalysisServerMessage } from '../sessions/ClientSessions.js';
import { until } from '../../test/helpers.js';
import { LINK_CLOSE_CODES, LinkServer, type LinkServerOptions } from './LinkServer.js';
import { NodeRegistry, type NodeRegistryEvent } from './NodeRegistry.js';
import type { NodeRecord } from './store/HubStore.js';
import type { NodeVerifyResult } from './tokens.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const LIMITS: Limits = {
  maxDepth: 20,
  maxMultipv: 3,
  maxThreads: 2,
  maxHash: 64,
  maxMovetimeMs: 60_000,
  maxSessionsPerConnection: 2,
};

const NODE_A = 'aaaaaaaa';
const NODE_B = 'bbbbbbbb';
const tokenOf = (id: string, c = 'a') => formatToken('node', id, c.repeat(32));
const TOKEN_A = tokenOf(NODE_A);
const TOKEN_B = tokenOf(NODE_B);
const REVOKED = tokenOf('rrrrrrrr');

const record = (id: string, over: Partial<NodeRecord> = {}): NodeRecord => ({
  id,
  operatorId: 'op000001',
  name: `box-${id.slice(0, 2)}`,
  pool: true,
  poolShare: 2,
  state: 'normal',
  suspectCount: 0,
  suspectUntil: null,
  maxSessionsSeen: null,
  lastVersion: null,
  createdAt: 0,
  lastSeenAt: null,
  revokedAt: null,
  prevExpiresAt: null,
  poolBannedAt: null,
  poolBanReason: null,
  ...over,
});

/** Fake `HubTokenService.verifyNodeToken`: exact token strings. */
const auth = {
  verifyNodeToken(raw: unknown): NodeVerifyResult {
    if (raw === TOKEN_A) return { kind: 'node', record: record(NODE_A) };
    if (raw === TOKEN_B) return { kind: 'node', record: record(NODE_B, { pool: false }) };
    if (raw === REVOKED) return { error: 'revoked' };
    return { error: 'bad_token' };
  },
};

const hello = (over: Partial<NodeHelloMessage> = {}): NodeHelloMessage => ({
  type: 'node.hello',
  linkVersion: LINK_PROTOCOL_VERSION,
  nodeToken: TOKEN_A,
  node: { version: '0.3.0', platform: 'linux', arch: 'x64' },
  engines: [{ id: 'fake', name: 'Fake', enabled: true, defaults: { threads: 1, hash: 16 } }],
  limits: LIMITS,
  maxSessions: 4,
  pool: true,
  ...over,
});

/** A raw `ws` client standing in for a node. */
class FakeNode {
  readonly frames: HubToNodeMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  status: number | null = null;
  private waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const p = parseHubToNodeMessage(data.toString());
      if (p.ok) this.frames.push(p.message);
      this.wake();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake();
    });
    ws.on('unexpected-response', (_req, res) => {
      this.status = res.statusCode ?? null;
      this.closed = { code: -1, reason: `http ${res.statusCode}` };
      this.wake();
    });
    ws.on('error', () => {});
  }

  static async connect(url: string, opts: WebSocket.ClientOptions = {}): Promise<FakeNode> {
    const node = new FakeNode(new WebSocket(url, { perMessageDeflate: false, ...opts }));
    await new Promise<void>((resolve) => {
      node.ws.once('open', () => resolve());
      node.ws.once('close', () => resolve());
      node.ws.once('unexpected-response', () => resolve());
    });
    return node;
  }

  send(msg: NodeToHubMessage | Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  of<T extends HubToNodeMessage['type']>(type: T): Extract<HubToNodeMessage, { type: T }>[] {
    return this.frames.filter((f): f is Extract<HubToNodeMessage, { type: T }> => f.type === type);
  }

  wait<T extends HubToNodeMessage['type']>(
    type: T,
    pred: (f: Extract<HubToNodeMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<HubToNodeMessage, { type: T }>> {
    return this.until(() => this.of(type).find(pred), `frame ${type}`);
  }

  waitClosed(): Promise<{ code: number; reason: string }> {
    return this.until(() => this.closed ?? undefined, 'close');
  }

  /** Sends `node.hello` and waits for `node.welcome`. */
  async register(over: Partial<NodeHelloMessage> = {}) {
    this.send(hello(over));
    return this.wait('node.welcome');
  }

  private until<T>(get: () => T | undefined, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake node: no ${what}`)), 5_000);
      const check = () => {
        const v = get();
        if (v === undefined) {
          this.waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve(v);
      };
      check();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

interface Harness {
  url: string;
  link: LinkServer;
  registry: NodeRegistry;
  events: NodeRegistryEvent[];
  seen: ReturnType<typeof vi.fn>;
  nodes: FakeNode[];
  connect(opts?: WebSocket.ClientOptions): Promise<FakeNode>;
}

let server: http.Server | null = null;
let current: Harness | null = null;

afterEach(async () => {
  for (const n of current?.nodes ?? []) n.ws.terminate();
  await current?.link.close();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server?.closeAllConnections();
  server = null;
  current = null;
});

async function start(over: Partial<LinkServerOptions> = {}): Promise<Harness> {
  const registry = new NodeRegistry(silent);
  const events: NodeRegistryEvent[] = [];
  registry.onChange((e) => events.push(e));
  const seen = vi.fn(() => true);
  const link = new LinkServer({
    auth,
    seen: { markNodeSeen: seen },
    registry,
    logger: silent,
    hubVersion: '0.5.0',
    minNodeVersion: '0.2.0',
    latestNodeVersion: '0.4.0',
    ...over,
  });
  server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => link.handleUpgrade(req, socket, head));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  const nodes: FakeNode[] = [];
  const h: Harness = {
    url,
    link,
    registry,
    events,
    seen,
    nodes,
    async connect(opts) {
      const n = await FakeNode.connect(url, opts);
      nodes.push(n);
      return n;
    },
  };
  current = h;
  return h;
}

describe('LinkServer handshake', () => {
  it('welcomes a valid node and registers it', async () => {
    const h = await start({ heartbeatMs: 5_000, drainMs: 20_000 });
    const n = await h.connect();
    const welcome = await n.register();
    expect(welcome).toEqual({
      type: 'node.welcome',
      linkVersion: LINK_PROTOCOL_VERSION,
      hubVersion: '0.5.0',
      nodeId: NODE_A,
      name: 'box-aa',
      pool: true,
      heartbeatMs: 5_000,
      drainMs: 20_000,
      minNodeVersion: '0.2.0',
      latestNodeVersion: '0.4.0',
    });
    const entry = h.registry.get(NODE_A);
    expect(entry).toMatchObject({
      nodeId: NODE_A,
      name: 'box-aa',
      operatorId: 'op000001',
      version: '0.3.0',
      platform: 'linux',
      arch: 'x64',
      maxSessions: 4,
      pool: true,
      poolShare: 2,
      state: 'online',
      status: null,
      limits: LIMITS,
    });
    expect(entry?.engines.map((e) => e.id)).toEqual(['fake']);
    expect(h.registry.poolCandidates().map((e) => e.nodeId)).toEqual([NODE_A]);
    expect(h.events.map((e) => e.type)).toEqual(['online']);
    expect(h.seen).toHaveBeenCalledWith(NODE_A, expect.any(Number), {
      version: '0.3.0',
      maxSessions: 4,
    });
    const stats = h.link.stats();
    expect(stats.nodes).toEqual([
      expect.objectContaining({ nodeId: NODE_A, state: 'online', clients: 0, engines: ['fake'] }),
    ]);
    expect(JSON.stringify(stats)).not.toContain(TOKEN_A);
  });

  it('effective pool membership needs both the node switch and the portal setting', async () => {
    const h = await start();
    const off = await h.connect();
    expect((await off.register({ pool: false })).pool).toBe(false);
    const portalOff = await h.connect();
    expect((await portalOff.register({ nodeToken: TOKEN_B, pool: true })).pool).toBe(false);
    expect(h.registry.poolCandidates()).toEqual([]);
  });

  it.each([
    ['a wrong token', `dcn_aaaaaaaa_${'b'.repeat(32)}`, 'bad_token'],
    ['a malformed token', 'nope', 'bad_token'],
    ['a player token', `dc1_aaaaaaaa_${'a'.repeat(32)}`, 'bad_token'],
    ['a revoked node', REVOKED, 'revoked'],
  ])('refuses %s with node.error and close 1008', async (_what, nodeToken, code) => {
    const h = await start();
    const n = await h.connect();
    n.send(hello({ nodeToken }));
    expect(await n.wait('node.error')).toMatchObject({ code });
    expect((await n.waitClosed()).code).toBe(1008);
    expect(h.registry.size).toBe(0);
    expect(n.of('node.welcome')).toEqual([]);
    expect(h.link.stats().counters.refused[code]).toBe(1);
  });

  it('refuses an outdated node (NODE_MIN_VERSION) and a different link version', async () => {
    const h = await start({ minNodeVersion: '0.3.1' });
    const old = await h.connect();
    old.send(hello());
    expect(await old.wait('node.error')).toMatchObject({ code: 'node_outdated' });
    expect((await old.waitClosed()).code).toBe(1008);
    const other = await h.connect();
    other.send(
      hello({ node: { version: '9.9.9', platform: 'linux', arch: 'x64' }, linkVersion: 2 }),
    );
    expect(await other.wait('node.error')).toMatchObject({ code: 'link_version' });
  });

  it('refuses a first frame that is not a node.hello, and a silent socket after the timeout', async () => {
    const h = await start({ helloTimeoutMs: 100 });
    const n = await h.connect();
    n.send({ type: 'node.status', sessions: 0, maxSessions: 1, load1: 0, engines: [] });
    expect(await n.wait('node.error')).toMatchObject({ code: 'invalid_message' });
    expect((await n.waitClosed()).code).toBe(1008);
    const garbage = await h.connect();
    garbage.ws.send('{not json');
    expect(await garbage.wait('node.error')).toMatchObject({ code: 'invalid_message' });
    const silentNode = await h.connect();
    expect(await silentNode.wait('node.error')).toMatchObject({
      code: 'invalid_message',
      message: expect.stringContaining('no node.hello'),
    });
    expect((await silentNode.waitClosed()).code).toBe(1008);
  });

  it('a newer link for the same node wins; the older gets link.close replaced and its relays end', async () => {
    const h = await start();
    const first = await h.connect();
    await first.register();
    const oldLink = h.registry.get(NODE_A)!.link;
    const out: AnalysisServerMessage[] = [];
    const relay = oldLink.open(
      (m) => out.push(m),
      { ip: '198.51.100.1', id: 1 },
      {
        limits: LIMITS,
        shared: false,
        tier: 'full',
      },
    );
    relay.handle({
      type: 'analyze',
      sessionId: 's',
      searchId: 1,
      engine: 'fake',
      fen: FEN,
      depth: 3,
    });
    await first.wait('client.msg');

    const second = await h.connect();
    await second.register();
    expect(await first.wait('link.close')).toEqual({
      type: 'link.close',
      reason: 'replaced',
      code: LINK_CLOSE_CODES.replaced,
      message: expect.any(String),
    });
    expect((await first.waitClosed()).code).toBe(LINK_CLOSE_CODES.replaced);
    expect(out).toEqual([
      expect.objectContaining({ code: 'engine_crashed', sessionId: 's', searchId: 1 }),
    ]);
    await relay.lost;
    const entry = h.registry.get(NODE_A)!;
    expect(entry.link).not.toBe(oldLink);
    expect(entry.link.isOpen).toBe(true);
    expect(h.events.map((e) => e.type)).toEqual(['online', 'offline', 'online']);
    expect(second.closed).toBeNull();
    expect(h.link.stats().counters.replaced).toBe(1);
  });
});

describe('LinkServer established links', () => {
  it('node.status updates the registry; node.drain marks it draining', async () => {
    const h = await start();
    const n = await h.connect();
    await n.register();
    n.send({
      type: 'node.status',
      sessions: 1,
      maxSessions: 3,
      load1: 0.5,
      engines: [{ id: 'fake', busy: 1, idle: 0, degraded: false }],
    });
    await until(() => h.registry.get(NODE_A)?.status !== null);
    expect(h.registry.get(NODE_A)).toMatchObject({
      maxSessions: 3,
      status: { sessions: 1, maxSessions: 3, load1: 0.5, engines: [{ id: 'fake', busy: 1 }] },
    });
    expect(h.seen).toHaveBeenLastCalledWith(NODE_A, expect.any(Number), { maxSessions: 3 });
    n.send({ type: 'node.drain', reason: 'shutdown' });
    await until(() => h.registry.get(NODE_A)?.state === 'draining');
    expect(h.registry.get(NODE_A)?.drainReason).toBe('shutdown');
    expect(h.registry.poolCandidates()).toEqual([]);
    expect(h.registry.online().map((e) => e.nodeId)).toEqual([NODE_A]);
    expect(h.events.map((e) => e.type)).toEqual(['online', 'status', 'draining']);
    // The link stays up until the node closes it.
    expect(n.closed).toBeNull();
    n.ws.close(1000);
    await until(() => h.registry.size === 0);
    expect(h.events.at(-1)?.type).toBe('offline');
  });

  it('relays a search both ways unchanged; node disconnect ends it with engine_crashed', async () => {
    const h = await start();
    const n = await h.connect();
    await n.register();
    const out: AnalysisServerMessage[] = [];
    const relay = h.registry
      .get(NODE_A)!
      .link.open(
        (m) => out.push(m),
        { ip: '198.51.100.1', id: 7 },
        { limits: LIMITS, shared: true, tier: 'standard', tokenId: 'abcdefgh', label: 'x' },
      );
    const open = await n.wait('client.open');
    expect(open).toEqual({
      type: 'client.open',
      cid: relay.cid,
      limits: LIMITS,
      shared: true,
      tier: 'standard',
    });
    const analyze = {
      type: 'analyze' as const,
      sessionId: 's',
      searchId: 1,
      engine: 'fake',
      fen: FEN,
      depth: 3,
    };
    relay.handle(analyze);
    expect((await n.wait('client.msg')).msg).toEqual(analyze);
    const info = {
      type: 'info' as const,
      sessionId: 's',
      searchId: 1,
      info: { depth: 1, multipv: 1, score: { cp: 20 }, pv: ['e2e4'] },
    };
    const bm = {
      type: 'bestmove' as const,
      sessionId: 's',
      searchId: 1,
      bestMove: { move: 'e2e4' },
      reason: 'completed' as const,
    };
    n.send({ type: 'client.msg', cid: relay.cid, msg: info });
    n.send({ type: 'client.msg', cid: relay.cid, msg: bm });
    await until(() => out.length === 2);
    expect(out).toEqual([info, bm]);
    expect(h.link.stats().nodes[0]?.clients).toBe(1);

    relay.handle({ ...analyze, searchId: 2 });
    await n.wait('client.msg', (f) => f.msg.type === 'analyze' && f.msg.searchId === 2);
    n.ws.terminate();
    await relay.lost;
    expect(out.slice(2)).toEqual([
      expect.objectContaining({ code: 'engine_crashed', sessionId: 's', searchId: 2 }),
    ]);
    expect(h.registry.size).toBe(0);
  });

  it('drops a node that stops answering pings', async () => {
    const h = await start({ pingIntervalMs: 40, missedPongsToDrop: 2 });
    const n = await h.connect({ autoPong: false });
    await n.register();
    await n.waitClosed();
    expect(h.registry.size).toBe(0);
    expect(h.link.stats().counters.heartbeatDrops).toBe(1);
  });

  it('keeps a node that answers pings and records its round trip', async () => {
    const h = await start({ pingIntervalMs: 30 });
    const n = await h.connect();
    await n.register();
    await until(() => h.registry.get(NODE_A)?.rttMs !== null);
    await new Promise((r) => setTimeout(r, 150));
    expect(n.closed).toBeNull();
    expect(h.registry.get(NODE_A)?.rttMs).toBeGreaterThanOrEqual(0);
  });

  it('closes a link that sends too many frames per second with link.close rate_limited', async () => {
    const h = await start({ maxMessagesPerSecond: 10 });
    const n = await h.connect();
    await n.register();
    const status = { type: 'node.status', sessions: 0, maxSessions: 4, load1: 0, engines: [] };
    for (let i = 0; i < 20; i++) n.send(status);
    expect(await n.wait('link.close')).toMatchObject({
      reason: 'rate_limited',
      code: LINK_CLOSE_CODES.rate_limited,
    });
    expect((await n.waitClosed()).code).toBe(LINK_CLOSE_CODES.rate_limited);
    expect(h.registry.size).toBe(0);
  });

  it('ignores and counts frames for unknown cids, closing rate_limited above the limit', async () => {
    const h = await start({ unknownCidLimit: { max: 5, windowMs: 60_000 } });
    const n = await h.connect();
    await n.register();
    for (let i = 0; i < 5; i++) n.send({ type: 'client.closed', cid: `nope${i}` });
    await until(() => h.link.stats().nodes[0]?.unknownCid === 5);
    expect(n.closed).toBeNull();
    n.send({ type: 'client.closed', cid: 'one-more' });
    expect(await n.wait('link.close')).toMatchObject({ reason: 'rate_limited' });
    await n.waitClosed();
  });

  it('ignores invalid frames up to a limit', async () => {
    const h = await start({ invalidFrameLimit: { max: 3, windowMs: 60_000 } });
    const n = await h.connect();
    await n.register();
    n.send({
      type: 'client.msg',
      cid: 'x',
      msg: { type: 'error', code: 'internal_error', message: 'conn-level' },
    });
    n.send({ type: 'nonsense' });
    n.send(hello());
    await until(() => h.link.stats().counters.invalidFrames === 3);
    expect(n.closed).toBeNull();
    n.ws.send(Buffer.from([1, 2, 3]));
    expect(await n.wait('link.close')).toMatchObject({ reason: 'rate_limited' });
  });

  it('closes a link that sends a frame above MAX_LINK_MESSAGE_BYTES (1009)', async () => {
    const h = await start();
    const n = await h.connect();
    await n.register();
    n.ws.send('x'.repeat(21 * 1024));
    expect((await n.waitClosed()).code).toBe(1009);
    await until(() => h.registry.size === 0);
  });

  it('caps concurrent links per address', async () => {
    const h = await start({ maxPerIp: 2 });
    const a = await h.connect();
    const b = await h.connect();
    const c = await h.connect();
    expect(a.closed).toBeNull();
    expect(b.closed).toBeNull();
    expect(c.status).toBe(429);
    a.ws.close();
    await a.waitClosed();
    await until(async () => {
      const d = await FakeNode.connect(h.url);
      h.nodes.push(d);
      return d.status === null;
    });
    expect(h.link.stats().counters.rejectedPerIp).toBeGreaterThanOrEqual(1);
  });

  it('closeNode ends a link with the given reason', async () => {
    const h = await start();
    const n = await h.connect();
    await n.register();
    expect(h.link.closeNode(NODE_A, 'revoked')).toBe(true);
    expect(await n.wait('link.close')).toMatchObject({ reason: 'revoked', code: 4403 });
    expect(h.registry.size).toBe(0);
    expect(h.link.closeNode(NODE_A, 'revoked')).toBe(false);
  });

  it('close() sends link.close shutdown (1012), ends relays and refuses new links', async () => {
    const h = await start();
    const n = await h.connect();
    await n.register();
    const out: AnalysisServerMessage[] = [];
    const relay = h.registry.get(NODE_A)!.link.open(
      (m) => out.push(m),
      { ip: 'x', id: 1 },
      {
        limits: LIMITS,
        shared: false,
        tier: 'full',
      },
    );
    relay.handle({
      type: 'analyze',
      sessionId: 's',
      searchId: 1,
      engine: 'fake',
      fen: FEN,
      depth: 3,
    });
    const closing = h.link.close();
    expect(await n.wait('link.close')).toMatchObject({ reason: 'shutdown', code: 1012 });
    expect((await n.waitClosed()).code).toBe(1012);
    await closing;
    expect(out).toEqual([expect.objectContaining({ code: 'engine_crashed', searchId: 1 })]);
    const late = await FakeNode.connect(h.url);
    expect(late.status).toBe(503);
  });

  it('serves only its path', async () => {
    const h = await start();
    const n = await FakeNode.connect(h.url.replace('/link', '/other'));
    expect(n.status).toBe(404);
  });
});
