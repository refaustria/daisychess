import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AnalyzeMessage,
  HubToNodeMessage,
  Limits,
  NodeRelayMessage,
} from '@daisychess/engine-core';
import type { AnalysisServerMessage } from '../sessions/ClientSessions.js';
import { RelaySessions, type LinkPort, type RelaySessionsOptions } from './RelaySessions.js';

const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
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

const analyze = (over: Partial<AnalyzeMessage> = {}): AnalyzeMessage => ({
  type: 'analyze',
  sessionId: 's1',
  searchId: 1,
  engine: 'fake',
  fen: FEN,
  depth: 5,
  ...over,
});
const info = (sessionId: string, searchId: number, depth = 1): NodeRelayMessage => ({
  type: 'info',
  sessionId,
  searchId,
  info: { depth, multipv: 1, score: { cp: 10 }, pv: ['e2e4'] },
});
const bestmove = (sessionId: string, searchId: number): NodeRelayMessage => ({
  type: 'bestmove',
  sessionId,
  searchId,
  bestMove: { move: 'e2e4' },
  reason: 'completed',
});

class FakePort implements LinkPort {
  readonly nodeId = 'node0001';
  readonly sent: HubToNodeMessage[] = [];
  up = true;
  send(msg: HubToNodeMessage): boolean {
    if (!this.up) return false;
    this.sent.push(msg);
    return true;
  }
  /** Payloads of `client.msg` frames. */
  get relayed() {
    return this.sent.flatMap((m) => (m.type === 'client.msg' ? [m.msg] : []));
  }
}

function setup(opts: Partial<RelaySessionsOptions> = {}) {
  const port = new FakePort();
  const out: AnalysisServerMessage[] = [];
  const onDone = vi.fn();
  const relay = new RelaySessions((m) => out.push(m), port, 'cid1', {
    logger: silent,
    limits: LIMITS,
    onDone,
    ...opts,
  });
  return { port, out, relay, onDone };
}

const crashes = (out: AnalysisServerMessage[]) =>
  out.filter((m) => m.type === 'error' && m.code === 'engine_crashed');

afterEach(() => {
  vi.useRealTimers();
});

describe('RelaySessions: player → node', () => {
  it('relays analyze/stop/release as client.msg in order, stripping unknown fields', () => {
    const { port, relay } = setup();
    relay.handle({ ...analyze(), extra: 'x' } as AnalyzeMessage);
    relay.handle({ type: 'stop', sessionId: 's1' });
    relay.handle({ type: 'release', sessionId: 's1' });
    expect(port.sent).toEqual([
      { type: 'client.msg', cid: 'cid1', msg: analyze() },
      { type: 'client.msg', cid: 'cid1', msg: { type: 'stop', sessionId: 's1' } },
      { type: 'client.msg', cid: 'cid1', msg: { type: 'release', sessionId: 's1' } },
    ]);
  });

  it('answers an over-limit analyze locally with limit_exceeded and relays nothing', () => {
    const { port, out, relay } = setup();
    relay.handle(analyze({ depth: 50 }));
    expect(port.sent).toEqual([]);
    expect(out).toEqual([
      {
        type: 'error',
        code: 'limit_exceeded',
        message: expect.stringContaining('depth 50'),
        sessionId: 's1',
        searchId: 1,
      },
    ]);
    expect(relay.sessionCount).toBe(0);
    expect(relay.openSearchCount).toBe(0);
  });

  it('answers an invalid analyze with invalid_message (terminal) and drops other invalid frames', () => {
    const { port, out, relay } = setup();
    relay.handle(analyze({ fen: 'not a fen' }));
    relay.handle({ type: 'stop', sessionId: 'bad id!' });
    expect(port.sent).toEqual([]);
    expect(out).toEqual([
      expect.objectContaining({ code: 'invalid_message', sessionId: 's1', searchId: 1 }),
    ]);
  });

  it('retireAll relays one release per open session', () => {
    const { port, relay } = setup();
    relay.handle(analyze({ sessionId: 'a' }));
    relay.handle(analyze({ sessionId: 'b' }));
    expect(relay.sessionCount).toBe(2);
    relay.retireAll();
    expect(port.relayed.slice(2)).toEqual([
      { type: 'release', sessionId: 'a' },
      { type: 'release', sessionId: 'b' },
    ]);
    expect(relay.sessionCount).toBe(0);
    // Their searches still wait for `bestmove stopped`.
    expect(relay.openSearchCount).toBe(2);
  });
});

