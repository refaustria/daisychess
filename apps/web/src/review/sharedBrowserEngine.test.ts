/**
 * The review, the openings drill and play share one pooled browser engine (ADR-015): instance
 * counting, waiting, out-of-memory recovery and the server fallback of a disabled browser engine.
 */
import { DEFAULT_LIMITS } from '@chesslab/engine-core';
import { Chess } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserEnginePool } from '../engine/wasmPool';
import { disableWasm, resetWasmHealth, WasmEngineError } from '../engine/wasmHealth';
import { Book, type OpeningRow } from '../openings/book';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { configureDrill, resetDrill, useDrillStore, WAITING_NOTICE } from '../trainer/drillStore';
import { FakeReviewEngine } from './fakeEngine';
import { clearReviewCache, configureReviewCache } from './reviewCache';
import {
  BROWSER_UNAVAILABLE_NOTICE,
  disposeReviewEngine,
  setReviewEngineFactory,
  useReviewStore,
} from './reviewStore';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';
const ROWS: OpeningRow[] = [
  ['C20', "King's Pawn Game", 'x2', 'e4 e5'],
  ['C50', 'Italian Game', 'x5', 'e4 e5 Nf3 Nc6 Bc4'],
];
const book = new Book(ROWS);
const italian = book.openings.find((o) => o.name === 'Italian Game')!;

let engines: FakeReviewEngine[];
/** Applied to each new browser engine (index = creation order). */
let prepare: (e: FakeReviewEngine, i: number) => void;

function countingFactory(): FakeReviewEngine {
  const e = new FakeReviewEngine();
  prepare(e, engines.length);
  engines.push(e);
  return e;
}

class FakeRemoteClient extends FakeReviewEngine {
  engineName = 'Stockfish 19';
  limits = { ...DEFAULT_LIMITS, maxThreads: 8 };
}

function play(san: string): void {
  const g = useGameStore.getState();
  const m = new Chess(g.moves.at(-1)?.fen ?? g.startFen).move(san);
  expect(g.makeMove(m.from, m.to, m.promotion)).toBe(true);
}

async function setupDrill(): Promise<void> {
  // Default engine hook (openSearchEngine → the shared pool); small book, no delays.
  await configureDrill({
    appDelayMs: () => 0,
    random: () => 0,
    book: () => book,
    search: { movetime: 10 },
    storage: undefined,
    checkTimeoutMs: 2_000,
  });
}

beforeEach(async () => {
  configureReviewCache(null);
  await clearReviewCache();
  resetWasmHealth();
  engines = [];
  prepare = () => undefined;
  setReviewEngineFactory(countingFactory);
  useSettingsStore.getState().set({ reviewEngine: 'browser' });
  useReviewStore.getState().reset();
  await resetDrill();
  useGameStore.getState().loadPgn(SCHOLAR);
});

afterEach(async () => {
  await resetDrill();
  useReviewStore.getState().reset();
  await disposeReviewEngine();
  useSettingsStore.getState().set({ reviewEngine: 'auto' });
  useAnalysisStore.getState().setEnabled(false);
  resetWasmHealth();
});

const failLoadForGood = (e: FakeReviewEngine) => {
  e.load = async () => {
    const msg = 'Stockfish worker error: RangeError: Out of memory';
    disableWasm(msg);
    throw new WasmEngineError(msg, 'oom', false);
  };
};

