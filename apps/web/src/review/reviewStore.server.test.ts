import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../engine/remoteTesting';
import { configureApiConnection } from '../server/apiConnection';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { buildMoveDetails } from './details';
import { FakeReviewEngine } from './fakeEngine';
import { FakeReviewServer } from './fakeReviewServer';
import {
  REVIEW_CACHE_VERSION,
  cachedReviewLabel,
  clearReviewCache,
  configureReviewCache,
  gameKey,
  getStoredReview,
  type StoredReview,
} from './reviewCache';
import {
  REVIEW_PRESETS,
  clearReviewCaches,
  disposeReviewEngine,
  gameToBatch,
  setReviewEngineFactory,
  useReviewStore,
  type ReviewStatus,
} from './reviewStore';
import { toWireRecord } from './serverReviewStore';
import { scholarSummary } from './testFixtures';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';
let server: FakeReviewServer;
let engine: FakeReviewEngine;

const game = () => gameToBatch(useGameStore.getState());
const key = () =>
  gameKey(
    game().startFen,
    game().moves.map((m) => m.uci),
  );
const fens = () => [game().startFen, ...game().moves.map((m) => m.fenAfter)];

function review(preset: 'fast' | 'deep'): StoredReview {
  const g = game();
  const summary = scholarSummary();
  return {
    gameKey: key(),
    startFen: g.startFen,
    moves: g.moves.map((m) => m.san),
    preset,
    options: preset === 'fast' ? { movetime: 300 } : { depth: 18 },
    summary,
    moveDetails: buildMoveDetails(summary, g, []),
    engine: { kind: 'server', name: 'Stockfish 19', threads: 8 },
    createdAt: new Date(new Date().getFullYear(), 9, 25, 10).getTime(),
    version: REVIEW_CACHE_VERSION,
  };
}

function seed(r: StoredReview): void {
  server.put({
    gameKey: r.gameKey,
    startFen: r.startFen,
    moves: r.moves,
    preset: r.preset,
    record: toWireRecord(r),
    createdAt: r.createdAt,
  });
}

function statuses(): { list: ReviewStatus[]; stop(): void } {
  const list: ReviewStatus[] = [];
  const stop = useReviewStore.subscribe((s) => list.push(s.status));
  return { list, stop };
}

beforeEach(async () => {
  server = new FakeReviewServer();
  configureApiConnection({ createSocket: server.createSocket });
  configureReviewCache(null);
  await clearReviewCache();
  engine = new FakeReviewEngine();
  setReviewEngineFactory(() => engine);
  useReviewStore.getState().reset();
  useGameStore.getState().loadPgn(SCHOLAR);
  useAnalysisStore.getState().setEnabled(false);
  useSettingsStore.getState().setServerToken('');
  useSettingsStore.getState().set({ reviewEngine: 'auto' });
});

afterEach(async () => {
  useReviewStore.getState().reset();
  await disposeReviewEngine();
  configureApiConnection(null);
  useSettingsStore.getState().setServerToken('');
  configureReviewCache(undefined);
});