describe('RelaySessions: node → player', () => {
  it('delivers info and bestmove of a tracked search unchanged and in order', () => {
    const { out, relay } = setup();
    relay.handle(analyze());
    const msgs = [info('s1', 1, 1), info('s1', 1, 2), bestmove('s1', 1)];
    for (const m of msgs) relay.onNodeMessage(m);
    expect(out).toEqual(msgs);
    expect(relay.openSearchCount).toBe(0);
    expect(relay.sessionCount).toBe(1);
  });

  it('drops messages for unknown sessions/searches and duplicate terminals', () => {
    const { out, relay } = setup();
    relay.handle(analyze());
    relay.onNodeMessage(info('s1', 2));
    relay.onNodeMessage(info('zz', 1));
    relay.onNodeMessage(bestmove('s1', 7));
    relay.onNodeMessage({
      type: 'error',
      code: 'engine_crashed',
      message: 'x',
      sessionId: 'other',
    });
    relay.onNodeMessage(bestmove('s1', 1));
    relay.onNodeMessage(bestmove('s1', 1));
    relay.onNodeMessage(info('s1', 1));
    expect(out).toEqual([bestmove('s1', 1)]);
    expect(relay.stats().dropped.unknown).toBe(6);
  });

  it('a search-level error ends the search; a session-level error closes the session', () => {
    const { out, relay } = setup();
    relay.handle(analyze());
    const searchErr: NodeRelayMessage = {
      type: 'error',
      code: 'no_capacity',
      message: 'busy',
      sessionId: 's1',
      searchId: 1,
    };
    relay.onNodeMessage(searchErr);
    expect(relay.openSearchCount).toBe(0);
    const sessionErr: NodeRelayMessage = {
      type: 'error',
      code: 'engine_crashed',
      message: 'crash',
      sessionId: 's1',
    };
    relay.onNodeMessage(sessionErr);
    expect(out).toEqual([searchErr, sessionErr]);
    expect(relay.sessionCount).toBe(0);
  });

  it('forwards session_not_found for a stop of a session the hub does not track, once', () => {
    const { out, relay } = setup();
    relay.handle({ type: 'stop', sessionId: 'ghost' });
    const nf: NodeRelayMessage = {
      type: 'error',
      code: 'session_not_found',
      message: 'no session "ghost"',
      sessionId: 'ghost',
    };
    relay.onNodeMessage(nf);
    relay.onNodeMessage(nf);
    expect(out).toEqual([nf]);
  });

  it('caps info per search per second; the final policy info and terminals always pass', () => {
    let now = 1_000;
    const { out, relay } = setup({ infoPerSecondPerSearch: 3, now: () => now });
    relay.handle(analyze());
    for (let i = 0; i < 10; i++) relay.onNodeMessage(info('s1', 1, i + 1));
    expect(out).toHaveLength(3);
    const policy: NodeRelayMessage = {
      type: 'info',
      sessionId: 's1',
      searchId: 1,
      info: {
        depth: 1,
        multipv: 1,
        score: { cp: 0 },
        pv: ['e2e4'],
        policy: [{ uci: 'e2e4', p: 1 }],
      },
    };
    relay.onNodeMessage(policy);
    relay.onNodeMessage(bestmove('s1', 1));
    expect(out.slice(3)).toEqual([policy, bestmove('s1', 1)]);
    expect(relay.stats().dropped.infoRate).toBe(7);
    // A new window admits info again.
    relay.handle(analyze({ searchId: 2 }));
    now += 1_000;
    relay.onNodeMessage(info('s1', 2));
    expect(out.at(-1)).toEqual(info('s1', 2));
  });
});

