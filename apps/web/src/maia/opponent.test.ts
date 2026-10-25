import type { EngineInfo, PolicyEntry } from '@daisychess/engine-core';
import { describe, expect, it } from 'vitest';
import { NO_TOKEN_MESSAGE } from '../server/tokenMessages';
import {
  BUSY_BACKOFF_MS,
  chooseMove,
  legalMove,
  legalUciMoves,
  MAIA_BUSY_MESSAGE,
  MAX_THINK_MS,
  MIN_THINK_MS,
  policyEntropy,
  samplePolicy,
  thinkDelayMs,
  type MaiaClient,
} from './opponent';
import { FakeMaiaServer, MAIA_WELCOME } from './opponentTesting';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
/** Fool's mate: White is checkmated, no legal move. */
const MATED = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3';
const CASTLE = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';

const POLICY: PolicyEntry[] = [
  { uci: 'e7e5', p: 0.5 },
  { uci: 'c7c5', p: 0.3 },
  { uci: 'e7e6', p: 0.1 },
  { uci: 'd7d5', p: 0.06 },
  { uci: 'g8f6', p: 0.04 },
];

/** Seeded RNG (mulberry32) for reproducible sampling. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs one `analyze` like the PlayController does: iterate, then read `bestMove`. */
async function moveOf(engine: { analyze: MaiaClient['analyze'] }, fen: string) {
  const handle = engine.analyze(fen, {});
  const infos: EngineInfo[] = [];
  for await (const info of handle) infos.push(info);
  return { best: (await handle.bestMove)?.move ?? null, infos };
}

describe('policy helpers', () => {
  it('legalUciMoves / legalMove: legal moves only, king-takes-rook castling mapped', () => {
    expect(legalUciMoves(START).size).toBe(20);
    expect(legalUciMoves('not a fen').size).toBe(0);
    expect(legalMove(START, 'e2e4')).toBe('e2e4');
    expect(legalMove(START, 'e2e5')).toBeNull();
    expect(legalMove(START, null)).toBeNull();
    expect(legalMove(CASTLE, 'e1h1')).toBe('e1g1');
    expect(legalMove(CASTLE, 'e1a1')).toBe('e1c1');
    expect(legalMove(START, 'e1h1')).toBeNull();
  });

  it('samplePolicy: proportional to p at T = 1, top move as T → 0', () => {
    const rng = seeded(42);
    const counts: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) {
      const pick = samplePolicy(POLICY, rng)!;
      counts[pick.uci] = (counts[pick.uci] ?? 0) + 1;
    }
    expect(counts.e7e5! / 20_000).toBeCloseTo(0.5, 1);
    expect(counts.c7c5! / 20_000).toBeCloseTo(0.3, 1);
    expect(counts.g8f6! / 20_000).toBeCloseTo(0.04, 1);
    expect(samplePolicy(POLICY, () => 0.99, 0)?.uci).toBe('e7e5');
    // Lower temperature sharpens: 0.5^2 / Σ p^2 ≈ 0.68 for the top move.
    let top = 0;
    for (let i = 0; i < 10_000; i++) if (samplePolicy(POLICY, rng, 0.5)!.uci === 'e7e5') top++;
    expect(top / 10_000).toBeCloseTo(0.68, 1);
    expect(samplePolicy([], rng)).toBeNull();
    expect(samplePolicy([{ uci: 'e2e4', p: 0 }], rng)).toBeNull();
    // random() at the edges stays in range.
    expect(samplePolicy(POLICY, () => 0)?.uci).toBe('e7e5');
    expect(samplePolicy(POLICY, () => 1)?.uci).toBe('g8f6');
  });

  it('policyEntropy: 0 for one move, 1 for a uniform spread', () => {
    expect(policyEntropy([{ uci: 'e2e4', p: 1 }])).toBe(0);
    expect(policyEntropy([])).toBe(0);
    expect(
      policyEntropy([
        { uci: 'a', p: 0.25 },
        { uci: 'b', p: 0.25 },
      ]),
    ).toBeCloseTo(1);
    const h = policyEntropy(POLICY);
    expect(h).toBeGreaterThan(0.5);
    expect(h).toBeLessThan(1);
  });

  it('thinkDelayMs: 300–1200 ms by entropy, never above 5 % of the clock', () => {
    expect(thinkDelayMs(0, undefined, () => 0)).toBe(MIN_THINK_MS);
    expect(thinkDelayMs(1, undefined, () => 1)).toBe(MAX_THINK_MS);
    expect(thinkDelayMs(1, undefined, () => 0)).toBeGreaterThan(
      thinkDelayMs(0, undefined, () => 0),
    );
    expect(thinkDelayMs(undefined, undefined, () => 0.5)).toBeGreaterThan(MIN_THINK_MS);
    // 10 s left: at most 500 ms; 2 s left: at most 100 ms; flagged: 0.
    expect(thinkDelayMs(1, 10_000, () => 1)).toBe(500);
    expect(thinkDelayMs(1, 2_000, () => 1)).toBe(100);
    expect(thinkDelayMs(1, 0, () => 1)).toBe(0);
    expect(thinkDelayMs(0, 600_000, () => 0)).toBe(MIN_THINK_MS);
  });

  it('chooseMove: top move, sample, illegal entries skipped, bestmove fallback', () => {
    const base = { fen: AFTER_E4, policy: POLICY, bestMove: 'e7e5', random: () => 0.9 };
    expect(chooseMove({ ...base, vary: false })).toEqual({ uci: 'e7e5', source: 'top' });
    expect(chooseMove({ ...base, vary: true })).toEqual({ uci: 'd7d5', source: 'sample' });
    // An illegal policy move is never played (here: White moves in a Black position).
    const bad: PolicyEntry[] = [{ uci: 'e2e4', p: 0.9 }, ...POLICY.slice(1)];
    expect(chooseMove({ ...base, policy: bad, vary: false })).toEqual({
      uci: 'c7c5',
      source: 'top',
    });
    expect(
      chooseMove({ ...base, policy: [{ uci: 'e2e4', p: 1 }], bestMove: 'g8f6', vary: true }),
    ).toEqual({ uci: 'g8f6', source: 'bestmove' });
    // No policy: bestmove; illegal bestmove: nothing.
    expect(chooseMove({ ...base, policy: undefined, vary: true })).toEqual({
      uci: 'e7e5',
      source: 'bestmove',
    });
    expect(chooseMove({ ...base, policy: undefined, bestMove: 'e2e4', vary: true })).toBeNull();
    expect(chooseMove({ ...base, fen: MATED, policy: [], bestMove: null, vary: true })).toBeNull();
  });
});