describe('reviewStore: server review store (ADR-017)', () => {
  it('shows a review stored on the server without running, and caches it locally', async () => {
    seed(review('fast'));
    const { list, stop } = statuses();
    const summary = await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    stop();
    expect(summary).toEqual(scholarSummary());
    expect(list).not.toContain('running');
    const s = useReviewStore.getState();
    expect(s.status).toBe('done');
    expect(s.stored).toMatchObject({ preset: 'fast', fromCache: true, source: 'server' });
    expect(s.runsOn).toEqual({ kind: 'server', name: 'Stockfish 19', threads: 8 });
    expect(Object.keys(s.moveDetails)).toHaveLength(7);
    expect(cachedReviewLabel(s.stored!)).toBe('Loaded from server (reviewed 25 Oct, fast)');
    expect(engine.analysed).toEqual([]);
    // Now in the local cache: the next load is local.
    await vi.waitFor(async () => expect((await getStoredReview(key()))?.preset).toBe('fast'));
    expect(server.of('review.get')).toHaveLength(1);
  });

  it('a weaker server record is cached locally but the stronger run still happens', async () => {
    seed(review('fast'));
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.deep });
    const s = useReviewStore.getState();
    expect(s.status).toBe('done');
    expect(s.stored).toMatchObject({ preset: 'deep', fromCache: false, source: 'local' });
    expect(engine.analysed.length).toBeGreaterThan(0);
    await vi.waitFor(async () => expect((await getStoredReview(key()))?.preset).toBe('deep'));
  });

  it('writes a finished run to the server only when the token was accepted', async () => {
    server.token = 'secret';
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(useReviewStore.getState().status).toBe('done');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(server.reviews.size).toBe(0);
    expect(server.of('review.put')).toHaveLength(0);
    expect(server.of('review.positions.put')).toHaveLength(0);

    useSettingsStore.getState().setServerToken('secret');
    await clearReviewCaches(); // also the positions kept in memory
    useReviewStore.getState().reset();
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    await vi.waitFor(() => expect(server.reviews.get(key())).toBeDefined());
    expect(server.reviews.get(key())).toMatchObject({
      preset: 'fast',
      moves: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'],
    });
    expect(server.reviews.get(key())!.record.engine).toEqual({ kind: 'browser' });
    // The run's positions were offered too (one chunk, all eight positions).
    await vi.waitFor(() => expect(server.of('review.positions.put')).toHaveLength(1));
    expect(server.of('review.positions.put')[0]).toMatchObject({ optsKey: 'mt:300' });
    expect(server.positions.size).toBe(8);
  });

  it('fetches missing positions from the server before searching and merges them', async () => {
    const all = fens();
    // Everything but the start position is known to the server at the Fast budget.
    for (const fen of all.slice(1)) server.putPosition('mt:300', fen, { eval: { cp: 7 }, depth: 21 });
    // The fake engine's search of the start position reaches depth 22 (reusable by Deep).
    engine.scripts.set(all[0]!, { score: { cp: 20 }, depth: 22 });
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(useReviewStore.getState().status).toBe('done');
    expect(engine.analysed).toEqual([all[0]]);
    const gets = server.of('review.positions.get');
    expect(gets).toHaveLength(1);
    expect(gets[0]).toMatchObject({ optsKey: 'mt:300' });
    expect(gets[0]!.fens).toHaveLength(8);

    // Deep after Fast on another device (nothing in memory): the Fast results on the server
    // reached depth 21/22 ≥ 18, so a Deep run asks for both keys and searches nothing.
    expect(server.positions.size).toBe(8); // the start position was offered after the run
    engine.analysed.length = 0;
    await clearReviewCaches();
    useReviewStore.getState().reset();
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.deep });
    expect(useReviewStore.getState().status).toBe('done');
    expect(engine.analysed).toEqual([]);
    const deepGets = server.of('review.positions.get').slice(1);
    expect(deepGets.map((g) => g.optsKey)).toEqual(['d:18', 'mt:300']);
  });

  it('runs exactly as before when the server is down or has no store', async () => {
    configureApiConnection({
      createSocket: (url) => new FakeWebSocket(url, false),
      handshakeTimeoutMs: 20,
    });
    const { list, stop } = statuses();
    const summary = await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    stop();
    expect(summary).toBeDefined();
    expect(list).toContain('running');
    expect(useReviewStore.getState().stored).toMatchObject({ fromCache: false, source: 'local' });
    expect(engine.analysed.length).toBe(7); // all but the checkmate

    engine.analysed.length = 0;
    server.capabilities = { analysis: true, rooms: true };
    configureApiConnection({ createSocket: server.createSocket });
    await clearReviewCaches();
    useReviewStore.getState().reset();
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(useReviewStore.getState().status).toBe('done');
    expect(engine.analysed.length).toBe(7);
    expect(server.requests).toEqual([]);
  });

  it('never touches the server when the review engine is set to browser', async () => {
    useSettingsStore.getState().set({ reviewEngine: 'browser' });
    seed(review('deep'));
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(useReviewStore.getState().stored).toMatchObject({ fromCache: false });
    expect(server.sockets).toHaveLength(0);
  });

  it('loadCached shows a server review when the moves change', async () => {
    seed(review('deep'));
    useGameStore.getState().loadPgn(SCHOLAR);
    expect(await useReviewStore.getState().loadCached()).toBe(true);
    const s = useReviewStore.getState();
    expect(s.status).toBe('done');
    expect(s.stored).toMatchObject({ preset: 'deep', fromCache: true, source: 'server' });
    expect(s.reviewed).toBe(useGameStore.getState().moves);
  });
});
