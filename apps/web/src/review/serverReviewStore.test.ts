import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureApiConnection } from '../server/apiConnection';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { buildMoveDetails } from './details';
import { FakeReviewServer } from './fakeReviewServer';
import { REVIEW_CACHE_VERSION, gameKey, type StoredReview } from './reviewCache';
import { gameToBatch } from './reviewStore';
import {
  POSITIONS_CHUNK,
  fetchServerPositions,
  fetchServerReview,
  fetchServerReviewStats,
  fromWireDetails,
  serverStoreAvailable,
  storeServerPositions,
  storeServerReview,
  toWireDetails,
  toWireRecord,
} from './serverReviewStore';
import { scholarSummary } from './testFixtures';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';
let server: FakeReviewServer;

function game() {
  return gameToBatch(useGameStore.getState());
}

function review(preset: 'fast' | 'deep' = 'fast'): StoredReview {
  const g = game();
  const summary = scholarSummary();
  return {
    gameKey: gameKey(
      g.startFen,
      g.moves.map((m) => m.uci),
    ),
    startFen: g.startFen,
    moves: g.moves.map((m) => m.san),
    preset,
    options: preset === 'fast' ? { movetime: 300 } : { depth: 18 },
    summary,
    moveDetails: buildMoveDetails(summary, g, []),
    engine: { kind: 'server', name: 'Stockfish 19', threads: 8 },
    createdAt: 1_761_000_000_000,
    version: REVIEW_CACHE_VERSION,
  };
}

/** Puts `r` into the fake server as another device would have. */
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

beforeEach(() => {
  server = new FakeReviewServer();
  configureApiConnection({ createSocket: server.createSocket });
  useGameStore.getState().loadPgn(SCHOLAR);
  useSettingsStore.getState().setServerToken('');
  useSettingsStore.getState().set({ reviewEngine: 'auto' });
});

afterEach(() => {
  configureApiConnection(null);
  useSettingsStore.getState().setServerToken('');
});

describe('serverReviewStore', () => {
  it('converts move details between the web (by ply) and the wire (by string key)', () => {
    const r = review();
    const wire = toWireDetails(r.moveDetails);
    expect(Object.keys(wire)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(fromWireDetails(wire)).toEqual(r.moveDetails);
    expect(toWireRecord(r)).toEqual({
      version: r.version,
      options: r.options,
      engine: r.engine,
      summary: r.summary,
      moveDetails: wire,
    });
  });

  it('is unavailable with the api disabled or the review engine set to browser', () => {
    expect(serverStoreAvailable()).toBe(true);
    useSettingsStore.getState().set({ reviewEngine: 'browser' });
    expect(serverStoreAvailable()).toBe(false);
    useSettingsStore.getState().set({ reviewEngine: 'auto' });
    configureApiConnection(null);
    expect(serverStoreAvailable()).toBe(false);
  });

  it('fetches a stored review and maps it to the web record', async () => {
    const r = review('deep');
    seed(r);
    const got = await fetchServerReview(game(), r.gameKey);
    expect(got).toEqual(r);
    expect(server.of('review.get')).toHaveLength(1);
    expect(server.of('review.get')[0]).toMatchObject({ gameKey: r.gameKey, moves: r.moves });
  });

  it('returns nothing for a miss, another cache version, a different game or a down server', async () => {
    const r = review();
    expect(await fetchServerReview(game(), r.gameKey)).toBeUndefined();
    seed({ ...r, version: REVIEW_CACHE_VERSION + 1 });
    expect(await fetchServerReview(game(), r.gameKey)).toBeUndefined();
    seed({ ...r, moves: [...r.moves.slice(0, -1), 'Qxf7'] });
    expect(await fetchServerReview(game(), r.gameKey)).toBeUndefined();
    seed(r);
    expect(await fetchServerReview(game(), r.gameKey)).toEqual(r);
    server.mute = true;
    configureApiConnection({ createSocket: server.createSocket, requestTimeoutMs: 20 });
    expect(await fetchServerReview(game(), r.gameKey)).toBeUndefined();
  });

  it('stores a review only when the server accepted the token', async () => {
    const r = review();
    server.token = 'secret';
    expect(await storeServerReview(r)).toBe(false);
    expect(server.of('review.put')).toHaveLength(0);
    expect(server.reviews.size).toBe(0);

    useSettingsStore.getState().setServerToken('secret');
    expect(await storeServerReview(r)).toBe(true);
    expect(server.reviews.get(r.gameKey)).toMatchObject({ preset: 'fast', moves: r.moves });
    expect(server.of('review.put')[0]!.record).toEqual(toWireRecord(r));
  });

  it('fetches positions per budget key in chunks of 64, one after the other', async () => {
    const fens = Array.from({ length: 150 }, (_, i) => `8/8/8/8/8/8/8/K6k w - - 0 ${i + 1}`);
    for (let i = 0; i < 150; i += 2) {
      server.putPosition('mt:300', fens[i]!, { eval: { cp: i }, depth: 20 });
    }
    server.putPosition('d:18', fens[1]!, { eval: { cp: -1 }, depth: 18 });
    const got = await fetchServerPositions(['d:18', 'mt:300'], [...fens, fens[0]!]);
    const gets = server.of('review.positions.get');
    expect(gets.map((g) => [g.optsKey, g.fens.length])).toEqual([
      ['d:18', 64],
      ['d:18', 64],
      ['d:18', 22],
      ['mt:300', 64],
      ['mt:300', 64],
      ['mt:300', 22],
    ]);
    expect(gets.every((g) => g.fens.length <= POSITIONS_CHUNK)).toBe(true);
    expect(got.filter((p) => p.optionsKey === 'mt:300')).toHaveLength(75);
    expect(got.find((p) => p.optionsKey === 'd:18')).toEqual({
      fen: fens[1],
      optionsKey: 'd:18',
      result: { eval: { cp: -1 }, depth: 18 },
    });
  });

  it('stores positions in chunks, only with write access', async () => {
    const fens = Array.from({ length: 70 }, (_, i) => `8/8/8/8/8/8/8/K6k w - - 0 ${i + 1}`);
    const entries = fens.map((fen, i) => ({ fen, result: { eval: { cp: i } } }));
    server.token = 'secret';
    // Not connected yet: nothing is known about write access, nothing is sent.
    await storeServerPositions('mt:300', entries);
    expect(server.of('review.positions.put')).toHaveLength(0);
    useSettingsStore.getState().setServerToken('secret');
    await fetchServerReviewStats(); // handshake → write access known
    await storeServerPositions('mt:300', entries);
    expect(server.of('review.positions.put').map((p) => p.entries.length)).toEqual([64, 6]);
    expect(server.positions.size).toBe(70);
  });

  it('reports the server statistics', async () => {
    server.bytes = 1_234_000_000;
    expect(await fetchServerReviewStats()).toEqual({
      enabled: true,
      reviews: 0,
      positions: 0,
      bytes: 1_234_000_000,
      maxBytes: 5e9,
    });
    configureApiConnection(null);
    expect(await fetchServerReviewStats()).toBeUndefined();
  });
});
