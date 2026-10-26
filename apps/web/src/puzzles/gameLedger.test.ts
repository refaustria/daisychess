import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearGameLedger,
  configureGameLedger,
  deleteLedgerGame,
  gameLedgerKind,
  getLedgerGame,
  ledgerHeaders,
  listGames,
  MAX_LEDGER_GAMES,
  mergeLedgerGame,
  needsSidePrompt,
  onLedgerChange,
  recordReviewedGame,
  refreshUserSides,
  setUserSide,
  type LedgerGame,
  type LedgerGameInput,
} from './gameLedger';
import { openPuzzlesDb, PUZZLE_STORES, PUZZLES_DB_NAME, PUZZLES_DB_VERSION } from './puzzlesDb';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function game(key: string, over: Partial<LedgerGameInput> = {}): LedgerGameInput {
  return {
    gameKey: key,
    startFen: START,
    moves: ['e4', 'e5'],
    headers: { White: 'Alice', Black: 'Bob' },
    source: 'pgn',
    reviewedAt: 1000,
    ...over,
  };
}

let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  configureGameLedger(factory);
});

afterEach(() => {
  configureGameLedger(undefined);
  vi.restoreAllMocks();
});

describe('puzzlesDb', () => {
  it('creates all four stores of the shared database in one upgrade', async () => {
    const db = await openPuzzlesDb(factory);
    expect(db.name).toBe(PUZZLES_DB_NAME);
    expect(db.version).toBe(PUZZLES_DB_VERSION);
    expect(Array.from(db.objectStoreNames).sort()).toEqual(Object.values(PUZZLE_STORES).sort());
    const tx = db.transaction([PUZZLE_STORES.games, PUZZLE_STORES.mistakes, PUZZLE_STORES.shards]);
    expect(tx.objectStore(PUZZLE_STORES.games).keyPath).toBe('gameKey');
    expect(Array.from(tx.objectStore(PUZZLE_STORES.mistakes).indexNames).sort()).toEqual([
      'createdAt',
      'gameKey',
    ]);
    expect(tx.objectStore(PUZZLE_STORES.shards).keyPath).toBe('file');
    db.close();
  });

  it('a version bump recreates the stores (data dropped)', async () => {
    await recordReviewedGame(game('a'));
    configureGameLedger(factory, { version: PUZZLES_DB_VERSION + 1 });
    expect(await listGames()).toEqual([]);
  });
});

