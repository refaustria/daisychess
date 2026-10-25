import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineDescriptor, Score } from '@daisychess/engine-core';
import { EnginePool, type PoolLogger } from '../engines/EnginePool.js';
import { loadSqlite } from '../review/ReviewStore.js';
import { engineConfig, fakeSpawner } from '../../test/helpers.js';
import type { PoolSearchSample } from './Router.js';
import {
  DECISIVE_CP,
  MATE_VALUE,
  Reputation,
  SpotChecker,
  createPoolChecker,
  engineFamily,
  isLegalUciMove,
  judgeSpotCheck,
  sameDecisive,
  scoreValue,
  type LocalChecker,
  type LocalEngineSession,
  type LocalSearchParams,
  type LocalSearchResult,
  type NodeModeration,
  type ReputationStore,
  type SpotCheckConfig,
} from './SpotCheck.js';
import { HubStore, SPOTCHECK_RETENTION_MS, type NodeRecord } from './store/HubStore.js';
import { HubTokenService, LOCAL_NODE_ID } from './tokens.js';

const sqlite = await loadSqlite();
const silent: PoolLogger = { info() {}, warn() {}, error() {}, debug() {} };
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** White to move, Qh5xf7# is mate in one (scholar's mate). */
const MATE_IN_ONE = 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);

const SF: EngineDescriptor = {
  id: 'stockfish',
  name: 'Stockfish 17.1',
  enabled: true,
  defaults: { threads: 4, hash: 256 },
};
const LOCAL_SF: EngineDescriptor = { ...SF, name: 'Stockfish 19' };
const MAIA: EngineDescriptor = {
  id: 'maia-1500',
  name: 'Maia 1500',
  enabled: true,
  defaults: { threads: 1, hash: 16 },
  style: 'human',
  rating: 1500,
};

// ---------------------------------------------------------------------------------- pure

describe('engineFamily', () => {
  it('recognises Stockfish of any version; never Maia, Fairy-Stockfish, unknown or null', () => {
    expect(engineFamily(SF)).toBe('stockfish');
    expect(engineFamily({ id: 'sf', name: 'Stockfish 19', style: 'strength' })).toBe('stockfish');
    expect(engineFamily({ id: 'stockfish-dev', name: 'Big engine' })).toBe('stockfish');
    expect(engineFamily(MAIA)).toBeNull();
    expect(engineFamily({ id: 'stockfish', name: 'Stockfish', style: 'human' })).toBeNull();
    expect(engineFamily({ id: 'fairy-stockfish', name: 'Fairy-Stockfish' })).toBeNull();
    expect(engineFamily({ id: 'lc0', name: 'Lc0 v0.32' })).toBeNull();
    expect(engineFamily(null)).toBeNull();
    expect(engineFamily(undefined)).toBeNull();
  });
});

describe('scoreValue / sameDecisive', () => {
  it('orders mates beyond centipawns, shorter wins and longer losses higher', () => {
    expect(scoreValue({ cp: 35 })).toBe(35);
    expect(scoreValue({ mate: 1 })).toBe(MATE_VALUE - 1);
    expect(scoreValue({ mate: 3 })).toBeLessThan(scoreValue({ mate: 1 }));
    expect(scoreValue({ mate: 3 })).toBeGreaterThan(scoreValue({ cp: 100_000 }));
    expect(scoreValue({ mate: -1 })).toBe(-MATE_VALUE + 1);
    expect(scoreValue({ mate: -5 })).toBeGreaterThan(scoreValue({ mate: -1 }));
    expect(scoreValue({ mate: 0 })).toBe(-MATE_VALUE);
    expect(scoreValue({ mate: -10 })).toBeLessThan(scoreValue({ cp: -100_000 }));
  });

  it('same direction beyond the decisive threshold, mates included', () => {
    expect(sameDecisive({ cp: DECISIVE_CP }, { mate: 4 })).toBe(true);
    expect(sameDecisive({ mate: 2 }, { mate: 9 })).toBe(true);
    expect(sameDecisive({ cp: -700 }, { mate: -2 })).toBe(true);
    expect(sameDecisive({ cp: 499 }, { cp: 900 })).toBe(false);
    expect(sameDecisive({ mate: 3 }, { mate: -3 })).toBe(false);
    expect(sameDecisive({ cp: 0 }, { cp: 0 })).toBe(false);
  });
});

