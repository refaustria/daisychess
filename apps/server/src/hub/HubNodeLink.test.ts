import { describe, expect, it, vi } from 'vitest';
import {
  LINK_BOUNDS,
  type ClientOpenMessage,
  type HubToNodeMessage,
  type Limits,
} from '@daisychess/engine-core';
import type { AnalysisServerMessage } from '../sessions/ClientSessions.js';
import { HubNodeLink, type HubNodeLinkOptions, type RouteContext } from './HubNodeLink.js';

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
const PRIVATE: RouteContext = {
  limits: LIMITS,
  shared: false,
  tier: 'full',
  tokenId: 'abcdefgh',
  label: "Anna's iPad",
};
const POOL: RouteContext = { ...PRIVATE, shared: true, tier: 'standard' };
const peer = { ip: '203.0.113.7', id: 1 };

function setup(over: Partial<HubNodeLinkOptions> = {}) {
  const sent: HubToNodeMessage[] = [];
  let up = true;
  const onAbuse = vi.fn();
  const link = new HubNodeLink({
    nodeId: 'node0001',
    send: (m) => {
      if (!up) return false;
      sent.push(m);
      return true;
    },
    logger: silent,
    onAbuse,
    ...over,
  });
  return {
    link,
    sent,
    onAbuse,
    down: () => {
      up = false;
    },
  };
}

const opens = (sent: HubToNodeMessage[]) =>
  sent.filter((m): m is ClientOpenMessage => m.type === 'client.open');