describe('RelaySessions: node loss', () => {
  it('emits exactly one engine_crashed per open search (incl. released) and per idle session, then nothing', async () => {
    const { out, relay, onDone } = setup();
    relay.handle(analyze({ sessionId: 'run', searchId: 1 })); // running
    relay.handle(analyze({ sessionId: 'idle', searchId: 1 }));
    relay.onNodeMessage(bestmove('idle', 1)); // session open, no search
    relay.handle(analyze({ sessionId: 'rel', searchId: 4 }));
    relay.handle({ type: 'release', sessionId: 'rel' }); // released, terminal still owed
    relay.handle(analyze({ sessionId: 'two', searchId: 1 }));
    relay.handle(analyze({ sessionId: 'two', searchId: 2 })); // supersedes 1, both owed
    out.length = 0;

    relay.onNodeLost();
    const terminals = out.map((m) =>
      m.type === 'error' ? [m.code, m.sessionId, m.searchId ?? null] : m.type,
    );
    expect(terminals).toEqual([
      ['engine_crashed', 'run', 1],
      ['engine_crashed', 'rel', 4],
      ['engine_crashed', 'two', 1],
      ['engine_crashed', 'two', 2],
      ['engine_crashed', 'idle', null],
    ]);
    await expect(relay.lost).resolves.toBeUndefined();
    expect(relay.state).toBe('lost');
    expect(relay.sessionCount).toBe(0);
    expect(onDone).toHaveBeenCalledTimes(1);

    // Nothing more: late node frames, a second loss, a refused ack.
    relay.onNodeMessage(bestmove('run', 1));
    relay.onNodeLost();
    relay.onClientClosed();
    expect(out).toHaveLength(5);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('a search whose terminal arrived is not crashed again', () => {
    const { out, relay } = setup();
    relay.handle(analyze());
    relay.onNodeMessage(bestmove('s1', 1));
    relay.handle({ type: 'release', sessionId: 's1' });
    out.length = 0;
    relay.onNodeLost();
    expect(out).toEqual([]);
  });

  it('an analyze after the loss still gets its terminal; stop/release are ignored', () => {
    const { port, out, relay } = setup();
    relay.onNodeLost();
    relay.handle(analyze({ searchId: 9 }));
    relay.handle({ type: 'stop', sessionId: 's1' });
    expect(port.sent).toEqual([]);
    expect(out).toEqual([
      expect.objectContaining({ code: 'engine_crashed', sessionId: 's1', searchId: 9 }),
    ]);
  });

  it('a failed send counts as node loss and crashes the search it tried to relay', async () => {
    const { port, out, relay } = setup();
    port.up = false;
    relay.handle(analyze({ searchId: 3 }));
    expect(crashes(out)).toEqual([expect.objectContaining({ sessionId: 's1', searchId: 3 })]);
    await relay.lost;
  });

  it('an unrequested client.closed means the node refused the client: terminals, then lost', async () => {
    const { out, relay, onDone } = setup();
    relay.handle(analyze());
    relay.onClientClosed();
    expect(out).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'engine_crashed',
        sessionId: 's1',
        searchId: 1,
      }),
    ]);
    await relay.lost;
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('RelaySessions: close', () => {
  it('sends client.close and resolves on client.closed; nothing is delivered afterwards', async () => {
    const { port, out, relay, onDone } = setup();
    relay.handle(analyze());
    const p = relay.close();
    expect(relay.close()).toBe(p);
    expect(port.sent.at(-1)).toEqual({ type: 'client.close', cid: 'cid1' });
    relay.onNodeMessage(bestmove('s1', 1));
    relay.handle(analyze({ searchId: 2 }));
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    relay.onClientClosed();
    await p;
    expect(out).toEqual([]);
    expect(relay.state).toBe('closed');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(port.sent.filter((m) => m.type === 'client.close')).toHaveLength(1);
  });

  it('resolves on link loss without delivering terminals (the player is gone)', async () => {
    const { out, relay } = setup();
    relay.handle(analyze());
    const p = relay.close();
    relay.onNodeLost();
    await p;
    expect(out).toEqual([]);
  });

  it('resolves after the timeout when the node never acknowledges', async () => {
    vi.useFakeTimers();
    const { relay, onDone } = setup({ closeTimeoutMs: 2_000 });
    relay.handle(analyze());
    let settled = false;
    const p = relay.close().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('resolves at once when the link is already gone or the channel was lost', async () => {
    const a = setup();
    a.port.up = false;
    await a.relay.close();
    expect(a.relay.state).toBe('closed');

    const b = setup();
    b.relay.onNodeLost();
    await b.relay.close();
    expect(b.relay.state).toBe('closed');
    expect(b.port.sent).toEqual([]);
    expect(b.onDone).toHaveBeenCalledTimes(1);
  });
});