describe('judgeSpotCheck', () => {
  const tol = { moveCp: 50, scoreCp: 200 };
  const j = (
    sameMove: boolean,
    localBest: Score,
    nodeMoveLocal: Score,
    nodeReported: Score,
    t = tol,
  ) => judgeSpotCheck({ sameMove, localBest, nodeMoveLocal, nodeReported }, t);

  it('agrees on the same move with a plausible score', () => {
    expect(j(true, { cp: 30 }, { cp: 30 }, { cp: 45 })).toEqual({
      agreed: true,
      reason: 'same_move',
    });
  });

  it("evaluates the node's move: within the tolerance agrees, beyond it disagrees", () => {
    expect(j(false, { cp: 30 }, { cp: -20 }, { cp: 10 })).toEqual({
      agreed: true,
      reason: 'within_tolerance',
    });
    expect(j(false, { cp: 30 }, { cp: -21 }, { cp: 10 })).toEqual({
      agreed: false,
      reason: 'move_loss',
    });
    // A node move rated better than local's best (deeper node search) is fine.
    expect(j(false, { cp: 30 }, { cp: 60 }, { cp: 70 }).agreed).toBe(true);
  });

  it('handles mate scores', () => {
    // Local mates, the node's move keeps a decisive advantage: no evidence of a wrong engine.
    expect(j(false, { mate: 1 }, { cp: 900 }, { cp: 950 })).toEqual({
      agreed: true,
      reason: 'both_decisive',
    });
    // Slower mate.
    expect(j(false, { mate: 1 }, { mate: 4 }, { mate: 4 })).toMatchObject({ agreed: true });
    // Local mates, the node's move throws it away.
    expect(j(false, { mate: 2 }, { cp: 40 }, { cp: 40 })).toEqual({
      agreed: false,
      reason: 'move_loss',
    });
    // The node's move walks into a mate while local holds.
    expect(j(false, { cp: -80 }, { mate: -2 }, { cp: -90 })).toEqual({
      agreed: false,
      reason: 'move_loss',
    });
    // Both lose decisively: one losing move instead of another is not counted.
    expect(j(false, { cp: -650 }, { mate: -3 }, { mate: -3 })).toMatchObject({ agreed: true });
  });

  it('checks the reported score against local, mates and the off switch included', () => {
    expect(j(true, { cp: 30 }, { cp: 30 }, { cp: 231 })).toEqual({
      agreed: false,
      reason: 'score_mismatch',
    });
    expect(j(true, { cp: 30 }, { cp: 30 }, { cp: 230 }).agreed).toBe(true);
    expect(j(true, { cp: 20 }, { cp: 20 }, { mate: 3 })).toEqual({
      agreed: false,
      reason: 'score_mismatch',
    });
    expect(j(true, { mate: 3 }, { mate: 3 }, { cp: 800 }).agreed).toBe(true);
    expect(j(true, { mate: 3 }, { mate: 3 }, { mate: -3 }).agreed).toBe(false);
    expect(j(true, { cp: 30 }, { cp: 30 }, { cp: -900 }, { moveCp: 50, scoreCp: 0 }).agreed).toBe(
      true,
    );
  });
});

