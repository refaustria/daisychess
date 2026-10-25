import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubToNodeMessage, NodeWelcomeMessage } from '@daisychess/engine-core';
import type { AnalysisBackend } from '../sessions/AnalysisBackend.js';
import { NodeLink, type LinkSocket, type NodeLinkOptions } from './NodeLink.js';

/** Scriptable socket: the test opens, feeds and closes it; closes are emitted asynchronously. */
class FakeSocket extends EventEmitter implements LinkSocket {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: { type: string; [k: string]: unknown }[] = [];
  pings = 0;
  terminated = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { type: string });
  }
  ping(): void {
    this.pings++;
  }
  close(code = 1000, reason = ''): void {
    this.end(code, reason);
  }
  terminate(): void {
    this.terminated = true;
    this.end(1006, '');
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  receive(msg: HubToNodeMessage | string): void {
    this.emit('message', Buffer.from(typeof msg === 'string' ? msg : JSON.stringify(msg)), false);
  }
  /** Connection failure before `open` (refused, DNS, 5xx). */
  fail(): void {
    this.emit('error', new Error('ECONNREFUSED'));
    this.end(1006, '');
  }
  private end(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', code, Buffer.from(reason)));
  }
}

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const backend: AnalysisBackend = {
  acquire: async () => ({ ok: false, code: 'no_capacity', message: 'none' }),
  release: async () => {},
  reportHealthy: () => {},
  health: () => ({ available: true, sessions: 0 }),
};

const WELCOME: NodeWelcomeMessage = {
  type: 'node.welcome',
  linkVersion: 1,
  hubVersion: '0.1.0',
  nodeId: 'abcdefgh',
  name: 'box',
  pool: false,
  heartbeatMs: 10_000,
  drainMs: 30_000,
  minNodeVersion: '0.0.0',
  latestNodeVersion: '0.3.0',
};

let sockets: FakeSocket[];
let link: NodeLink;

function make(over: Partial<NodeLinkOptions> = {}): NodeLink {
  link = new NodeLink({
    hubUrl: 'wss://hub.example/link',
    token: `dcn_abcdefgh_${'a'.repeat(32)}`,
    version: '0.3.0',
    engines: [],
    limits: {
      maxDepth: 20,
      maxMultipv: 1,
      maxThreads: 1,
      maxHash: 16,
      maxMovetimeMs: 10_000,
      maxSessionsPerConnection: 1,
    },
    maxSessions: 1,
    pool: false,
    backend,
    engineStatus: () => [],
    logger: silent,
    sessionIdleMs: 60_000,
    exit: vi.fn(),
    random: () => 0.5, // no jitter
    load1: () => 0,
    connect: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    ...over,
  });
  return link;
}

const last = () => sockets[sockets.length - 1]!;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  for (const fn of Object.values(silent)) fn.mockClear();
});

afterEach(async () => {
  const closing = link.close();
  await vi.runAllTimersAsync();
  await closing;
  vi.useRealTimers();
});

