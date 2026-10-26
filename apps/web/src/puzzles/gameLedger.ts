/**
 * Game ledger (ADR-023 §9): the reviewed games the puzzles from the user's own mistakes are made
 * from. The review cache (ADR-016) deliberately keeps no headers or names, so the ledger records,
 * per reviewed game, what is needed to find the user's mistakes and to show/open the game later:
 * start FEN, SAN moves, a few headers, where the game came from and the user's side.
 *
 * Stored in the store `games` of the IndexedDB database `daisychess-puzzles` ({@link openPuzzlesDb}),
 * at most {@link MAX_LEDGER_GAMES} entries (oldest `reviewedAt` dropped), with an in-memory
 * fallback when IndexedDB is unavailable. Every public function swallows storage errors (reads
 * return nothing, writes are dropped): the ledger must never break a review.
 */
import { openPuzzlesDb, PUZZLE_STORES } from './puzzlesDb';
import { sideFromNames, type GameSource, type Side } from './userSide';

export const MAX_LEDGER_GAMES = 500;

/** The headers kept per game (names, date and a link for the "Your mistakes" list). */
export interface LedgerHeaders {
  White?: string;
  Black?: string;
  Site?: string;
  Date?: string;
  Result?: string;
  /** The game's page (`Link` or an http(s) `Site`). */
  url?: string;
}

export interface LedgerGame {
  /** Review cache key (`reviewGameKey(startFen, uciMoves)`), also the key of the review. */
  gameKey: string;
  startFen: string;
  /** SAN moves. */
  moves: string[];
  headers: LedgerHeaders;
  source: GameSource;
  /** The user's side; undefined while unknown. */
  userSide?: Side;
  /** The user answered "skip" to the side prompt: never asked again, no puzzles from it. */
  sideSkipped?: boolean;
  /** Last time a finished review of the game was shown (epoch ms). */
  reviewedAt: number;
}

/** What {@link recordReviewedGame} takes (the rest is kept or derived). */
export type LedgerGameInput = Omit<LedgerGame, 'sideSkipped'>;

/** True when "Your mistakes" should ask the user which side they played. */
export const needsSidePrompt = (g: Pick<LedgerGame, 'userSide' | 'sideSkipped'>): boolean =>
  g.userSide === undefined && !g.sideSkipped;

/**
 * The record after a (re-)review: the new data, but a side the user picked (or skipped) before
 * stays unless the new review knows it for certain from its game source.
 */
export function mergeLedgerGame(prev: LedgerGame | undefined, next: LedgerGameInput): LedgerGame {
  if (!prev) return { ...next };
  const certain = next.source === 'play' || next.source === 'room' || next.source === 'live';
  const merged: LedgerGame = { ...prev, ...next, source: certain ? next.source : prev.source };
  if (certain && next.userSide) {
    delete merged.sideSkipped;
    return merged;
  }
  // Keep the earlier answer (an explicit pick or skip beats a name match of the new review).
  if (prev.userSide) merged.userSide = prev.userSide;
  else if (prev.sideSkipped) {
    delete merged.userSide;
    merged.sideSkipped = true;
  } else if (!next.userSide) delete merged.userSide;
  return merged;
}

