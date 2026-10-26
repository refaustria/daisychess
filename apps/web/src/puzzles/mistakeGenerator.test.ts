import { Chess } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalyzeOptions, BestMove, Engine, EngineInfo, Score } from '@daisychess/engine-core';
import { WasmEngineError } from '../engine/wasmHealth';
import type { MoveDetail, MoveDetails } from '../review/details';
import type { StoredReview } from '../review/reviewCache';
import type { SearchEngineLease } from '../review/reviewStore';
import { configureApiConnection } from '../server/apiConnection';
import { useSettingsStore } from '../store/settingsStore';
import type { LedgerGame } from './gameLedger';
import {
  BACKGROUND_NOTICE,
  cancelMistakePuzzles,
  collectLines,
  configureMistakeGenerator,
  findMistakePuzzles,
  generateMistakePuzzles,
  ledgerBatchGame,
  MAX_CONSECUTIVE_FAILURES,
  searchOptions,
  serverReviewsUsable,
  useMistakeGenStore,
  WAITING_NOTICE,
  type GeneratorHooks,
  type PauseSource,
} from './mistakeGenerator';
import { configureMistakeStore, deleteMistake, getScanMarker, listMistakes } from './mistakeStore';

// ---------------------------------------------------------------------------------------------
// Fixtures

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const key = (fen: string): string => fen.split(' ').slice(0, 4).join(' ');

/** FEN before each ply (index 0 = before ply 1) and the UCI moves. */
function replay(sans: readonly string[]): { fens: string[]; ucis: string[] } {
  const chess = new Chess(START);
  const fens: string[] = [];
  const ucis: string[] = [];
  for (const san of sans) {
    fens.push(chess.fen());
    const m = chess.move(san);
    ucis.push(`${m.from}${m.to}${m.promotion ?? ''}`);
  }
  fens.push(chess.fen());
  return { fens, ucis };
}

const after = (fen: string, ...ucis: string[]): string => {
  const chess = new Chess(fen);
  for (const u of ucis) chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  return chess.fen();
};

interface Mistake {
  bestUci: string;
  evalIfBest: Score;
  evalAfterWhite: Score;
  classification?: 'mistake' | 'blunder';
}

function review(gameKey: string, sans: string[], mistakes: Record<number, Mistake>): StoredReview {
  const { fens, ucis } = replay(sans);
  const details: MoveDetails = {};
  sans.forEach((san, i) => {
    const ply = i + 1;
    const m = mistakes[ply];
    const d = {
      ply,
      mover: i % 2 === 0 ? 'white' : 'black',
      moveLabel: '',
      playedUci: ucis[i]!,
      playedSan: san,
      bestLine: [],
      bestLineSan: '',
      bestLineMoves: [],
      bestLineFen: fens[i]!,
      fenBefore: fens[i]!,
      fenAfter: fens[i + 1]!,
      evalBeforeWhite: m ? m.evalIfBest : { cp: 20 },
      evalAfterWhite: m ? m.evalAfterWhite : { cp: 20 },
      swing: '',
      winProbLoss: m ? 30 : 0,
      playedIsBest: !m,
      classification: m ? (m.classification ?? 'blunder') : 'good',
      ...(m ? { bestUci: m.bestUci, evalIfBest: m.evalIfBest } : { bestUci: ucis[i]! }),
    } as MoveDetail;
    details[ply] = d;
  });
  return {
    gameKey,
    startFen: START,
    moves: sans,
    preset: 'fast',
    options: { movetime: 300 },
    summary: {} as StoredReview['summary'],
    moveDetails: details,
    engine: { kind: 'browser' },
    createdAt: 500,
    version: 1,
  };
}

/** 4. d3?? misses 4. Qxf7# (White). */
const MATE_SANS = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'd3'];
const MATE = replay(MATE_SANS);
const MATE_START = MATE.fens[6]!; // before 4. d3
const MATE_INTRO_FEN = MATE.fens[5]!; // before 3... Nf6

/** 5. h3?? misses Légal's mate 5. Nxe5! Bxd1 6. Bxf7+ Ke7 7. Nd5#. */
const LEGAL_SANS = ['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6', 'h3'];
const LEGAL = replay(LEGAL_SANS);
const LEGAL_START = LEGAL.fens[8]!;