describe('isLegalUciMove', () => {
  it('validates moves with chess.js; null for an unparsable position', () => {
    expect(isLegalUciMove(START, 'e2e4')).toBe(true);
    expect(isLegalUciMove(START, 'g1f3')).toBe(true);
    expect(isLegalUciMove(START, 'e2e5')).toBe(false);
    expect(isLegalUciMove(START, 'e7e5')).toBe(false);
    expect(isLegalUciMove('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8q')).toBe(true);
    expect(isLegalUciMove('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', 'a7a8')).toBe(false);
    expect(isLegalUciMove('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'e1g1')).toBe(true);
    expect(isLegalUciMove('not a fen', 'e2e4')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------- fakes

/**
 * A scripted `local`: `evals(fen)` gives local's view of a position — its best move and the
 * score of every move (unlisted moves score `fallback`).
 */
interface Position {
  best: string;
  scores: Record<string, Score>;
  fallback?: Score;
}

class FakeLocal implements LocalChecker {
  free = true;
  player = false;
  opened = 0;
  closed = 0;
  searches: { fen: string; params: LocalSearchParams }[] = [];
  /** Depth the fake reaches (default: whatever was asked). */
  reach: number | null = null;
  /** Holds every search until released (concurrency tests). */
  gate: Promise<void> | null = null;
  ignoreSearchmoves = false;
  positions = new Map<string, Position>();

  canStart(): boolean {
    return this.free;
  }
  playerActive(): boolean {
    return this.player;
  }
  async open(): Promise<LocalEngineSession | null> {
    this.opened++;
    return {
      search: async (fen, params, shouldAbort) => {
        this.searches.push({ fen, params });
        if (this.gate) await this.gate;
        if (shouldAbort()) return null;
        const p = this.positions.get(fen);
        if (!p) return null;
        const depth = this.reach ?? params.depth;
        const restrict = this.ignoreSearchmoves ? undefined : params.searchmoves?.[0];
        const move = restrict ?? p.best;
        const score = p.scores[move] ?? p.fallback ?? { cp: -300 };
        const r: LocalSearchResult = { bestMove: move, score, depth };
        return r;
      },
      close: () => {
        this.closed++;
      },
    };
  }
}

function sample(over: Partial<PoolSearchSample> = {}): PoolSearchSample {
  return {
    nodeId: 'nodeaaaa',
    descriptor: SF,
    engine: 'stockfish',
    fen: START,
    depth: 18,
    bestMove: 'e2e4',
    score: { cp: 35 },
    reason: 'completed',
    ...over,
  };
}

/** In-memory {@link ReputationStore} (the SQLite store is tested further down). */
class MemStore implements ReputationStore {
  nodes = new Map<string, NodeRecord>();
  rows: { nodeId: string; at: number; agreed: boolean }[] = [];
  add(id: string): void {
    this.nodes.set(id, {
      id,
      operatorId: 'op000001',
      name: id,
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
    });
  }
  getNode(id: string) {
    const n = this.nodes.get(id);
    return n ? { ...n } : undefined;
  }
  listNodes() {
    return [...this.nodes.values()].map((n) => ({ ...n }));
  }
  insertSpotcheck(nodeId: string, at: number, agreed: boolean) {
    this.rows.push({ nodeId, at, agreed });
  }
  recentSpotchecks(nodeId: string, since: number, limit: number) {
    return this.rows
      .filter((r) => r.nodeId === nodeId && r.at >= since)
      .reverse()
      .slice(0, limit)
      .map((r) => r.agreed);
  }
  setNodeReputation(
    id: string,
    rep: { state: NodeRecord['state']; suspectCount: number; suspectUntil: number | null },
  ) {
    const n = this.nodes.get(id);
    if (!n) return undefined;
    Object.assign(n, rep);
    return { ...n };
  }
  setPoolBan(id: string, ban: { at: number; reason: string } | null) {
    const n = this.nodes.get(id);
    if (!n) return undefined;
    n.poolBannedAt = ban?.at ?? null;
    n.poolBanReason = ban?.reason ?? null;
    return { ...n };
  }
}

class FakeModeration implements NodeModeration {
  applied: NodeRecord[] = [];
  evicted: NodeRecord[] = [];
  apply(n: NodeRecord) {
    this.applied.push(n);
  }
  evictShared(n: NodeRecord) {
    this.evicted.push(n);
  }
}

function capture(): PoolLogger & { warns: string[]; infos: string[] } {
  const warns: string[] = [];
  const infos: string[] = [];
  return {
    warns,
    infos,
    info: (_o, m) => infos.push(m),
    warn: (_o, m) => warns.push(m),
    error() {},
    debug() {},
  };
}

let now = T0;
let local: FakeLocal;
let mem: MemStore;
let moderation: FakeModeration;
let reputation: Reputation;
let draws: number[];

function checker(config: Partial<SpotCheckConfig> = {}, rep: Reputation = reputation) {
  return new SpotChecker({
    config: { rate: 0.02, ...config },
    local,
    localEngines: [MAIA, LOCAL_SF],
    reputation: rep,
    logger: silent,
    random: () => draws.shift() ?? 0,
    now: () => now,
  });
}

beforeEach(() => {
  now = T0;
  local = new FakeLocal();
  local.positions.set(START, {
    best: 'e2e4',
    scores: { e2e4: { cp: 35 }, d2d4: { cp: 10 }, a2a3: { cp: -60 } },
  });
  local.positions.set(MATE_IN_ONE, {
    best: 'h5f7',
    scores: { h5f7: { mate: 1 }, h5e5: { cp: 40 } },
  });
  mem = new MemStore();
  mem.add('nodeaaaa');
  mem.add('nodebbbb');
  moderation = new FakeModeration();
  reputation = new Reputation(mem, moderation, silent);
  draws = [];
});

// ---------------------------------------------------------------------------------- sampler

describe('SpotChecker: sampling', () => {
  it('samples eligible pool searches at the configured rate', async () => {
    const sc = checker({ rate: 0.02 });
    draws = [0.5, 0.0199, 0.02, 0.9];
    for (let i = 0; i < 4; i++) {
      sc.offer(sample());
      await sc.idle();
    }
    expect(sc.stats()).toMatchObject({ offered: 4, eligible: 4, sampled: 1, started: 1 });
    expect(local.opened).toBe(1);
  });

  it('only checks Stockfish-family searches reaching the minimum depth', async () => {
    const sc = checker({ rate: 1 });
    sc.offer(sample({ descriptor: MAIA, engine: 'maia-1500' }));
    sc.offer(sample({ descriptor: null }));
    sc.offer(sample({ descriptor: { ...SF, id: 'fairy', name: 'Fairy-Stockfish' } }));
    sc.offer(sample({ depth: 9 }));
    expect(sc.stats()).toMatchObject({
      offered: 4,
      eligible: 0,
      sampled: 0,
      skipped: { engine: 3, depth: 1 },
    });
    sc.offer(sample({ depth: 10 }));
    await sc.idle();
    expect(sc.stats()).toMatchObject({ eligible: 1, started: 1, agreed: 1 });
    // A local registry without Stockfish cannot check anything.
    const noSf = new SpotChecker({
      config: { rate: 1 },
      local,
      localEngines: [MAIA, { ...LOCAL_SF, enabled: false }],
      reputation,
      logger: silent,
    });
    noSf.offer(sample());
    expect(noSf.stats()).toMatchObject({ eligible: 0, skipped: { engine: 1 } });
  });

  it('ignores `local` itself and does nothing after close', async () => {
    const sc = checker({ rate: 1 });
    sc.offer(sample({ nodeId: LOCAL_NODE_ID }));
    expect(sc.stats().offered).toBe(0);
    await sc.close();
    sc.offer(sample());
    expect(sc.stats().offered).toBe(0);
    expect(local.opened).toBe(0);
  });

  it('never starts while local is busy (no engine is even leased)', async () => {
    const sc = checker({ rate: 1 });
    local.free = false;
    sc.offer(sample());
    await sc.idle();
    expect(sc.stats()).toMatchObject({ sampled: 1, started: 0, skipped: { busy: 1 } });
    expect(local.opened).toBe(0);
    expect(mem.rows).toEqual([]);
  });

  it('yields to a player search that starts during a check (inconclusive, not recorded)', async () => {
    const sc = checker({ rate: 1 });
    let release!: () => void;
    local.gate = new Promise((r) => (release = r));
    sc.offer(sample());
    local.player = true;
    release();
    await sc.idle();
    expect(sc.stats()).toMatchObject({ started: 1, inconclusive: 1, agreed: 0, disagreed: 0 });
    expect(local.closed).toBe(1);
    expect(mem.rows).toEqual([]);
  });

  it('caps concurrent checks and checks per hour', async () => {
    const sc = checker({ rate: 1, maxConcurrent: 1, maxPerHour: 2 });
    let release!: () => void;
    local.gate = new Promise((r) => (release = r));
    sc.offer(sample());
    sc.offer(sample());
    expect(sc.stats()).toMatchObject({ started: 1, running: 1, skipped: { concurrent: 1 } });
    release();
    await sc.idle();
    local.gate = null;
    sc.offer(sample());
    await sc.idle();
    sc.offer(sample());
    expect(sc.stats()).toMatchObject({ started: 2, lastHour: 2, skipped: { budget: 1 } });
    now += HOUR;
    expect(sc.stats().lastHour).toBe(0);
    sc.offer(sample());
    await sc.idle();
    expect(sc.stats()).toMatchObject({ started: 3, agreed: 3 });
  });
});

describe('SpotChecker: local CPU bound (load)', () => {
  it('10 000 eligible pool searches in an hour start at most maxPerHour checks', async () => {
    let seed = 42;
    const lcg = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    const sc = new SpotChecker({
      config: { rate: 0.02, maxPerHour: 20 },
      local,
      localEngines: [LOCAL_SF],
      reputation,
      logger: silent,
      random: lcg,
      now: () => now,
    });
    for (let i = 0; i < 10_000; i++) {
      now += 360; // 10 000 searches spread over one hour
      sc.offer(sample());
      await sc.idle();
    }
    const st = sc.stats();
    expect(st.eligible).toBe(10_000);
    expect(st.sampled).toBeGreaterThan(150); // ≈ 2 %
    expect(st.sampled).toBeLessThan(260);
    expect(st.started).toBeLessThanOrEqual(20 + 1); // the window slides by the last start
    expect(local.searches.length).toBeLessThanOrEqual(2 * st.started);
  });
});

describe('SpotChecker: comparison on local', () => {
  it('same move: one local search at the node depth capped at maxDepth', async () => {
    const sc = checker({ rate: 1, maxDepth: 16, movetimeMs: 3_000 });
    sc.offer(sample({ depth: 22 }));
    await sc.idle();
    expect(local.searches).toEqual([{ fen: START, params: { depth: 16, movetimeMs: 3_000 } }]);
    expect(sc.stats()).toMatchObject({ agreed: 1, reasons: { same_move: 1 } });
    expect(mem.rows).toEqual([{ nodeId: 'nodeaaaa', at: T0, agreed: true }]);
    sc.offer(sample({ depth: 12 }));
    await sc.idle();
    expect(local.searches[1]?.params.depth).toBe(12);
  });

  it("different move: evaluates the node's move with searchmoves", async () => {
    const sc = checker({ rate: 1, toleranceCp: 30 });
    sc.offer(sample({ bestMove: 'd2d4', score: { cp: 12 } })); // 25 cp worse: agree
    await sc.idle();
    expect(local.searches.map((s) => s.params.searchmoves)).toEqual([undefined, ['d2d4']]);
    sc.offer(sample({ bestMove: 'a2a3', score: { cp: -50 } })); // 95 cp worse: disagree
    await sc.idle();
    expect(sc.stats()).toMatchObject({
      agreed: 1,
      disagreed: 1,
      reasons: { within_tolerance: 1, move_loss: 1 },
    });
    expect(mem.rows.map((r) => r.agreed)).toEqual([true, false]);
  });

  it('mate positions: a missed mate disagrees, the mate agrees', async () => {
    const sc = checker({ rate: 1 });
    sc.offer(sample({ fen: MATE_IN_ONE, bestMove: 'h5f7', score: { mate: 1 } }));
    await sc.idle();
    sc.offer(sample({ fen: MATE_IN_ONE, bestMove: 'h5e5', score: { cp: 40 } }));
    await sc.idle();
    expect(sc.stats()).toMatchObject({ agreed: 1, disagreed: 1 });
  });

  it('a faked score with the right move disagrees', async () => {
    const sc = checker({ rate: 1 });
    sc.offer(sample({ score: { cp: 600 } }));
    await sc.idle();
    expect(sc.stats()).toMatchObject({ disagreed: 1, reasons: { score_mismatch: 1 } });
  });

  it('an illegal move disagrees without spending engine time', async () => {
    const sc = checker({ rate: 1 });
    sc.offer(sample({ bestMove: 'e2e5' }));
    await sc.idle();
    expect(local.opened).toBe(0);
    expect(sc.stats()).toMatchObject({ disagreed: 1, reasons: { illegal_move: 1 } });
  });

  it('inconclusive (never recorded): depth not reached, searchmoves ignored, failure, bad FEN', async () => {
    const sc = checker({ rate: 1 });
    local.reach = 8;
    sc.offer(sample());
    await sc.idle();
    local.reach = null;
    local.ignoreSearchmoves = true;
    sc.offer(sample({ bestMove: 'a2a3' }));
    await sc.idle();
    local.ignoreSearchmoves = false;
    sc.offer(sample({ fen: '8/8/8/8/8/8/8/K6k w - - 0 1', bestMove: 'a1a2' })); // unknown to the fake
    await sc.idle();
    sc.offer(sample({ fen: 'k7/8/8/8/8/8/8/8 w - - 0 1' })); // chess.js: no white king
    await sc.idle();
    expect(sc.stats()).toMatchObject({ started: 4, inconclusive: 4, agreed: 0, disagreed: 0 });
    expect(mem.rows).toEqual([]);
    expect(local.closed).toBe(local.opened);
  });
});

// ---------------------------------------------------------------------------------- reputation

describe('Reputation: rolling window state machine', () => {
  const rec = (agreed: boolean, node = 'nodeaaaa') => {
    now += 1_000;
    return reputation.record(node, agreed, now);
  };

  it('needs minChecks, then flags above the disagreement rate (20 %)', () => {
    for (let i = 0; i < 7; i++) expect(rec(true)).toBeNull();
    expect(rec(false)).toBeNull();
    expect(rec(false)).toBeNull(); // 9 checks: below minChecks
    expect(rec(true)).toBeNull(); // 2/10 = 20 %: not above
    expect(rec(false)).toBe('suspect'); // 3/11
    const n = mem.getNode('nodeaaaa')!;
    expect(n).toMatchObject({ state: 'suspect', suspectCount: 1, suspectUntil: now + DAY });
    expect(moderation.applied.map((x) => x.state)).toEqual(['suspect']);
    // Its pool players are moved off at once.
    expect(moderation.evicted.map((x) => x.id)).toEqual(['nodeaaaa']);
  });

  it('old checks leave the window (latest `window` checks)', () => {
    reputation = new Reputation(mem, moderation, silent, { window: 10, minChecks: 10 });
    rec(false);
    rec(false);
    for (let i = 0; i < 8; i++) rec(true); // 20 %
    expect(rec(false)).toBeNull(); // window: F A*8 F → 20 %
    expect(rec(true)).toBeNull(); // A*8 F A... still 20 % max
    expect(mem.getNode('nodeaaaa')!.state).toBe('normal');
    // Checks older than the 24 h retention never count.
    now += SPOTCHECK_RETENTION_MS;
    for (let i = 0; i < 9; i++) rec(true);
    expect(rec(false)).toBeNull(); // 1/10
  });

  it('normal → suspect → normal after the cool-down; agreeing checks keep it normal', () => {
    for (let i = 0; i < 10; i++) rec(i < 7);
    expect(mem.getNode('nodeaaaa')!.state).toBe('suspect');
    const until = mem.getNode('nodeaaaa')!.suspectUntil!;
    // Checks that finish during the episode are recorded but change nothing.
    expect(rec(false)).toBeNull();
    expect(reputation.expireCooldowns(until - 1)).toBe(0);
    expect(reputation.expireCooldowns(until)).toBe(1);
    expect(mem.getNode('nodeaaaa')).toMatchObject({ state: 'normal', suspectCount: 1 });
    expect(moderation.applied.map((x) => x.state)).toEqual(['suspect', 'normal']);
    // The window restarted: the old disagreements no longer count.
    now = until;
    for (let i = 0; i < 40; i++) expect(rec(true)).toBeNull();
    expect(rec(false)).toBeNull();
    expect(mem.getNode('nodeaaaa')!.state).toBe('normal');
    expect(reputation.stats()).toMatchObject({ suspected: 1, restored: 1, poolBanned: 0 });
  });

  it('a check arriving after the cool-down ended restores the node before the sweep', () => {
    for (let i = 0; i < 10; i++) rec(i < 7);
    now = mem.getNode('nodeaaaa')!.suspectUntil! + 5;
    expect(reputation.record('nodeaaaa', true, now)).toBeNull();
    expect(mem.getNode('nodeaaaa')!.state).toBe('normal');
  });

  it('the third episode bans the node from the pool for good — never disables it (warn logged)', () => {
    const log = capture();
    reputation = new Reputation(mem, moderation, log);
    const episode = () => {
      let t: ReturnType<typeof rec> = null;
      for (let i = 0; i < 10 && t === null; i++) t = rec(i < 6);
      return t;
    };
    expect(episode()).toBe('suspect');
    reputation.expireCooldowns(mem.getNode('nodeaaaa')!.suspectUntil!);
    now = mem.getNode('nodeaaaa')!.suspectUntil!;
    expect(episode()).toBe('suspect');
    expect(mem.getNode('nodeaaaa')!.suspectCount).toBe(2);
    reputation.expireCooldowns(mem.getNode('nodeaaaa')!.suspectUntil!);
    now = mem.getNode('nodeaaaa')!.suspectUntil!;
    expect(episode()).toBe('pool_banned');
    expect(mem.getNode('nodeaaaa')).toMatchObject({
      state: 'normal',
      suspectCount: 3,
      poolBannedAt: now,
      poolBanReason: 'spot-check failures',
    });
    expect(moderation.applied.at(-1)).toMatchObject({ poolBannedAt: now });
    expect(moderation.evicted).toHaveLength(3);
    expect(log.warns.at(-1)).toMatch(/permanently removed from the pool/);
    // The ban is permanent: no sweep lifts it, further checks change nothing.
    expect(reputation.expireCooldowns(now + 10 * DAY)).toBe(0);
    now += 10 * DAY;
    for (let i = 0; i < 20; i++) expect(rec(false)).toBeNull();
    expect(mem.getNode('nodeaaaa')).toMatchObject({ state: 'normal', suspectCount: 3 });
    expect(mem.getNode('nodeaaaa')!.poolBannedAt).not.toBeNull();
    expect(reputation.stats()).toMatchObject({ suspected: 2, restored: 2, poolBanned: 1 });
  });

  it('a manual suspect (no suspect_until) is never lifted automatically; unknown nodes are ignored', () => {
    mem.setNodeReputation('nodeaaaa', { state: 'suspect', suspectCount: 0, suspectUntil: null });
    expect(reputation.expireCooldowns(now + 100 * DAY)).toBe(0);
    expect(rec(true)).toBeNull();
    expect(mem.getNode('nodeaaaa')!.state).toBe('suspect');
    expect(reputation.record('zzzzzzzz', false, now)).toBeNull();
    expect(mem.rows.some((r) => r.nodeId === 'zzzzzzzz')).toBe(false);
  });

  it('a failing moderation hook does not break recording', () => {
    reputation = new Reputation(
      mem,
      {
        apply() {
          throw new Error('registry gone');
        },
        evictShared() {
          throw new Error('link gone');
        },
      },
      silent,
    );
    for (let i = 0; i < 9; i++) rec(i < 6);
    expect(rec(false)).toBe('suspect');
  });
});

describe('SpotChecker + Reputation: fake nodes', () => {
  it('a node returning wrong moves becomes suspect; an agreeing node is never flagged', async () => {
    const sc = checker({ rate: 1, maxPerHour: 1_000 });
    for (let i = 0; i < 60; i++) {
      now += 1_000;
      sc.offer(sample({ nodeId: 'nodeaaaa' })); // honest: local's best move
      await sc.idle();
      sc.offer(sample({ nodeId: 'nodebbbb', bestMove: 'a2a3', score: { cp: -55 } }));
      await sc.idle();
    }
    expect(mem.getNode('nodeaaaa')).toMatchObject({ state: 'normal', suspectCount: 0 });
    expect(mem.getNode('nodebbbb')).toMatchObject({ state: 'suspect', suspectCount: 1 });
    // Flagged at the first moment the window allowed it.
    const b = mem.rows.filter((r) => r.nodeId === 'nodebbbb');
    expect(b.findIndex((r) => r.at === mem.getNode('nodebbbb')!.suspectUntil! - DAY)).toBe(9);
  });

  it('a slightly different honest engine (moves within tolerance) is never flagged', async () => {
    const sc = checker({ rate: 1, maxPerHour: 1_000 });
    for (let i = 0; i < 60; i++) {
      now += 1_000;
      sc.offer(sample({ bestMove: i % 2 ? 'd2d4' : 'e2e4', score: { cp: 20 } }));
      await sc.idle();
    }
    expect(sc.stats()).toMatchObject({ agreed: 60, disagreed: 0 });
    expect(mem.getNode('nodeaaaa')!.state).toBe('normal');
  });
});

// ---------------------------------------------------------------------------------- SQLite

describe.skipIf(!sqlite)('Reputation over HubStore (SQLite)', () => {
  let dir: string;
  let store: HubStore;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'daisychess-spotcheck-'));
    store = await HubStore.open({ path: path.join(dir, 'hub.sqlite') }, silent);
    store.upsertOperator({ lichessId: 'anna', username: 'Anna', newId: 'op1op1op' }, T0);
    for (const id of ['nodeaaaa', 'nodebbbb']) {
      store.insertNode({
        id,
        operatorId: 'op1op1op',
        name: id,
        secretHash: 'a'.repeat(64),
        pool: true,
        poolShare: 2,
        createdAt: T0,
      });
    }
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores node, time and verdict only — no position, move, score or token', async () => {
    reputation = new Reputation(store, moderation, silent);
    const sc = checker({ rate: 1, maxPerHour: 1_000 });
    for (let i = 0; i < 12; i++) {
      now += 1_000;
      sc.offer(sample({ nodeId: 'nodebbbb', bestMove: 'a2a3', score: { cp: -55 } }));
      await sc.idle();
    }
    expect(store.getNode('nodebbbb')).toMatchObject({ state: 'suspect', suspectCount: 1 });
    store.close();
    const { DatabaseSync } = sqlite!;
    const raw = new DatabaseSync(path.join(dir, 'hub.sqlite'));
    const cols = raw
      .prepare('PRAGMA table_info(spotchecks)')
      .all()
      .map((c) => c.name);
    expect(cols).toEqual(['id', 'node_id', 'at', 'agreed']);
    const rows = raw.prepare('SELECT node_id, at, agreed FROM spotchecks').all();
    expect(rows).toHaveLength(12);
    // Nothing anywhere in the file mentions the position or the moves.
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => String(t.name));
    const dump = tables
      .flatMap((t) => raw.prepare(`SELECT * FROM "${t}"`).all())
      .map((r) => JSON.stringify(r))
      .join('\n');
    expect(dump).not.toContain('rnbqkbnr');
    expect(dump).not.toContain('a2a3');
    expect(dump).not.toContain('e2e4');
    raw.close();
    store = await HubStore.open({ path: path.join(dir, 'hub.sqlite') }, silent);
  });

  it('recentSpotchecks: newest first, since and limit; setNodeReputation round-trips', () => {
    store.insertSpotcheck('nodeaaaa', T0, true);
    store.insertSpotcheck('nodeaaaa', T0 + 1, false);
    store.insertSpotcheck('nodeaaaa', T0 + 2, true);
    store.insertSpotcheck('nodebbbb', T0 + 3, false);
    expect(store.recentSpotchecks('nodeaaaa', 0, 50)).toEqual([true, false, true]);
    expect(store.recentSpotchecks('nodeaaaa', T0 + 1, 50)).toEqual([true, false]);
    expect(store.recentSpotchecks('nodeaaaa', 0, 1)).toEqual([true]);
    expect(store.recentSpotchecks('nodecccc', 0, 50)).toEqual([]);
    expect(
      store.setNodeReputation('nodeaaaa', { state: 'suspect', suspectCount: 2, suspectUntil: T0 }),
    ).toMatchObject({ state: 'suspect', suspectCount: 2, suspectUntil: T0 });
    expect(
      store.setNodeReputation('zzzzzzzz', { state: 'normal', suspectCount: 0, suspectUntil: null }),
    ).toBeUndefined();
    expect(store.purgeExpired(T0 + SPOTCHECK_RETENTION_MS + 3, 90).spotchecks).toBe(3);
  });

  it("an administrator's manual clear restarts the window", () => {
    reputation = new Reputation(store, moderation, silent);
    const svc = new HubTokenService(store, {
      accessToken: null,
      poolDailyBudgetMin: 30,
      usageRetentionDays: 90,
    });
    for (let i = 0; i < 10; i++) reputation.record('nodeaaaa', i < 6, (now += 1_000));
    expect(store.getNode('nodeaaaa')!.state).toBe('suspect');
    now += HOUR;
    expect(svc.setNodeState('nodeaaaa', 'normal', now)).toMatchObject({
      state: 'normal',
      suspectCount: 1,
      suspectUntil: now,
    });
    // The disagreements before the clear do not count any more.
    for (let i = 0; i < 9; i++) expect(reputation.record('nodeaaaa', true, (now += 1))).toBeNull();
    expect(reputation.record('nodeaaaa', false, (now += 1))).toBeNull();
    expect(store.getNode('nodeaaaa')!.state).toBe('normal');
  });
});

// ---------------------------------------------------------------------------------- pool

describe('createPoolChecker (EnginePool + fake engine)', () => {
  const pools: EnginePool[] = [];
  let players = 0;
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.shutdown()));
    players = 0;
  });

  function make(maxSessions = 3, maxInstances = 2) {
    const pool = new EnginePool(
      { engines: [engineConfig({ id: 'stockfish', name: 'Stockfish 19', maxInstances })] },
      { maxSessions, idleMs: 60_000, spawn: fakeSpawner() },
    );
    pools.push(pool);
    const lc = createPoolChecker(pool, {
      maxSessions,
      maxInstances: () => maxInstances,
      playerSearches: () => players,
      pollMs: 5,
    });
    return { pool, lc };
  }

  it('canStart only with no player search and a free session and instance left for players', async () => {
    const { pool, lc } = make(3, 2);
    expect(lc.canStart('stockfish')).toBe(true);
    players = 1;
    expect(lc.canStart('stockfish')).toBe(false);
    expect(lc.playerActive()).toBe(true);
    players = 0;
    const held = await pool.acquire('stockfish'); // an idle player session
    expect(held.ok).toBe(true);
    expect(lc.canStart('stockfish')).toBe(false); // the last instance stays for players
    if (held.ok) await pool.release(held.lease);
    expect(make(1, 2).lc.canStart('stockfish')).toBe(false); // MAX_SESSIONS 1: never
    expect(make(4, 1).lc.canStart('stockfish')).toBe(false); // one instance: never
  });

  it('searches to depth, restricts with searchmoves, releases the lease on close', async () => {
    const { pool, lc } = make();
    const s = await lc.open('stockfish');
    expect(s).not.toBeNull();
    expect(pool.sessions).toBe(1);
    const best = await s!.search(START, { depth: 3, movetimeMs: 5_000 }, () => false);
    expect(best).toEqual({ bestMove: 'e2e4', score: { cp: 29 }, depth: 3 });
    const restricted = await s!.search(
      START,
      { depth: 3, movetimeMs: 5_000, searchmoves: ['d2d4'] },
      () => false,
    );
    expect(restricted).toEqual({ bestMove: 'd2d4', score: { cp: 4 }, depth: 3 });
    s!.close();
    s!.close();
    expect(pool.sessions).toBe(0);
    expect(await s!.search(START, { depth: 1, movetimeMs: 1_000 }, () => false)).toBeNull();
  });

  it('stops within pollMs when a player search starts; misses the depth on movetime', async () => {
    const { lc } = make();
    const s = (await lc.open('stockfish'))!;
    let abort = false;
    setTimeout(() => (abort = true), 30);
    const t = Date.now();
    expect(await s.search(START, { depth: 500, movetimeMs: 10_000 }, () => abort)).toBeNull();
    expect(Date.now() - t).toBeLessThan(2_000);
    const capped = await s.search(START, { depth: 500, movetimeMs: 60 }, () => false);
    expect(capped!.depth).toBeLessThan(500);
    s.close();
  });

  it('open returns null when no instance is free', async () => {
    const { pool, lc } = make(3, 1);
    const held = await pool.acquire('stockfish');
    expect(await lc.open('stockfish')).toBeNull();
    if (held.ok) await pool.release(held.lease);
    expect(await lc.open('unknown')).toBeNull();
  });
});