describe('shared browser engine: review + drill', () => {
  it('a drill after a review uses the same instance (no second engine)', async () => {
    const summary = await useReviewStore.getState().start({ movetime: 10 });
    expect(summary?.moves).toHaveLength(7);
    expect(engines).toHaveLength(1);
    expect(browserEnginePool.stats).toMatchObject({ alive: true, holder: null });

    await setupDrill();
    useDrillStore.getState().start(italian, 'white');
    play('e4');
    await vi.waitFor(() => expect(useDrillStore.getState().phase).toBe('user'));
    const before = new Chess();
    before.move('e4');
    before.move('e5');
    play('a3'); // not book: engine check
    await vi.waitFor(() => expect(useDrillStore.getState().phase).toBe('retry'));
    expect(useDrillStore.getState().feedback).toMatchObject({ kind: 'fine', san: 'a3' });
    expect(engines).toHaveLength(1);
    expect(engines[0]!.analysed).toContain(before.fen());
    expect(useDrillStore.getState().runsOn).toEqual({ kind: 'browser' });
  });

  it('a drill check waits for a running review (notice), then runs on the same engine', async () => {
    prepare = (e) => {
      e.delayMs = 40;
    };
    const review = useReviewStore.getState().start({ movetime: 10 });
    await vi.waitFor(() => expect(browserEnginePool.stats.holder).toBe('review'));
    await setupDrill();
    useDrillStore.getState().start(italian, 'white');
    play('e4');
    await vi.waitFor(() => expect(useDrillStore.getState().phase).toBe('user'));
    play('a3');
    await vi.waitFor(() => expect(useDrillStore.getState().engineNotice).toBe(WAITING_NOTICE));
    expect(useDrillStore.getState().phase).toBe('checking');
    expect(useReviewStore.getState().status).toBe('running');
    expect((await review)?.moves).toHaveLength(7);
    await vi.waitFor(() => expect(useDrillStore.getState().phase).toBe('retry'), { timeout: 3000 });
    expect(useDrillStore.getState().feedback).toMatchObject({ kind: 'fine' });
    expect(useDrillStore.getState().engineNotice).toBeUndefined();
    expect(engines).toHaveLength(1);
  });

  it('review: out of memory mid-run → one fresh engine, the run completes from the cache', async () => {
    const fen3 = useGameStore.getState().moves[2]!.fen;
    prepare = (e, i) => {
      if (i === 0)
        e.fail.set(fen3, new WasmEngineError('Stockfish worker error: RangeError: Out of memory', 'oom', true));
    };
    const summary = await useReviewStore.getState().start({ movetime: 10 });
    expect(useReviewStore.getState()).toMatchObject({ status: 'done' });
    expect(summary?.moves).toHaveLength(7);
    expect(engines).toHaveLength(2);
    expect(engines[0]!.disposed).toBe(true);
    // Positions searched before the failure are not searched again.
    expect(engines[1]!.analysed).not.toContain(useGameStore.getState().startFen);
  });

  it('review: browser engine disabled, browser preference → one error, no server', async () => {
    let serverCreated = 0;
    setReviewEngineFactory(countingFactory, () => {
      serverCreated++;
      return new FakeRemoteClient();
    });
    prepare = (e) => failLoadForGood(e);
    expect(await useReviewStore.getState().start({ movetime: 10 })).toBeUndefined();
    expect(useReviewStore.getState()).toMatchObject({ status: 'error' });
    expect(useReviewStore.getState().error).toMatch(/Out of memory/);
    expect(serverCreated).toBe(0);
  });

  it('review (auto): browser disabled while the server was on cooldown → reviews on the server', async () => {
    let serverFails = true;
    const remote = new FakeRemoteClient();
    remote.load = async () => {
      if (serverFails) throw Object.assign(new Error('closed'), { code: 'closed' });
    };
    setReviewEngineFactory(countingFactory, () => remote);
    useSettingsStore.getState().set({ reviewEngine: 'auto' });
    // 1st run: the server fails → browser (and a 60 s cooldown for the server).
    await useReviewStore.getState().start({ movetime: 10 });
    expect(useReviewStore.getState().runsOn).toEqual({ kind: 'browser' });
    // The browser engine then fails for good; the server is back.
    serverFails = false;
    await browserEnginePool.dispose();
    prepare = (e) => failLoadForGood(e);
    const summary = await useReviewStore.getState().start({ depth: 3 });
    expect(summary?.moves).toHaveLength(7);
    expect(useReviewStore.getState()).toMatchObject({
      status: 'done',
      runsOn: { kind: 'server' },
      engineNotice: BROWSER_UNAVAILABLE_NOTICE,
    });
  });

  it('drill: a disabled browser engine ends the drill once with the reason', async () => {
    prepare = (e) => failLoadForGood(e);
    await setupDrill();
    useDrillStore.getState().start(italian, 'white');
    play('e4');
    await vi.waitFor(() => expect(useDrillStore.getState().phase).toBe('user'));
    play('a3');
    await vi.waitFor(() => expect(useDrillStore.getState().status).toBe('idle'));
    expect(useDrillStore.getState().message).toMatch(
      /^Drill ended: the browser engine is unavailable \(.*Out of memory.*\)\.$/,
    );
    expect(engines).toHaveLength(1);
  });

  it('drill: out of memory during a check → retried once on a fresh engine', async () => {
    const after = new Chess();
    after.move('e4');
    after.move('e5');
    prepare = (e, i) => {
      if (i === 0) e.fail.set(after.fen(), new WasmEngineError('Stockfish worker error: RangeError: Out of memory', 'oom', true));
    };
    await setupDrill();
    useDrillStore.getState().start(italian, 'white');
    play('e4');
    await vi.waitFor(() => expect(useDrillStore.getState().phase).toBe('user'));
    play('a3');
    await vi.waitFor(() => expect(useDrillStore.getState().phase).toBe('retry'));
    expect(useDrillStore.getState().feedback).toMatchObject({ kind: 'fine' });
    expect(engines).toHaveLength(2);
    expect(engines[0]!.disposed).toBe(true);
  });
});