function ledgerGame(gameKey: string, sans: string[], over: Partial<LedgerGame> = {}): LedgerGame {
  return {
    gameKey,
    startFen: START,
    moves: sans,
    headers: { White: 'Me', Black: 'You' },
    source: 'pgn',
    userSide: 'white',
    reviewedAt: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// Scripted engine

interface Line {
  pv: string[];
  /** White POV, as every engine client reports it. */
  score: Score;
}

class ScriptEngine implements Engine {
  readonly scripts = new Map<string, Line[]>();
  readonly calls: { fen: string; opts: AnalyzeOptions }[] = [];
  /** FENs whose next search hangs until stop(). */
  readonly hangOnce = new Set<string>();
  readonly hang = new Set<string>();
  readonly failures: Error[] = [];
  stopCalls = 0;
  onAnalyze: ((fen: string) => void) | undefined;
  private stopper: (() => void) | null = null;

  async load(): Promise<void> {}
  async setOptions(): Promise<void> {}
  async dispose(): Promise<void> {}
  async stop(): Promise<void> {
    this.stopCalls++;
    this.stopper?.();
  }

  analyze(fen: string, opts: AnalyzeOptions) {
    this.calls.push({ fen, opts });
    const failure = this.failures.shift();
    const k = key(fen);
    const hangs = this.hang.has(k) || this.hangOnce.delete(k);
    const lines = (this.scripts.get(k) ?? [{ pv: [firstMove(fen)], score: { cp: 0 } }]).slice(
      0,
      opts.multipv ?? 1,
    );
    let resolveBest!: (b: BestMove | null) => void;
    const bestMove = new Promise<BestMove | null>((r) => (resolveBest = r));
    const it = this.run(fen, failure, hangs, lines, resolveBest);
    return { bestMove, [Symbol.asyncIterator]: () => it };
  }

  private async *run(
    fen: string,
    failure: Error | undefined,
    hangs: boolean,
    lines: readonly Line[],
    resolveBest: (b: BestMove | null) => void,
  ): AsyncGenerator<EngineInfo> {
    this.onAnalyze?.(fen);
    await Promise.resolve();
    if (failure) throw failure;
    if (hangs) {
      await new Promise<void>((r) => (this.stopper = r));
      this.stopper = null;
      resolveBest(null);
      return;
    }
    for (const depth of [8, 10]) {
      for (let i = 0; i < lines.length; i++) {
        yield { depth, multipv: i + 1, score: lines[i]!.score, pv: lines[i]!.pv };
      }
    }
    resolveBest({ move: lines[0]!.pv[0]! });
  }
}

function firstMove(fen: string): string {
  const m = new Chess(fen).moves({ verbose: true })[0];
  return m ? `${m.from}${m.to}${m.promotion ?? ''}` : '0000';
}

function scriptMate(e: ScriptEngine): void {
  e.scripts.set(key(MATE_START), [
    { pv: ['h5f7'], score: { mate: 1 } },
    { pv: ['b1c3'], score: { cp: 40 } },
  ]);
}

function scriptLegal(e: ScriptEngine): void {
  e.scripts.set(key(LEGAL_START), [
    { pv: ['f3e5', 'g4d1', 'c4f7', 'e8e7', 'c3d5'], score: { cp: 400 } },
    { pv: ['h2h3'], score: { cp: 40 } },
  ]);
  // Black to move after 5. Nxe5: Bxd1 loses to mate, dxe5 loses a piece (White POV scores).
  e.scripts.set(key(after(LEGAL_START, 'f3e5')), [
    { pv: ['g4d1', 'c4f7', 'e8e7', 'c3d5'], score: { mate: 2 } },
    { pv: ['d6e5', 'd1g4'], score: { cp: 300 } },
  ]);
  e.scripts.set(key(after(LEGAL_START, 'f3e5', 'g4d1', 'c4f7')), [
    { pv: ['e8e7', 'c3d5'], score: { mate: 1 } },
  ]);
}

interface FakeLease extends SearchEngineLease {
  dispose: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function lease(engine: Engine, kind: 'server' | 'browser', notice?: string): FakeLease {
  return {
    engine,
    runsOn: { kind },
    ...(notice ? { notice } : {}),
    dispose: vi.fn(async () => undefined),
  };
}

class FakePause implements PauseSource {
  value: string | undefined;
  private readonly subs = new Set<() => void>();
  reason = () => this.value;
  subscribe = (cb: () => void) => {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  };
  set(v: string | undefined): void {
    this.value = v;
    for (const s of [...this.subs]) s();
  }
  get listeners(): number {
    return this.subs.size;
  }
}

interface Setup {
  hooks: GeneratorHooks;
  engine: ScriptEngine;
  leases: FakeLease[];
  pause: FakePause;
  releaseAnalysis: ReturnType<typeof vi.fn>;
}

function setup(
  games: LedgerGame[],
  reviews: StoredReview[],
  over: Partial<GeneratorHooks> = {},
): Setup {
  const engine = new ScriptEngine();
  const leases: FakeLease[] = [];
  const pause = new FakePause();
  const releaseAnalysis = vi.fn();
  const byKey = new Map(reviews.map((r) => [r.gameKey, r]));
  const hooks: GeneratorHooks = {
    openEngine: vi.fn(async () => {
      const l = lease(engine, 'browser');
      leases.push(l);
      return l;
    }),
    reportServerFailure: vi.fn(() => undefined),
    canUseServer: () => false,
    browserDisabled: () => false,
    listGames: async () => games,
    localReview: async (k) => byKey.get(k),
    serverReview: vi.fn(async () => undefined),
    pauseAnalysis: vi.fn(() => releaseAnalysis),
    pauseSource: () => pause,
    yieldToUi: () => Promise.resolve(),
    now: () => 1000,
    searchTimeoutMs: 5000,
    ...over,
  };
  return { hooks, engine, leases, pause, releaseAnalysis };
}

const flush = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  configureMistakeStore(null);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  configureMistakeStore(undefined);
  configureMistakeGenerator();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Pure helpers

describe('collectLines', () => {
  const fenB = after(START, 'e2e4');
  const info = (depth: number, multipv: number, pv: string[], score: Score): EngineInfo => ({
    depth,
    multipv,
    pv,
    score,
  });

  it('uses the deepest depth with every line and converts to the side to move', () => {
    const lines = collectLines(
      fenB,
      [
        info(9, 1, ['e7e5'], { cp: 30 }),
        info(9, 2, ['c7c5'], { cp: 50 }),
        info(10, 1, ['c7c5'], { cp: 40 }), // depth 10 never got its second line
      ],
      2,
    );
    expect(lines).toEqual([
      { pv: ['e7e5'], score: { cp: -30 } },
      { pv: ['c7c5'], score: { cp: -50 } },
    ]);
  });

  it('keeps a longer earlier PV when the last one is a truncated prefix', () => {
    const lines = collectLines(
      START,
      [info(8, 1, ['e2e4', 'e7e5', 'g1f3'], { cp: 30 }), info(10, 1, ['e2e4'], { mate: 3 })],
      1,
    );
    expect(lines).toEqual([{ pv: ['e2e4', 'e7e5', 'g1f3'], score: { mate: 3 } }]);
  });

  it('ignores extra lines and empty PVs; nothing → no lines', () => {
    expect(collectLines(START, [], 2)).toEqual([]);
    expect(
      collectLines(START, [info(5, 3, ['a2a3'], { cp: 0 }), info(5, 1, [], { cp: 0 })], 2),
    ).toEqual([]);
    expect(collectLines(START, [info(5, 1, ['e2e4'], { cp: 10 })], 2)).toHaveLength(1);
  });
});

describe('searchOptions', () => {
  it('uses 1,000 ms for the start, 500 ms otherwise in the browser and depth 16 on the server', () => {
    expect(searchOptions('browser', 'start', 2)).toEqual({ movetime: 1000, multipv: 2 });
    expect(searchOptions('browser', 'reply', 2)).toEqual({ movetime: 500, multipv: 2 });
    expect(searchOptions('browser', 'final', 1)).toEqual({ movetime: 500, multipv: 1 });
    expect(searchOptions('server', 'start', 2)).toEqual({ depth: 16, multipv: 2 });
  });
});

describe('ledgerBatchGame', () => {
  it('replays the SAN moves', () => {
    const g = ledgerBatchGame({ startFen: START, moves: ['e4', 'e5'] });
    expect(g?.moves.map((m) => m.uci)).toEqual(['e2e4', 'e7e5']);
    expect(g?.moves[1]?.fenAfter).toBe(after(START, 'e2e4', 'e7e5'));
  });
  it('returns undefined for an illegal game', () => {
    expect(ledgerBatchGame({ startFen: START, moves: ['e5'] })).toBeUndefined();
  });
});

describe('serverReviewsUsable', () => {
  afterEach(() => {
    useSettingsStore.setState({ serverToken: '', reviewEngine: 'auto' });
    configureApiConnection(null);
  });
  it('needs the api, a token and a review engine setting other than browser', () => {
    useSettingsStore.setState({ serverToken: 'secret', reviewEngine: 'auto' });
    expect(serverReviewsUsable()).toBe(false); // api disabled (tests)
    // A socket factory that is never used: nothing is sent by the check itself.
    configureApiConnection({
      createSocket: () => {
        throw new Error('unused');
      },
    });
    useSettingsStore.setState({ serverToken: '' });
    expect(serverReviewsUsable()).toBe(false);
    useSettingsStore.setState({ serverToken: 'secret' });
    expect(serverReviewsUsable()).toBe(true);
    useSettingsStore.setState({ reviewEngine: 'browser' });
    expect(serverReviewsUsable()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Generation

describe('generateMistakePuzzles', () => {
  it('turns a missed mate in one into a puzzle with the intro move', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    scriptMate(s.engine);
    const progress = vi.fn();
    const r = await generateMistakePuzzles({ onProgress: progress }, s.hooks);
    expect(r.status).toBe('done');
    expect(r.added).toHaveLength(1);
    const [p] = await listMistakes();
    expect(p).toMatchObject({
      gameKey: 'gm',
      ply: 7,
      playedUci: 'd2d3',
      classification: 'blunder',
      createdAt: 1000,
      schedule: { due: 1000, interval: 0, lapses: 0, successes: 0 },
    });
    expect(p!.puzzle).toMatchObject({
      fen: MATE_INTRO_FEN,
      moves: ['g8f6', 'h5f7'],
      source: 'mistake',
    });
    expect(p!.puzzle.id).toBe(p!.id);
    expect(s.engine.calls).toEqual([{ fen: MATE_START, opts: { movetime: 1000, multipv: 2 } }]);
    expect(r.searches).toBe(1);
    // Lease released, live analysis paused for the browser run and restored.
    expect(s.leases[0]!.dispose).toHaveBeenCalled();
    expect(s.hooks.pauseAnalysis).toHaveBeenCalledTimes(1);
    expect(s.releaseAnalysis).toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({ gamesTotal: 1, gamesDone: 1, found: 1, searches: 1 }),
    );
    expect(s.pause.listeners).toBe(0);
  });

  it('cuts a forced line of three user moves (Légal mate) with ≤ 4 searches', async () => {
    const s = setup(
      [ledgerGame('gl', LEGAL_SANS)],
      [
        review('gl', LEGAL_SANS, {
          9: { bestUci: 'f3e5', evalIfBest: { cp: 400 }, evalAfterWhite: { cp: 30 } },
        }),
      ],
    );
    scriptLegal(s.engine);
    const r = await generateMistakePuzzles({}, s.hooks);
    expect(r.status).toBe('done');
    expect(r.added).toHaveLength(1);
    expect(r.added[0]!.puzzle.moves).toEqual(['g7g6', 'f3e5', 'g4d1', 'c4f7', 'e8e7', 'c3d5']);
    expect(s.engine.calls.map((c) => c.opts)).toEqual([
      { movetime: 1000, multipv: 2 },
      { movetime: 500, multipv: 2 },
      { movetime: 500, multipv: 2 },
    ]);
  });

  it('skips a candidate whose best move is not clearly better and remembers it', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    s.engine.scripts.set(key(MATE_START), [
      { pv: ['h5f7'], score: { cp: 120 } },
      { pv: ['b1c3'], score: { cp: 100 } },
    ]);
    const r = await generateMistakePuzzles({}, s.hooks);
    expect(r.added).toEqual([]);
    expect(r.skipped).toEqual({ 'not-clear': 1 });
    expect((await getScanMarker('gm'))?.ids).toHaveLength(1);
    // The next run does not search the same position again.
    const again = await generateMistakePuzzles({}, s.hooks);
    expect(again.searches).toBe(0);
    expect(s.engine.calls).toHaveLength(1);
    // … unless asked to rescan.
    const rescan = await generateMistakePuzzles({ rescan: true }, s.hooks);
    expect(rescan.searches).toBe(1);
  });

  it('never duplicates a stored puzzle and does not bring back a deleted one', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    scriptMate(s.engine);
    const first = await generateMistakePuzzles({}, s.hooks);
    expect(first.added).toHaveLength(1);
    const second = await generateMistakePuzzles({ rescan: true }, s.hooks);
    expect(second.added).toEqual([]);
    expect(second.searches).toBe(0);
    await deleteMistake(first.added[0]!.id);
    const third = await generateMistakePuzzles({}, s.hooks);
    expect(third.searches).toBe(0);
    expect(await listMistakes()).toEqual([]);
  });

  it('only scans games with a known side; fetches missing reviews from the server hook', async () => {
    const serverReview = vi.fn(async (g: LedgerGame) =>
      g.gameKey === 'remote' ? review('remote', MATE_SANS, { 7: mateMistake() }) : undefined,
    );
    const s = setup(
      [
        ledgerGame('noside', MATE_SANS, { userSide: undefined }),
        ledgerGame('skipped', MATE_SANS, { userSide: undefined, sideSkipped: true }),
        ledgerGame('remote', MATE_SANS),
        ledgerGame('missing', MATE_SANS),
      ],
      [],
      { serverReview },
    );
    scriptMate(s.engine);
    const r = await generateMistakePuzzles({}, s.hooks);
    expect(serverReview.mock.calls.map(([g]) => g.gameKey)).toEqual(['remote', 'missing']);
    expect(r.gamesScanned).toBe(1);
    expect(r.gamesWithoutReview).toEqual(['missing']);
    expect(r.added).toHaveLength(1);
  });

  it('ignores a review whose moves do not match the ledger game', async () => {
    const s = setup(
      [ledgerGame('gm', MATE_SANS)],
      [{ ...review('gm', MATE_SANS, { 7: mateMistake() }), moves: ['e4'] }],
    );
    const r = await generateMistakePuzzles({}, s.hooks);
    expect(r.gamesWithoutReview).toEqual(['gm']);
    expect(s.engine.calls).toEqual([]);
  });

  it('limits the queue to the given games and black mistakes for a black user', async () => {
    const sans = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'];
    const { fens } = replay(sans);
    const s = setup(
      [ledgerGame('a', sans, { userSide: 'black' }), ledgerGame('b', MATE_SANS)],
      [
        review('a', sans, {
          6: { bestUci: 'd8e7', evalIfBest: { cp: 0 }, evalAfterWhite: { mate: 1 } },
        }),
        review('b', MATE_SANS, { 7: mateMistake() }),
      ],
    );
    s.engine.scripts.set(key(fens[5]!), [
      { pv: ['g7g6'], score: { cp: -20 } },
      { pv: ['d8e7'], score: { cp: 0 } },
    ]);
    const r = await generateMistakePuzzles({ gameKeys: ['a'] }, s.hooks);
    expect(s.engine.calls.map((c) => c.fen)).toEqual([fens[5]]);
    expect(r.skipped).toEqual({ 'not-clear': 1 });
  });

  it('cancels a running search at once, releases the engine and keeps nothing half-done', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    s.engine.hang.add(key(MATE_START));
    const ac = new AbortController();
    s.engine.onAnalyze = () => queueMicrotask(() => ac.abort());
    const r = await generateMistakePuzzles({ signal: ac.signal }, s.hooks);
    expect(r.status).toBe('cancelled');
    expect(s.engine.stopCalls).toBeGreaterThan(0);
    expect(s.leases[0]!.dispose).toHaveBeenCalled();
    expect(s.releaseAnalysis).toHaveBeenCalled();
    expect(await getScanMarker('gm')).toBeUndefined();
  });

  it('a signal aborted before the start ends the run without any search', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    const ac = new AbortController();
    ac.abort();
    const r = await generateMistakePuzzles({ signal: ac.signal }, s.hooks);
    expect(r.status).toBe('cancelled');
    expect(s.hooks.openEngine).not.toHaveBeenCalled();
  });

  it('pauses in the background (search stopped, lease released) and resumes afterwards', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    scriptMate(s.engine);
    s.engine.hangOnce.add(key(MATE_START));
    s.engine.onAnalyze = () => {
      s.engine.onAnalyze = undefined;
      queueMicrotask(() => s.pause.set(BACKGROUND_NOTICE));
    };
    const onPause = vi.fn();
    const onNotice = vi.fn();
    const run = generateMistakePuzzles({ onPause, onNotice }, s.hooks);
    await flush();
    expect(onPause).toHaveBeenCalledWith(true);
    expect(onNotice).toHaveBeenLastCalledWith(BACKGROUND_NOTICE);
    expect(s.engine.stopCalls).toBe(1);
    expect(s.leases[0]!.dispose).toHaveBeenCalled();
    s.pause.set(undefined);
    const r = await run;
    expect(onPause).toHaveBeenLastCalledWith(false);
    expect(r.status).toBe('done');
    expect(r.added).toHaveLength(1);
    expect(s.leases).toHaveLength(2);
    expect(s.engine.calls).toHaveLength(2);
  });

  it('waits before the first game while a human game runs; cancel while paused', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    s.pause.value = 'Paused while playing against the engine';
    const ac = new AbortController();
    const onPause = vi.fn();
    const run = generateMistakePuzzles({ signal: ac.signal, onPause }, s.hooks);
    await flush();
    expect(onPause).toHaveBeenCalledWith(true);
    expect(s.hooks.openEngine).not.toHaveBeenCalled();
    ac.abort();
    expect((await run).status).toBe('cancelled');
  });

  it('falls back to the browser when the server fails mid-run (notice like the drill)', async () => {
    const browserEngine = new ScriptEngine();
    scriptMate(browserEngine);
    const serverEngine = new ScriptEngine();
    serverEngine.failures.push(new Error('socket closed'));
    const leases: FakeLease[] = [];
    const openEngine = vi.fn(async (pref: 'server' | 'browser' | undefined) => {
      const l =
        pref === 'browser' ? lease(browserEngine, 'browser') : lease(serverEngine, 'server');
      leases.push(l);
      return l;
    });
    const reportServerFailure = vi.fn(() => 'Engine server unreachable — reviewing in the browser');
    const s = setup(
      [ledgerGame('gm', MATE_SANS)],
      [review('gm', MATE_SANS, { 7: mateMistake() })],
      { openEngine, reportServerFailure },
    );
    const onNotice = vi.fn();
    const r = await generateMistakePuzzles({ onNotice }, s.hooks);
    expect(r.added).toHaveLength(1);
    expect(serverEngine.calls[0]!.opts).toEqual({ depth: 16, multipv: 2 });
    expect(openEngine.mock.calls.map((c) => c[0])).toEqual([undefined, 'browser']);
    expect(reportServerFailure).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith('Engine server unreachable — searching in the browser');
    expect(leases[0]!.dispose).toHaveBeenCalled();
    // The live analysis is paused only once the browser engine is in use.
    expect(s.hooks.pauseAnalysis).toHaveBeenCalledTimes(1);
  });

  it('retries once after a retryable browser engine failure (out of memory)', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    scriptMate(s.engine);
    s.engine.failures.push(new WasmEngineError('Out of memory', 'oom', true));
    const r = await generateMistakePuzzles({}, s.hooks);
    expect(r.added).toHaveLength(1);
    expect(s.engine.calls).toHaveLength(2);
  });

  it('hands over to the server once when the browser engine is disabled', async () => {
    const serverEngine = new ScriptEngine();
    scriptMate(serverEngine);
    const browser = new ScriptEngine();
    browser.failures.push(new WasmEngineError('Aborted()', 'worker', false));
    const openEngine = vi.fn(async (pref: 'server' | 'browser' | undefined) =>
      pref === 'server' ? lease(serverEngine, 'server') : lease(browser, 'browser'),
    );
    const s = setup(
      [ledgerGame('gm', MATE_SANS)],
      [review('gm', MATE_SANS, { 7: mateMistake() })],
      { openEngine, browserDisabled: () => true, canUseServer: () => true },
    );
    const r = await generateMistakePuzzles({}, s.hooks);
    expect(r.added).toHaveLength(1);
    expect(openEngine.mock.calls.map((c) => c[0])).toEqual([undefined, 'server']);
  });

  it('stops with a message when the browser engine is disabled and no server is allowed', async () => {
    const s = setup(
      [ledgerGame('gm', MATE_SANS)],
      [review('gm', MATE_SANS, { 7: mateMistake() })],
      { browserDisabled: () => true },
    );
    s.engine.failures.push(new WasmEngineError('Aborted()', 'worker', false));
    const r = await generateMistakePuzzles({}, s.hooks);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('Puzzle search stopped: the browser engine is unavailable (Aborted()).');
    expect(s.leases[0]!.dispose).toHaveBeenCalled();
  });

  it('times out a hanging search, skips the candidate and stops after repeated failures', async () => {
    const games = ['g1', 'g2', 'g3', 'g4'].map((k) => ledgerGame(k, MATE_SANS));
    const reviews = ['g1', 'g2', 'g3', 'g4'].map((k) => review(k, MATE_SANS, { 7: mateMistake() }));
    // Four games with the same position: a failed search is not remembered, so each game tries.
    const s = setup(games, reviews, { searchTimeoutMs: 20 });
    s.engine.hang.add(key(MATE_START));
    const r = await generateMistakePuzzles({}, s.hooks);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/engine failed \(The engine took too long\)/);
    expect(s.engine.calls).toHaveLength(MAX_CONSECUTIVE_FAILURES);
    expect(r.skipped['engine-error']).toBe(MAX_CONSECUTIVE_FAILURES - 1);
    // Failed candidates are not remembered: they are tried again next time.
    expect(await getScanMarker('g1')).toBeUndefined();
  });

  it('does not count the wait for the shared engine against the timeout', async () => {
    const engine = new ScriptEngine();
    scriptMate(engine);
    const notices: (string | undefined)[] = [];
    // The pooled engine reports a wait (a review holds it) for longer than the timeout.
    const waitingEngine: Engine = {
      load: async () => undefined,
      setOptions: async () => undefined,
      stop: () => engine.stop(),
      dispose: async () => undefined,
      analyze(fen, opts) {
        const inner = engine.analyze(fen, opts);
        const onWait = waitHook!;
        async function* run(): AsyncGenerator<EngineInfo> {
          onWait(true);
          await new Promise((r) => setTimeout(r, 80));
          onWait(false);
          yield* inner;
        }
        return run();
      },
    };
    let waitHook: ((w: boolean) => void) | undefined;
    const s = setup(
      [ledgerGame('gm', MATE_SANS)],
      [review('gm', MATE_SANS, { 7: mateMistake() })],
      {
        searchTimeoutMs: 40,
        openEngine: async (_pref, onWait) => {
          waitHook = onWait;
          return lease(
            waitingEngine,
            'browser',
            'Engine server unreachable — reviewing in the browser',
          );
        },
      },
    );
    const r = await generateMistakePuzzles({ onNotice: (n) => notices.push(n) }, s.hooks);
    expect(r.status).toBe('done');
    expect(r.added).toHaveLength(1);
    expect(notices).toEqual([
      'Engine server unreachable — searching in the browser',
      WAITING_NOTICE,
      'Engine server unreachable — searching in the browser',
    ]);
  });
});