describe('game ledger', () => {
  it('records and lists games, newest first', async () => {
    await recordReviewedGame(game('a', { reviewedAt: 1 }));
    await recordReviewedGame(game('b', { reviewedAt: 3, userSide: 'black', source: 'play' }));
    await recordReviewedGame(game('c', { reviewedAt: 2 }));
    expect(await gameLedgerKind()).toBe('indexeddb');
    expect((await listGames()).map((g) => g.gameKey)).toEqual(['b', 'c', 'a']);
    expect(await getLedgerGame('b')).toMatchObject({ userSide: 'black', source: 'play' });
    expect(await getLedgerGame('zzz')).toBeUndefined();
  });

  it('survives a reopen of the database', async () => {
    await recordReviewedGame(game('a'));
    configureGameLedger(factory);
    expect((await listGames()).map((g) => g.gameKey)).toEqual(['a']);
  });

  it('a re-review updates the record but keeps a side the user picked', async () => {
    await recordReviewedGame(game('a', { reviewedAt: 1 }));
    await setUserSide('a', 'black');
    // The name match of the new review says white: the explicit pick wins.
    await recordReviewedGame(game('a', { reviewedAt: 5, userSide: 'white' }));
    expect(await getLedgerGame('a')).toMatchObject({ userSide: 'black', reviewedAt: 5 });
  });

  it('drops the oldest games beyond the bound', async () => {
    configureGameLedger(factory, { maxGames: 3 });
    for (const [i, k] of ['a', 'b', 'c', 'd', 'e'].entries())
      await recordReviewedGame(game(k, { reviewedAt: [5, 1, 4, 2, 3][i]! }));
    expect((await listGames()).map((g) => g.gameKey)).toEqual(['a', 'c', 'e']);
    expect(MAX_LEDGER_GAMES).toBe(500);
  });

  it('records the ask-once answer, including skip', async () => {
    await recordReviewedGame(game('a'));
    expect(needsSidePrompt((await getLedgerGame('a'))!)).toBe(true);
    expect(await setUserSide('a', 'skip')).toMatchObject({ sideSkipped: true });
    expect(needsSidePrompt((await getLedgerGame('a'))!)).toBe(false);
    // A later review without a side does not ask again.
    await recordReviewedGame(game('a', { reviewedAt: 9 }));
    expect(needsSidePrompt((await getLedgerGame('a'))!)).toBe(false);
    const picked = await setUserSide('a', 'white');
    expect(picked).toMatchObject({ userSide: 'white' });
    expect(picked).not.toHaveProperty('sideSkipped');
    expect(await setUserSide('missing', 'white')).toBeUndefined();
  });

  it('concurrent writes to one game lose no update', async () => {
    await recordReviewedGame(game('a', { reviewedAt: 1 }));
    await Promise.all([
      recordReviewedGame(game('a', { reviewedAt: 2 })),
      setUserSide('a', 'black'),
      recordReviewedGame(game('a', { reviewedAt: 3 })),
    ]);
    expect(await getLedgerGame('a')).toMatchObject({ userSide: 'black', reviewedAt: 3 });
  });

  it('refreshUserSides matches unresolved games against new names', async () => {
    await recordReviewedGame(game('a', { headers: { White: 'Me', Black: 'x' } }));
    await recordReviewedGame(game('b', { headers: { White: 'y', Black: 'ME' } }));
    await recordReviewedGame(game('c', { headers: { White: 'me', Black: 'z' } }));
    await setUserSide('c', 'skip');
    await recordReviewedGame(
      game('d', { headers: { White: 'me', Black: 'q' }, userSide: 'black' }),
    );
    expect(await refreshUserSides(['me'])).toBe(2);
    expect((await getLedgerGame('a'))?.userSide).toBe('white');
    expect((await getLedgerGame('b'))?.userSide).toBe('black');
    expect((await getLedgerGame('c'))?.userSide).toBeUndefined();
    expect((await getLedgerGame('d'))?.userSide).toBe('black');
    expect(await refreshUserSides([])).toBe(0);
  });

  it('deletes and clears, notifying listeners', async () => {
    const listener = vi.fn();
    const off = onLedgerChange(listener);
    await recordReviewedGame(game('a'));
    await recordReviewedGame(game('b'));
    await deleteLedgerGame('a');
    expect((await listGames()).map((g) => g.gameKey)).toEqual(['b']);
    await clearGameLedger();
    expect(await listGames()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(4);
    off();
    await recordReviewedGame(game('c'));
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('falls back to memory when IndexedDB cannot be opened', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const broken = {
      open: () => {
        throw new Error('SecurityError');
      },
    } as unknown as IDBFactory;
    configureGameLedger(broken, { maxGames: 2 });
    expect(await gameLedgerKind()).toBe('memory');
    await recordReviewedGame(game('a', { reviewedAt: 1 }));
    await recordReviewedGame(game('b', { reviewedAt: 2 }));
    await recordReviewedGame(game('c', { reviewedAt: 3 }));
    await setUserSide('c', 'white');
    expect((await listGames()).map((g) => [g.gameKey, g.userSide])).toEqual([
      ['c', 'white'],
      ['b', undefined],
    ]);
    configureGameLedger(null);
    expect(await gameLedgerKind()).toBe('memory');
  });

  it('swallows storage errors after opening', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await recordReviewedGame(game('a'));
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(() => {
      throw new Error('gone');
    });
    expect(await recordReviewedGame(game('b'))).toBeUndefined();
    expect(await listGames()).toEqual([]);
    expect(await getLedgerGame('a')).toBeUndefined();
    expect(await setUserSide('a', 'white')).toBeUndefined();
    expect(await refreshUserSides(['Alice'])).toBe(0);
    await expect(deleteLedgerGame('a')).resolves.toBeUndefined();
    await expect(clearGameLedger()).resolves.toBeUndefined();
  });
});

describe('mergeLedgerGame', () => {
  const prev: LedgerGame = { ...game('a', { source: 'play', userSide: 'white' }) };

  it('a certain source overrides an earlier answer, a name match does not', () => {
    const skipped: LedgerGame = { ...game('a'), sideSkipped: true };
    expect(mergeLedgerGame(skipped, game('a', { source: 'live', userSide: 'black' }))).toEqual({
      ...game('a', { source: 'live', userSide: 'black' }),
    });
    expect(mergeLedgerGame(skipped, game('a', { userSide: 'black' }))).toMatchObject({
      sideSkipped: true,
    });
    expect(mergeLedgerGame(skipped, game('a', { userSide: 'black' }))).not.toHaveProperty(
      'userSide',
    );
  });

  it('keeps the earlier source when the re-review is a plain load', () => {
    expect(mergeLedgerGame(prev, game('a', { source: 'pgn', reviewedAt: 7 }))).toMatchObject({
      source: 'play',
      userSide: 'white',
      reviewedAt: 7,
    });
  });

  it('takes a name match for a game without a side', () => {
    expect(mergeLedgerGame(game('a'), game('a', { userSide: 'black' })).userSide).toBe('black');
    expect(mergeLedgerGame(undefined, game('a'))).toEqual(game('a'));
  });
});

describe('ledgerHeaders', () => {
  it('keeps names, date, result, site and url only, trimmed', () => {
    expect(
      ledgerHeaders(
        {
          White: ' A ',
          Black: 'B',
          Event: 'x',
          Date: '2026.10.01',
          Result: '1-0',
          Site: '',
          Link: 'l',
        },
        'https://lichess.org/abc',
      ),
    ).toEqual({
      White: 'A',
      Black: 'B',
      Date: '2026.10.01',
      Result: '1-0',
      url: 'https://lichess.org/abc',
    });
  });
});