describe('NodeLink timers (fake socket)', () => {
  it('reconnects with exponential backoff 1 s → 60 s, forever', async () => {
    make().start();
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000];
    for (const [i, delay] of expected.entries()) {
      last().fail();
      await flush();
      expect(link.stats()).toMatchObject({ state: 'backoff', attempt: i + 1 });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(sockets).toHaveLength(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(i + 2);
    }
    expect(link.stats().reconnects).toBe(expected.length);
  });

  it('applies ±20 % jitter', async () => {
    make({ random: () => 0 }).start();
    last().fail();
    await flush();
    await vi.advanceTimersByTimeAsync(799);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
  });

  it('a link that stayed up ≥ 60 s starts the backoff afresh; a flapping one keeps growing', async () => {
    make().start();
    last().fail();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    last().fail();
    await flush();
    await vi.advanceTimersByTimeAsync(2_000); // attempt 2 used
    const s = last();
    s.open();
    s.receive(WELCOME);
    await vi.advanceTimersByTimeAsync(5_000); // up for 5 s only (pongs not needed yet)
    s.close(1001, 'gone');
    await flush();
    expect(link.stats().attempt).toBe(3); // 4 s
    await vi.advanceTimersByTimeAsync(4_000);
    const s2 = last();
    s2.open();
    s2.receive(WELCOME);
    // Answer pings for 70 s so the heartbeat keeps the link.
    for (let t = 0; t < 7; t++) {
      await vi.advanceTimersByTimeAsync(10_000);
      s2.emit('pong');
    }
    s2.close(1012, 'restart');
    await flush();
    expect(link.stats().attempt).toBe(1);
    expect(link.stats().nextRetryAt).not.toBeNull();
  });

  it('terminates and retries when node.welcome does not arrive in time', async () => {
    make({ welcomeTimeoutMs: 15_000 }).start();
    last().open();
    expect(last().sent[0]).toMatchObject({ type: 'node.hello', linkVersion: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets[0]!.terminated).toBe(true);
    expect(link.stats()).toMatchObject({
      state: 'backoff',
      lastEnd: { reason: 'welcome_timeout' },
    });
  });

  it('pings every heartbeatMs with node.status; two unanswered pings drop the link', async () => {
    make().start();
    const s = last();
    s.open();
    s.receive({ ...WELCOME, heartbeatMs: 1_000 });
    await flush();
    expect(s.sent.filter((m) => m.type === 'node.status')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.pings).toBe(1);
    s.emit('pong'); // answered: counter resets
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.pings).toBe(3);
    expect(s.terminated).toBe(false);
    expect(s.sent.filter((m) => m.type === 'node.status')).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_000); // two pings outstanding → drop
    expect(s.terminated).toBe(true);
    await flush();
    expect(link.stats()).toMatchObject({ state: 'backoff', lastEnd: { reason: 'heartbeat' } });
  });

  it('logs "a newer node is available" at most once per day; outdated warns', async () => {
    make({ version: '0.2.0' }).start();
    const s = last();
    s.open();
    s.receive(WELCOME);
    await flush();
    const notices = () =>
      silent.info.mock.calls.filter((c) => c[1] === 'link: a newer node is available').length;
    expect(notices()).toBe(1);
    s.close();
    await vi.advanceTimersByTimeAsync(1_000);
    last().open();
    last().receive(WELCOME);
    await flush();
    expect(notices()).toBe(1);
    last().close();
    await vi.advanceTimersByTimeAsync(86_400_000);
    // still reconnecting with backoff; connect once more after a day
    last().open();
    last().receive({ ...WELCOME, minNodeVersion: '0.2.5' });
    await flush();
    expect(notices()).toBe(0 + 1); // outdated takes precedence over update_available
    expect(silent.warn.mock.calls.some((c) => String(c[1]).includes('below the hub minimum'))).toBe(
      true,
    );
  });

  it('counts invalid frames and ignores client frames before node.welcome', async () => {
    make().start();
    const s = last();
    s.open();
    s.receive('not json');
    s.receive('{"type":"node.welcome"}');
    s.receive({ type: 'client.close', cid: 'c1' });
    s.emit('message', Buffer.from([1, 2, 3]), true);
    expect(link.stats().counters.invalidFrames).toBe(4);
    expect(s.sent.map((m) => m.type)).toEqual(['node.hello']);
  });

  it('a welcome with another linkVersion is a fatal link_version end', async () => {
    const exit = vi.fn();
    make({ exit }).start();
    last().open();
    last().receive({ ...WELCOME, linkVersion: 2 });
    await vi.advanceTimersByTimeAsync(10);
    expect(exit).toHaveBeenCalledWith(1);
    expect(link.linkState).toBe('fatal');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('client.open is answered with client.closed while draining or beyond maxClients', async () => {
    make({ maxClients: 1 }).start();
    const s = last();
    s.open();
    s.receive(WELCOME);
    const limits = {
      maxDepth: 20,
      maxMultipv: 1,
      maxThreads: 1,
      maxHash: 16,
      maxMovetimeMs: 10_000,
      maxSessionsPerConnection: 1,
    };
    s.receive({ type: 'client.open', cid: 'a', limits, shared: false, tier: 'full' });
    s.receive({ type: 'client.open', cid: 'b', limits, shared: false, tier: 'full' });
    s.receive({ type: 'client.open', cid: 'a', limits, shared: false, tier: 'full' }); // duplicate
    expect(s.sent.filter((m) => m.type === 'client.closed')).toEqual([
      { type: 'client.closed', cid: 'b' },
    ]);
    expect(link.stats()).toMatchObject({
      clients: 1,
      counters: { rejectedClients: 1, invalidFrames: 1 },
    });
  });
});