describe('findMistakePuzzles (store)', () => {
  it('runs one generation at a time and reports progress and the result', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    scriptMate(s.engine);
    configureMistakeGenerator(s.hooks);
    const a = findMistakePuzzles();
    const b = findMistakePuzzles();
    expect(b).toBe(a);
    expect(useMistakeGenStore.getState().status).toBe('running');
    const r = await a;
    expect(r.added).toHaveLength(1);
    const st = useMistakeGenStore.getState();
    expect(st.status).toBe('done');
    expect(st.result).toBe(r);
    expect(st.progress).toMatchObject({ found: 1, gamesDone: 1 });
  });

  it('cancel ends the run as cancelled; paused state is visible', async () => {
    const s = setup([ledgerGame('gm', MATE_SANS)], [review('gm', MATE_SANS, { 7: mateMistake() })]);
    s.pause.value = BACKGROUND_NOTICE;
    configureMistakeGenerator(s.hooks);
    const run = findMistakePuzzles();
    await flush();
    expect(useMistakeGenStore.getState()).toMatchObject({
      status: 'paused',
      notice: BACKGROUND_NOTICE,
    });
    cancelMistakePuzzles();
    expect((await run).status).toBe('cancelled');
    expect(useMistakeGenStore.getState().status).toBe('cancelled');
  });
});

function mateMistake(): Mistake {
  return { bestUci: 'h5f7', evalIfBest: { mate: 1 }, evalAfterWhite: { cp: 30 } };
}
