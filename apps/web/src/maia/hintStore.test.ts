import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMoveDetails } from '../review/details';
import { gameToBatch } from '../review/reviewStore';
import { scholarSummary } from '../review/testFixtures';
import { useGameStore } from '../store/gameStore';
import { configureHintCache } from './hintCache';
import { setMaiaHintClientFactory } from './hintClient';
import {
  maiaHintAt,
  requestMaiaHints,
  resetMaiaHints,
  useMaiaHintStore,
  type HintRequest,
} from './hintStore';
import { coded, fakeMaiaServer, instantSleep, type FakeAnswer } from './hintTestUtils';

const PGN =
  '[White "Ann"]\n[Black "Bob"]\n[WhiteElo "1430"]\n[BlackElo "1523"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

/** A policy whose top move is the one played at ply 5 (Qh5) / ply 6 (Nf6). */
const answer = (_rating: number, fen: string): FakeAnswer =>
  fen.includes(' w ')
    ? [
        { uci: 'd1h5', p: 0.3 },
        { uci: 'g1f3', p: 0.25 },
      ]
    : [
        { uci: 'g8f6', p: 0.38 },
        { uci: 'g7g6', p: 0.3 },
      ];

function request(over: Partial<HintRequest> = {}): HintRequest {
  const g = useGameStore.getState();
  const details = buildMoveDetails(
    scholarSummary(),
    gameToBatch(g),
    Array.from({ length: 7 }, () => ({})),
  );
  return {
    startFen: g.startFen,
    moves: g.moves,
    headers: g.headers,
    details,
    enabled: true,
    fallbackRating: 1500,
    ...over,
  };
}

let idb: IDBFactory;
beforeEach(() => {
  idb = new IDBFactory();
  configureHintCache(idb);
  useGameStore.getState().loadPgn(PGN);
});
afterEach(() => {
  setMaiaHintClientFactory(null);
  resetMaiaHints();
  configureHintCache(undefined);
});

function install(
  a: (rating: number, fen: string, attempt: number) => FakeAnswer = answer,
  opts: Parameters<typeof fakeMaiaServer>[1] = {},
) {
  const server = fakeMaiaServer(a, opts);
  setMaiaHintClientFactory(server.createClient, { sleep: instantSleep(), minIntervalMs: 0 });
  resetMaiaHints();
  return server;
}

describe('Maia hint store', () => {
  it('queries only the inaccuracy/mistake/blunder plies at the mover level (PGN ratings)', async () => {
    const server = install();
    await requestMaiaHints(request());
    const s = useMaiaHintStore.getState();
    expect(s.status).toBe('done');
    // Ply 5 (3. Qh5, inaccuracy, White 1430 → 1400) and ply 6 (3... Nf6??, Black 1523 → 1500).
    expect(server.created).toEqual(['maia-1400', 'maia-1500']);
    expect(server.queries).toHaveLength(2);
    expect(Object.keys(s.hints).map(Number)).toEqual([5, 6]);
    expect(s.hints[6]).toMatchObject({
      rating: 1500,
      playedIsTop: true,
      playedP: 0.38,
      bestP: 0.3,
    });
    expect(s.hints[5]).toMatchObject({ rating: 1400, playedIsTop: true, bestP: 0.25 });
    expect(s.levels?.black).toEqual({ rating: 1500, source: 'pgn', elo: 1523 });
    expect(s.forMoves).toBe(useGameStore.getState().moves);
    expect(maiaHintAt(6)?.rating).toBe(1500);
  });

  it('publishes partial results as they arrive', async () => {
    install();
    const seen: number[][] = [];
    const unsub = useMaiaHintStore.subscribe((s) => {
      if (s.status === 'running') seen.push(Object.keys(s.hints).map(Number));
    });
    await requestMaiaHints(request());
    unsub();
    expect(seen).toContainEqual([5]);
    expect(seen.at(-1)).toEqual([5, 6]);
  });

  it('caches by game, ply and rating: memory, then IndexedDB; another rating queries again', async () => {
    const first = install();
    await requestMaiaHints(request({ headers: {} }));
    expect(first.queries).toHaveLength(2);

    // Same request again (memory) and after a reset of the memory (IndexedDB): no queries.
    const second = install();
    await requestMaiaHints(request({ headers: {} }));
    expect(second.queries).toHaveLength(0);
    expect(Object.keys(useMaiaHintStore.getState().hints)).toEqual(['5', '6']);
    expect(useMaiaHintStore.getState().status).toBe('done');

    // Another level: new queries, at that rating.
    await requestMaiaHints(request({ headers: {}, fallbackRating: 1800 }));
    expect(second.created).toEqual(['maia-1800']);
    expect(second.queries).toHaveLength(2);
    expect(useMaiaHintStore.getState().hints[6]?.rating).toBe(1800);
  });

  it('no_capacity: retried, the hints arrive', async () => {
    const server = install((r, fen, attempt) =>
      attempt === 0 ? coded('no_capacity') : answer(r, fen),
    );
    await requestMaiaHints(request());
    expect(useMaiaHintStore.getState().status).toBe('done');
    expect(server.queries).toHaveLength(4);
    expect(Object.keys(useMaiaHintStore.getState().hints)).toHaveLength(2);
  });

  it('no server configured: no queries, status unavailable', async () => {
    setMaiaHintClientFactory(null);
    resetMaiaHints();
    await requestMaiaHints(request());
    expect(useMaiaHintStore.getState().status).toBe('unavailable');
    expect(useMaiaHintStore.getState().hints).toEqual({});
  });

  it('refused token: unauthorized, and the server is not asked again right away', async () => {
    const server = install(answer, { load: () => coded('unauthorized') });
    await requestMaiaHints(request());
    expect(useMaiaHintStore.getState().status).toBe('unauthorized');
    expect(server.queries).toEqual([]);
    await requestMaiaHints(request({ fallbackRating: 1700, headers: {} }));
    expect(useMaiaHintStore.getState().status).toBe('unauthorized');
    expect(server.created).toEqual(['maia-1400']);
  });

  it('setting off: nothing is queried or shown', async () => {
    const server = install();
    await requestMaiaHints(request({ enabled: false }));
    expect(useMaiaHintStore.getState().status).toBe('off');
    expect(server.queries).toEqual([]);
    expect(maiaHintAt(6)).toBeUndefined();
  });

  it('a new game cancels the running request; hints belong to their game only', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const server = install();
    const slow = server.createClient;
    setMaiaHintClientFactory(
      async (id) => {
        await gate;
        return slow(id);
      },
      { sleep: instantSleep(), minIntervalMs: 0 },
    );
    const first = requestMaiaHints(request());
    useGameStore.getState().loadPgn('1. e4 e5 2. Nf3 Nc6');
    // The new game has no mistakes: done at once, the old run is aborted.
    await requestMaiaHints(request({ details: {} }));
    release();
    await first;
    expect(useMaiaHintStore.getState().status).toBe('done');
    expect(useMaiaHintStore.getState().hints).toEqual({});
    expect(maiaHintAt(6)).toBeUndefined();
  });
});