describe('HubNodeLink', () => {
  it('allocates unique, unpredictable cids and sends client.open with the route', () => {
    const { link, sent } = setup();
    const a = link.open(() => {}, peer, PRIVATE);
    const b = link.open(() => {}, peer, PRIVATE);
    expect(a.cid).not.toBe(b.cid);
    for (const cid of [a.cid, b.cid]) {
      expect(cid).toMatch(LINK_BOUNDS.cidPattern);
      expect(cid).toHaveLength(16); // 96 random bits
    }
    // Not a counter: a second link does not repeat the first one's cids.
    const other = setup().link.open(() => {}, peer, PRIVATE);
    expect([a.cid, b.cid]).not.toContain(other.cid);
    expect(opens(sent)[0]).toEqual({
      type: 'client.open',
      cid: a.cid,
      limits: LIMITS,
      shared: false,
      tier: 'full',
      tokenId: 'abcdefgh',
      label: "Anna's iPad",
    });
    expect(link.clients).toBe(2);
    expect(a.nodeId).toBe('node0001');
  });

  it('never tells a pool node the token id or label', () => {
    const { link, sent } = setup();
    link.open(() => {}, peer, POOL);
    const [open] = opens(sent);
    expect(open).toEqual({
      type: 'client.open',
      cid: expect.any(String),
      limits: LIMITS,
      shared: true,
      tier: 'standard',
    });
  });

  it('retries a colliding cid and rejects an invalid route', () => {
    const ids = ['dup', 'dup', 'fresh'];
    const { link } = setup({ randomCid: () => ids.shift() ?? 'x' });
    expect(link.open(() => {}, peer, PRIVATE).cid).toBe('dup');
    expect(link.open(() => {}, peer, PRIVATE).cid).toBe('fresh');
    expect(() =>
      link.open(() => {}, peer, { ...PRIVATE, limits: { ...LIMITS, maxDepth: 1_000 } }),
    ).toThrow(/invalid route/);
    expect(link.clients).toBe(2);
  });

  it('dispatches client.msg to its relay and client.closed to its close()', async () => {
    const { link, sent } = setup();
    const outA: AnalysisServerMessage[] = [];
    const outB: AnalysisServerMessage[] = [];
    const a = link.open((m) => outA.push(m), peer, PRIVATE);
    const b = link.open((m) => outB.push(m), peer, PRIVATE);
    a.handle({ type: 'analyze', sessionId: 's', searchId: 1, engine: 'fake', fen: FEN, depth: 3 });
    expect(sent.at(-1)).toMatchObject({ type: 'client.msg', cid: a.cid, msg: { type: 'analyze' } });
    const bm = {
      type: 'bestmove' as const,
      sessionId: 's',
      searchId: 1,
      bestMove: { move: 'e2e4' },
      reason: 'completed' as const,
    };
    link.onFrame({ type: 'client.msg', cid: a.cid, msg: bm });
    expect(outA).toEqual([bm]);
    expect(outB).toEqual([]);

    const closing = b.close();
    expect(sent.at(-1)).toEqual({ type: 'client.close', cid: b.cid });
    link.onFrame({ type: 'client.closed', cid: b.cid });
    await closing;
    expect(link.clients).toBe(1);
    expect(link.stats()).toMatchObject({ clients: 1, opened: 2, unknownCid: 0 });
  });

  it('ignores late frames of a finished cid without counting them as unknown', async () => {
    const { link } = setup();
    const a = link.open(() => {}, peer, PRIVATE);
    const p = a.close();
    link.onFrame({ type: 'client.closed', cid: a.cid });
    await p;
    link.onFrame({ type: 'client.closed', cid: a.cid });
    expect(link.stats().unknownCid).toBe(0);
  });

  it('counts unknown cids and reports abuse once above 100 per minute', () => {
    let now = 0;
    const { link, onAbuse } = setup({ now: () => now });
    for (let i = 0; i < 100; i++) link.onFrame({ type: 'client.closed', cid: `u${i}` });
    expect(onAbuse).not.toHaveBeenCalled();
    now = 59_000;
    link.onFrame({ type: 'client.closed', cid: 'one-more' });
    expect(onAbuse).toHaveBeenCalledTimes(1);
    expect(onAbuse).toHaveBeenCalledWith('rate_limited', expect.stringContaining('unknown cid'));
    link.onFrame({ type: 'client.closed', cid: 'again' });
    expect(onAbuse).toHaveBeenCalledTimes(1);
    expect(link.stats().unknownCid).toBe(102);
  });

  it('spreads out over time: 100 per minute are tolerated indefinitely', () => {
    let now = 0;
    const { link, onAbuse } = setup({ now: () => now });
    for (let i = 0; i < 300; i++) {
      now = i * 700; // ~86 per minute
      link.onFrame({ type: 'client.closed', cid: `u${i}` });
    }
    expect(onAbuse).not.toHaveBeenCalled();
  });

  it('on loss ends every relay with terminals; open() afterwards returns a lost channel', async () => {
    const { link, sent } = setup();
    const out: AnalysisServerMessage[] = [];
    const a = link.open((m) => out.push(m), peer, PRIVATE);
    a.handle({ type: 'analyze', sessionId: 's', searchId: 1, engine: 'fake', fen: FEN, depth: 3 });
    link.lost();
    link.lost();
    expect(out).toEqual([
      expect.objectContaining({ code: 'engine_crashed', sessionId: 's', searchId: 1 }),
    ]);
    await a.lost;
    expect(link.isOpen).toBe(false);
    expect(link.clients).toBe(0);

    const before = sent.length;
    const late = link.open(() => {}, peer, PRIVATE);
    await late.lost;
    expect(late.state).toBe('lost');
    expect(sent.length).toBe(before);
    link.onFrame({ type: 'client.closed', cid: 'x' });
    expect(link.stats().unknownCid).toBe(0);
  });

  it('a failed client.open counts as node loss for that channel', async () => {
    const { link, down } = setup();
    down();
    const a = link.open(() => {}, peer, PRIVATE);
    await a.lost;
    expect(link.clients).toBe(0);
  });

  it('evictShared (M24-12): ends pool relays like a node loss, tells the node, keeps private ones', async () => {
    const { link, sent, onAbuse } = setup();
    const poolOut: AnalysisServerMessage[] = [];
    const privOut: AnalysisServerMessage[] = [];
    const pool = link.open((m) => poolOut.push(m), peer, POOL);
    const priv = link.open((m) => privOut.push(m), peer, PRIVATE);
    const idle = link.open(() => {}, peer, POOL);
    pool.handle({ type: 'analyze', sessionId: 's', searchId: 3, engine: 'sf', fen: FEN });
    priv.handle({ type: 'analyze', sessionId: 's', searchId: 1, engine: 'sf', fen: FEN });
    expect(link.evictShared('engine node removed from the pool')).toBe(2);
    expect(poolOut).toEqual([
      {
        type: 'error',
        code: 'engine_crashed',
        message: 'engine node removed from the pool',
        sessionId: 's',
        searchId: 3,
      },
    ]);
    await pool.lost;
    await idle.lost;
    expect(pool.state).toBe('lost');
    expect(priv.state).toBe('open');
    expect(privOut).toEqual([]);
    expect(sent.filter((m) => m.type === 'client.close').map((m) => m.cid)).toEqual([
      pool.cid,
      idle.cid,
    ]);
    expect(link.clients).toBe(1);
    // The node's late acknowledgements are not unknown-cid abuse.
    link.onFrame({ type: 'client.closed', cid: pool.cid });
    link.onFrame({ type: 'client.closed', cid: idle.cid });
    expect(link.stats().unknownCid).toBe(0);
    expect(onAbuse).not.toHaveBeenCalled();
    expect(link.evictShared('again')).toBe(0);
    // The private relay still works.
    priv.onNodeMessage({
      type: 'bestmove',
      sessionId: 's',
      searchId: 1,
      bestMove: { move: 'e2e4' },
      reason: 'completed',
    });
    expect(privOut).toHaveLength(1);
    link.lost();
    expect(link.evictShared('x')).toBe(0);
  });
});
