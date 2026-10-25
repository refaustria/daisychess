import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { FakeReviewEngine } from './fakeEngine';
import {
  configureReviewCache,
  countStoredReviews,
  gameKey,
  getStoredPositions,
  getStoredReview,
  peekStoredPreset,
  warmReviewCache,
} from './reviewCache';
import {
  REVIEW_PRESETS,
  clearReviewCaches,
  disposeReviewEngine,
  gameToBatch,
  optionsKey,
  presetOf,
  satisfies,
  setReviewEngineFactory,
  useReviewStore,
  type ReviewStatus,
} from './reviewStore';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';
const SCHOLAR_WITH_HEADERS = `[Event "Club"]\n[White "Ann"]\n[Black "Bob"]\n\n${SCHOLAR} 1-0`;

let factory: IDBFactory;
let engine: FakeReviewEngine;
let created = 0;

const fens = (): string[] => [
  useGameStore.getState().startFen,
  ...useGameStore.getState().moves.map((m) => m.fen),
];
const key = (): string => {
  const g = gameToBatch(useGameStore.getState());
  return gameKey(
    g.startFen,
    g.moves.map((m) => m.uci),
  );
};

function installFakeEngine(): void {
  engine = new FakeReviewEngine();
  created = 0;
  setReviewEngineFactory(() => {
    created++;
    return engine;
  });
}

/** Simulates a page reload: new engine, empty memory, the cache reopened from the database. */
async function reload(): Promise<void> {
  useReviewStore.getState().reset();
  await disposeReviewEngine();
  configureReviewCache(factory);
  await warmReviewCache();
  installFakeEngine();
}

/** Waits until the review of the current game is stored (writes are fire-and-forget). */
async function stored(preset: 'fast' | 'deep'): Promise<void> {
  await vi.waitFor(async () => expect((await getStoredReview(key()))?.preset).toBe(preset));
}

function statuses(): { list: ReviewStatus[]; stop(): void } {
  const list: ReviewStatus[] = [];
  const stop = useReviewStore.subscribe((s) => list.push(s.status));
  return { list, stop };
}

beforeEach(async () => {
  factory = new IDBFactory();
  configureReviewCache(factory);
  await warmReviewCache();
  installFakeEngine();
  useReviewStore.getState().reset();
  useGameStore.getState().loadPgn(SCHOLAR);
  useAnalysisStore.getState().setEnabled(false);
});

afterEach(async () => {
  useReviewStore.getState().reset();
  await disposeReviewEngine();
  configureReviewCache(undefined);
});

describe('presets and budgets', () => {
  it('presetOf recognises the presets only', () => {
    expect(presetOf(REVIEW_PRESETS.fast)).toBe('fast');
    expect(presetOf(REVIEW_PRESETS.deep)).toBe('deep');
    expect(presetOf({})).toBe('deep'); // default budget = depth 18
    expect(presetOf({ movetime: 200 })).toBeUndefined();
    expect(presetOf({ depth: 10 })).toBeUndefined();
  });

  it('satisfies: same budget, longer movetime, deeper limit or reached depth', () => {
    const r = { eval: { cp: 0 } };
    expect(satisfies('mt:300', r, { movetime: 300 })).toBe(true);
    expect(satisfies('mt:500', r, { movetime: 300 })).toBe(true);
    expect(satisfies('mt:200', r, { movetime: 300 })).toBe(false);
    expect(satisfies('d:20', r, { movetime: 300 })).toBe(false);
    expect(satisfies('d:20', r, { depth: 18 })).toBe(true);
    expect(satisfies('d:12', { ...r, depth: 12 }, { depth: 18 })).toBe(false);
    expect(satisfies('mt:300', { ...r, depth: 22 }, { depth: 18 })).toBe(true);
    expect(satisfies('mt:300', { ...r, depth: 14 }, { depth: 18 })).toBe(false);
    expect(optionsKey({})).toBe('d:18');
  });
});