describe('MaiaOpponent (real RemoteEngineClient on a fake server)', () => {
  it('plays the top move with "Vary moves" off; sends no nodes, on the chosen engine', async () => {
    const server = new FakeMaiaServer();
    server.replies = [{ kind: 'move', best: 'e7e5', policy: POLICY }];
    const maia = server.opponent({ varyMoves: () => false, random: () => 0.99 });
    await maia.load();
    const { best, infos } = await moveOf(maia, AFTER_E4);
    expect(best).toBe('e7e5');
    expect(infos).toHaveLength(1);
    expect(infos[0]!.pv).toEqual(['e7e5']);
    expect(infos[0]!.policy).toEqual(POLICY);
    expect(server.analyzes).toEqual([{ engine: 'maia-1500', fen: AFTER_E4 }]);
    await maia.dispose();
    expect(server.sockets[0]!.ofType('release')).toHaveLength(1);
  });

  it('samples from the policy with a seeded RNG (reproducible, varied)', async () => {
    const run = async (seed: number) => {
      const server = new FakeMaiaServer();
      server.replies = [{ kind: 'move', best: 'e7e5', policy: POLICY }];
      const maia = server.opponent({ random: seeded(seed) });
      const moves: string[] = [];
      for (let i = 0; i < 30; i++) moves.push((await moveOf(maia, AFTER_E4)).best!);
      await maia.dispose();
      return moves;
    };
    const a = await run(7);
    expect(await run(7)).toEqual(a);
    expect(new Set(a).size).toBeGreaterThan(1);
    for (const m of a) expect(POLICY.map((e) => e.uci)).toContain(m);
    expect(a.filter((m) => m === 'e7e5').length).toBeGreaterThan(8);
  });

  it('never plays an illegal policy move: falls back to bestmove', async () => {
    const server = new FakeMaiaServer();
    server.replies = [{ kind: 'move', best: 'c7c5', policy: [{ uci: 'e2e4', p: 0.99 }] }];
    const maia = server.opponent({ random: () => 0 });
    expect((await moveOf(maia, AFTER_E4)).best).toBe('c7c5');
    await maia.dispose();
  });

  it('fails when neither policy nor bestmove is legal (no illegal move reaches the board)', async () => {
    const server = new FakeMaiaServer();
    server.replies = [{ kind: 'move', best: 'e2e4', policy: [{ uci: 'a2a4', p: 1 }] }];
    const maia = server.opponent();
    await expect(moveOf(maia, AFTER_E4)).rejects.toThrow('Maia returned no legal move');
    await maia.dispose();
  });

  it('null bestmove on a terminal position: no move, no error', async () => {
    const server = new FakeMaiaServer();
    server.replies = [{ kind: 'move', best: null }];
    const maia = server.opponent();
    expect(await moveOf(maia, MATED)).toEqual({ best: null, infos: [] });
    await maia.dispose();
  });

  it('no_capacity: retries with backoff 3 times, then "Maia is busy"', async () => {
    const server = new FakeMaiaServer();
    server.replies = [{ kind: 'busy' }];
    const waits: number[] = [];
    const maia = server.opponent({
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await expect(moveOf(maia, AFTER_E4)).rejects.toMatchObject({
      message: MAIA_BUSY_MESSAGE,
      code: 'no_capacity',
    });
    expect(waits).toEqual([...BUSY_BACKOFF_MS]);
    expect(server.analyzes).toHaveLength(4);
    expect(maia.stats.busyRetries).toBe(3);
    await maia.dispose();
  });

  it('no_capacity then free: the retry plays the move', async () => {
    const server = new FakeMaiaServer();
    server.replies = [
      { kind: 'busy' },
      { kind: 'busy' },
      { kind: 'move', best: 'e7e5', policy: POLICY },
    ];
    const maia = server.opponent({ varyMoves: () => false });
    expect((await moveOf(maia, AFTER_E4)).best).toBe('e7e5');
    expect(server.analyzes).toHaveLength(3);
    await maia.dispose();
  });

  it('a lost node (close 1012, code node_lost) is retried like a dropped connection', async () => {
    const server = new FakeMaiaServer();
    server.replies = [{ kind: 'close', code: 1012 }, { kind: 'move', best: 'e7e5' }];
    const maia = server.opponent();
    await maia.load();
    expect((await moveOf(maia, AFTER_E4)).best).toBe('e7e5');
    expect(maia.stats.reconnects).toBe(1);
    await maia.dispose();
  });

  it('a dropped connection is reconnected once per move', async () => {
    const server = new FakeMaiaServer();
    server.replies = [{ kind: 'close' }, { kind: 'move', best: 'e7e5' }];
    const maia = server.opponent();
    await maia.load();
    expect((await moveOf(maia, AFTER_E4)).best).toBe('e7e5');
    expect(server.sockets).toHaveLength(2);
    expect(maia.stats.reconnects).toBe(1);

    // Twice in a row: the move fails with "Server unavailable".
    server.replies = [{ kind: 'close' }];
    await expect(moveOf(maia, AFTER_E4)).rejects.toThrow(/Server unavailable/);
    await maia.dispose();
  });

  it('missing/wrong token (restricted welcome): load fails with "No server access token on this device — enter it in Settings"', async () => {
    const server = new FakeMaiaServer();
    server.welcome = {
      ...MAIA_WELCOME,
      engines: [],
      capabilities: { analysis: false, rooms: true },
    };
    const maia = server.opponent();
    await expect(maia.load()).rejects.toMatchObject({
      message: NO_TOKEN_MESSAGE,
      code: 'unauthorized',
    });
    await maia.dispose();
  });

  it('stop ends a pending search and its think delay without a move', async () => {
    const server = new FakeMaiaServer();
    server.replies = [{ kind: 'move', best: 'e7e5', policy: POLICY }];
    let release!: () => void;
    const maia = server.opponent({
      thinkDelay: () => 1_000,
      wait: () => new Promise<void>((r) => (release = r)),
    });
    const pending = moveOf(maia, AFTER_E4);
    await new Promise((r) => setTimeout(r, 10));
    await maia.stop();
    expect(await pending).toEqual({ best: null, infos: [] });
    release();
    await maia.dispose();
  });

  it('the think delay sees the remaining clock time and the policy entropy', async () => {
    const server = new FakeMaiaServer();
    server.replies = [{ kind: 'move', best: 'e7e5', policy: POLICY }];
    const seen: [number | undefined, number | undefined][] = [];
    const waits: number[] = [];
    const maia = server.opponent({
      remainingMs: () => 4_000,
      thinkDelay: (h, ms) => {
        seen.push([h, ms]);
        return thinkDelayMs(h, ms, () => 1);
      },
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await moveOf(maia, AFTER_E4);
    expect(seen[0]![0]).toBeCloseTo(policyEntropy(POLICY));
    expect(seen[0]![1]).toBe(4_000);
    expect(waits).toEqual([200]); // 5 % of 4 s
    await maia.dispose();
  });
});