/** Keeps only the {@link LedgerHeaders} of a PGN header map (trimmed, empty values dropped). */
export function ledgerHeaders(
  headers: Readonly<Record<string, string>>,
  url: string | undefined,
): LedgerHeaders {
  const out: LedgerHeaders = {};
  for (const k of ['White', 'Black', 'Site', 'Date', 'Result'] as const) {
    const v = headers[k]?.trim();
    if (v) out[k] = v.slice(0, 200);
  }
  if (url) out.url = url.slice(0, 500);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Backends

interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  get(key: string): Promise<LedgerGame | undefined>;
  /** Atomically replaces the record of `key` by `update(prev)` (undefined: leave it). */
  update(
    key: string,
    update: (prev: LedgerGame | undefined) => LedgerGame | undefined,
  ): Promise<LedgerGame | undefined>;
  list(): Promise<LedgerGame[]>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

const limits = { games: MAX_LEDGER_GAMES };

class MemoryBackend implements Backend {
  readonly kind = 'memory';
  private readonly games = new Map<string, LedgerGame>();

  async get(key: string) {
    return this.games.get(key);
  }
  async update(key: string, update: (prev: LedgerGame | undefined) => LedgerGame | undefined) {
    const next = update(this.games.get(key));
    if (!next) return undefined;
    this.games.set(key, next);
    if (this.games.size > limits.games) {
      const oldest = [...this.games.values()].sort((a, b) => a.reviewedAt - b.reviewedAt);
      for (const o of oldest.slice(0, this.games.size - limits.games)) this.games.delete(o.gameKey);
    }
    return next;
  }
  async list() {
    return [...this.games.values()];
  }
  async delete(key: string) {
    this.games.delete(key);
  }
  async clear() {
    this.games.clear();
  }
}

const GAMES = PUZZLE_STORES.games;

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

class IdbBackend implements Backend {
  readonly kind = 'indexeddb';
  constructor(private readonly db: IDBDatabase) {}

  async get(key: string) {
    const tx = this.db.transaction(GAMES, 'readonly');
    return (await request(tx.objectStore(GAMES).get(key))) as LedgerGame | undefined;
  }

  /**
   * Read, merge, write and trim in one readwrite transaction (callbacks only, so the
   * transaction never auto-commits between the steps): concurrent writes cannot lose updates.
   */
  update(key: string, update: (prev: LedgerGame | undefined) => LedgerGame | undefined) {
    return new Promise<LedgerGame | undefined>((resolve, reject) => {
      const tx = this.db.transaction(GAMES, 'readwrite');
      const os = tx.objectStore(GAMES);
      let result: LedgerGame | undefined;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      const get = os.get(key);
      get.onsuccess = () => {
        let next: LedgerGame | undefined;
        try {
          next = update(get.result as LedgerGame | undefined);
        } catch (err) {
          tx.abort();
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (!next) return;
        result = next;
        os.put(next);
        const count = os.count();
        count.onsuccess = () => {
          let excess = count.result - limits.games;
          if (excess <= 0) return;
          const cursor = os.index('reviewedAt').openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c || excess <= 0) return;
            c.delete();
            excess--;
            c.continue();
          };
        };
      };
    });
  }

  async list() {
    const tx = this.db.transaction(GAMES, 'readonly');
    return (await request(tx.objectStore(GAMES).getAll())) as LedgerGame[];
  }
  async delete(key: string) {
    const tx = this.db.transaction(GAMES, 'readwrite');
    tx.objectStore(GAMES).delete(key);
    await complete(tx);
  }
  async clear() {
    const tx = this.db.transaction(GAMES, 'readwrite');
    tx.objectStore(GAMES).clear();
    await complete(tx);
  }
}

// ---------------------------------------------------------------------------------------------
// Module state and public API

/** `undefined`: `globalThis.indexedDB` at first use; `null`: memory only. */
let factoryOverride: IDBFactory | null | undefined;
let dbVersion: number | undefined;
let backendPromise: Promise<Backend> | null = null;
const listeners = new Set<() => void>();

async function init(): Promise<Backend> {
  const factory =
    factoryOverride === undefined
      ? (globalThis as { indexedDB?: IDBFactory }).indexedDB
      : factoryOverride;
  if (factory) {
    try {
      return new IdbBackend(await openPuzzlesDb(factory, dbVersion));
    } catch (err) {
      console.warn('Game ledger: IndexedDB unavailable, keeping games in memory', err);
    }
  }
  return new MemoryBackend();
}

const backend = (): Promise<Backend> => (backendPromise ??= init());

const notify = (): void => {
  for (const l of listeners) {
    try {
      l();
    } catch (err) {
      console.warn('Game ledger: listener failed', err);
    }
  }
};