describe('reviewStore: persistent review cache (ADR-016)', () => {
  it('a finished preset run is stored with summary, details, engine and options', async () => {
    const summary = await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    await stored('fast');
    const r = (await getStoredReview(key()))!;
    expect(r).toMatchObject({
      gameKey: key(),
      startFen: useGameStore.getState().startFen,
      moves: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'],
      preset: 'fast',
      options: { movetime: 300 },
      engine: { kind: 'browser' },
    });
    expect(r.summary).toEqual(summary);
    expect(Object.keys(r.moveDetails)).toHaveLength(7);
    expect(useReviewStore.getState().stored).toMatchObject({ preset: 'fast', fromCache: false });
    // The positions of the run are persisted too.
    expect((await getStoredPositions(fens())).length).toBe(8);
  });

  it('after a reload a cached game is shown at once: never running, no engine created', async () => {
    const first = await useReviewStore.getState().start({ ...REVIEW_PRESETS.deep });
    await stored('deep');
    await reload();
    useGameStore.getState().loadPgn(SCHOLAR_WITH_HEADERS); // other headers, same game
    expect(peekStoredPreset(key())).toBe('deep');

    const seen = statuses();
    const summary = await useReviewStore
      .getState()
      .start({ ...REVIEW_PRESETS.fast }, { auto: true });
    seen.stop();
    expect(created).toBe(0);
    expect(engine.analysed).toEqual([]);
    expect(seen.list).not.toContain('running');
    expect(summary).toEqual(first);
    const s = useReviewStore.getState();
    expect(s).toMatchObject({
      status: 'done',
      runsOn: { kind: 'browser' },
      stored: { preset: 'deep', fromCache: true },
      // A stored Deep review needs no "Auto review (fast)" hint.
      autoNotice: false,
      progress: { done: 8, total: 8 },
    });
    expect(s.reviewed).toBe(useGameStore.getState().moves);
    expect(Object.keys(s.moveDetails)).toHaveLength(7);
  });

  it('a stored review unknown to the index (another tab) is still found before any engine', async () => {
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    await stored('fast');
    useReviewStore.getState().reset();
    await disposeReviewEngine();
    configureReviewCache(factory); // index not loaded yet
    installFakeEngine();
    const summary = await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(summary?.moves).toHaveLength(7);
    expect(created).toBe(0);
    expect(useReviewStore.getState().stored?.fromCache).toBe(true);
  });

  it('same or weaker preset than the stored one: no-op, nothing searched', async () => {
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.deep });
    await stored('deep');
    const searched = engine.analysed.length;
    const summary = useReviewStore.getState().summary;
    // Shown already: Start with the same/weaker preset resolves with it and changes nothing.
    const seen = statuses();
    expect(await useReviewStore.getState().start({ ...REVIEW_PRESETS.deep })).toBe(summary);
    expect(await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast })).toBe(summary);
    seen.stop();
    expect(seen.list).toEqual([]);
    // After a reset (e.g. the auto review of a reloaded game) the stored review is shown again.
    useReviewStore.getState().reset();
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(engine.analysed.length).toBe(searched);
    expect(useReviewStore.getState().stored).toMatchObject({ preset: 'deep', fromCache: true });
  });

  it('Deep after Fast runs and searches only the positions the Fast run did not reach depth 18 in', async () => {
    const f = fens();
    // Fast reached depth 20+ in some positions (as on the server), only 10 in the others.
    for (const i of [0, 1, 2, 3]) engine.scripts.set(f[i]!, { score: { cp: 20 }, depth: 22 });
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    await stored('fast');
    expect(engine.analysed).toEqual(f.slice(0, 7)); // checkmate position is not searched
    await reload();
    useGameStore.getState().loadPgn(SCHOLAR);
    // The cached Fast review is shown, a Deep run still starts.
    expect(await useReviewStore.getState().loadCached()).toBe(true);
    expect(useReviewStore.getState().stored).toMatchObject({ preset: 'fast', fromCache: true });
    useReviewStore.getState().reset();
    const summary = await useReviewStore.getState().start({ ...REVIEW_PRESETS.deep });
    expect(summary?.moves).toHaveLength(7);
    expect(created).toBe(1);
    expect(engine.analysed).toEqual(f.slice(4, 7));
    expect(engine.calls.every((c) => c.depth === 18)).toBe(true);
    await stored('deep');
    expect(useReviewStore.getState().stored).toMatchObject({ preset: 'deep', fromCache: false });
  });

  it('a cancelled run is not stored, its positions are; the next run resumes from them', async () => {
    const f = fens();
    engine.hang.add(f[3]!);
    const p = useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    await expect.poll(() => useReviewStore.getState().progress.done).toBe(3);
    useReviewStore.getState().cancel();
    expect(await p).toBeUndefined();
    expect(useReviewStore.getState().status).toBe('cancelled');
    await vi.waitFor(async () => expect((await getStoredPositions(f)).length).toBe(3));
    expect(await getStoredReview(key())).toBeUndefined();
    expect(await countStoredReviews()).toBe(0);
    expect(useReviewStore.getState().stored).toBeUndefined();

    await reload();
    useGameStore.getState().loadPgn(SCHOLAR);
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(engine.analysed).toEqual(f.slice(3, 7));
  });

  it('a failed run is not stored', async () => {
    engine.fail.set(fens()[2]!, new Error('boom'));
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(useReviewStore.getState().status).toBe('error');
    expect(await countStoredReviews()).toBe(0);
  });

  it('custom budgets and games under 2 plies are not stored', async () => {
    await useReviewStore.getState().start({ movetime: 50 });
    useGameStore.getState().loadPgn('1. e4');
    useReviewStore.getState().reset();
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(useReviewStore.getState().status).toBe('done');
    await new Promise((r) => setTimeout(r, 20));
    expect(await countStoredReviews()).toBe(0);
    expect(useReviewStore.getState().stored).toBeUndefined();
  });

  it('loadCached: shows a stored review of the game on the board, never runs anything', async () => {
    expect(await useReviewStore.getState().loadCached()).toBe(false); // nothing stored
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    await stored('fast');
    // Already shown for this game: nothing to do.
    expect(await useReviewStore.getState().loadCached()).toBe(false);
    await reload();
    useGameStore.getState().loadPgn(SCHOLAR_WITH_HEADERS);
    expect(await useReviewStore.getState().loadCached()).toBe(true);
    expect(created).toBe(0);
    expect(useReviewStore.getState()).toMatchObject({
      status: 'done',
      stored: { preset: 'fast', fromCache: true },
    });
    // Another game: not stored.
    useGameStore.getState().loadPgn('1. d4 d5 2. c4');
    expect(await useReviewStore.getState().loadCached()).toBe(false);
  });

  it('clearReviewCaches empties the store and memory; the shown review no longer counts as stored', async () => {
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    await stored('fast');
    await clearReviewCaches();
    expect(await countStoredReviews()).toBe(0);
    expect(await getStoredPositions(fens())).toEqual([]);
    expect(useReviewStore.getState().stored).toBeUndefined();
    expect(useReviewStore.getState().status).toBe('done');
    // Start runs again (everything searched anew).
    engine.analysed.length = 0;
    useReviewStore.getState().reset();
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(engine.analysed).toHaveLength(7);
  });
});