/**
 * Selects the storage (tests): an `IDBFactory` (e.g. fake-indexeddb), `null` for memory only or
 * `undefined` for `globalThis.indexedDB`; `version` overrides the database version, `maxGames`
 * the bound. Forgets the current backend (data stays in the database).
 */
export function configureGameLedger(
  factory: IDBFactory | null | undefined,
  opts: { version?: number; maxGames?: number } = {},
): void {
  factoryOverride = factory;
  dbVersion = opts.version;
  limits.games = opts.maxGames ?? MAX_LEDGER_GAMES;
  backendPromise = null;
}

/** Which storage is in use. */
export async function gameLedgerKind(): Promise<Backend['kind']> {
  return (await backend()).kind;
}

/**
 * Records a game whose review was just finished or loaded (upsert by `gameKey`, see
 * {@link mergeLedgerGame}); drops the oldest games beyond {@link MAX_LEDGER_GAMES}. Resolves with
 * the stored record, or undefined when storing failed.
 */
export async function recordReviewedGame(game: LedgerGameInput): Promise<LedgerGame | undefined> {
  try {
    const stored = await (
      await backend()
    ).update(game.gameKey, (prev) => mergeLedgerGame(prev, game));
    notify();
    return stored;
  } catch (err) {
    console.warn('Game ledger: could not record the game', err);
    return undefined;
  }
}

export async function getLedgerGame(gameKey: string): Promise<LedgerGame | undefined> {
  try {
    return await (await backend()).get(gameKey);
  } catch {
    return undefined;
  }
}

/** All ledger games, most recently reviewed first. */
export async function listGames(): Promise<LedgerGame[]> {
  try {
    const all = await (await backend()).list();
    return all.sort((a, b) => b.reviewedAt - a.reviewedAt);
  } catch {
    return [];
  }
}

/**
 * The answer of the ask-once side prompt: the user's side, or `'skip'` (not my game; never asked
 * again). Resolves with the updated record (undefined when the game is not in the ledger).
 */
export async function setUserSide(
  gameKey: string,
  side: Side | 'skip',
): Promise<LedgerGame | undefined> {
  try {
    const stored = await (
      await backend()
    ).update(gameKey, (prev) => {
      if (!prev) return undefined;
      const next: LedgerGame = { ...prev };
      if (side === 'skip') {
        delete next.userSide;
        next.sideSkipped = true;
      } else {
        next.userSide = side;
        delete next.sideSkipped;
      }
      return next;
    });
    if (stored) notify();
    return stored;
  } catch (err) {
    console.warn('Game ledger: could not store the side', err);
    return undefined;
  }
}

/**
 * Re-runs the name match for ledger games whose side is still unknown (not skipped), e.g. after
 * the "My names" list changed. Resolves with the number of games that got a side.
 */
export async function refreshUserSides(names: readonly string[]): Promise<number> {
  if (names.length === 0) return 0;
  let changed = 0;
  try {
    const b = await backend();
    for (const g of await b.list()) {
      if (!needsSidePrompt(g) || !sideFromNames(g.headers, names)) continue;
      const stored = await b.update(g.gameKey, (prev) => {
        if (!prev || !needsSidePrompt(prev)) return undefined;
        const side = sideFromNames(prev.headers, names);
        return side ? { ...prev, userSide: side } : undefined;
      });
      if (stored) changed++;
    }
  } catch (err) {
    console.warn('Game ledger: could not update the sides', err);
  }
  if (changed > 0) notify();
  return changed;
}

export async function deleteLedgerGame(gameKey: string): Promise<void> {
  try {
    await (await backend()).delete(gameKey);
    notify();
  } catch (err) {
    console.warn('Game ledger: could not delete the game', err);
  }
}

/** Removes every ledger game. */
export async function clearGameLedger(): Promise<void> {
  try {
    await (await backend()).clear();
  } catch (err) {
    console.warn('Game ledger: could not clear', err);
  }
  notify();
}

/** Called after the ledger changed (record, side, delete, clear). Returns the unsubscribe. */
export function onLedgerChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
