/**
 * Mistake puzzles (ADR-023 §9, stage 2): the puzzles made from the user's own reviewed games by
 * `mistakeGenerator.ts`, with their spaced-repetition schedule (`trainer/schedule.ts`).
 *
 * Stored in the store `mistakes` of the IndexedDB database `daisychess-puzzles`
 * ({@link openPuzzlesDb}), with an in-memory fallback when IndexedDB is unavailable. The store
 * holds two kinds of records, told apart by their id prefix:
 * - `m:<16 hex>` — a {@link MistakeRecord} (at most {@link MAX_MISTAKES}; when the bound is
 *   exceeded, entries that are not due are dropped before due ones, oldest `createdAt` first);
 * - `scan:<gameKey>` — a {@link ScanMarker}: the generator scanned that game's review and which
 *   candidate ids it considered (accepted, skipped or later deleted), so "Find puzzles in my
 *   games" never searches the same position twice and a deleted puzzle does not come back.
 *
 * Every public function swallows storage errors (reads return nothing, writes are dropped).
 */
import type { Puzzle } from '@daisychess/puzzles';
import type { Score } from '@daisychess/engine-core';
import { reviewEntry, type ScheduleEntry } from '../trainer/schedule';
import { openPuzzlesDb, PUZZLE_STORES } from './puzzlesDb';

export const MAX_MISTAKES = 2000;
const SCAN_PREFIX = 'scan:';

export interface MistakeRecord {
  /** `m:<16 hex of sha256(fen of the mistake)>`, equal to `puzzle.id`. */
  id: string;
  puzzle: Puzzle;
  /** Ledger / review key of the game. */
  gameKey: string;
  /** Ply of the mistake in the game (review numbering: 1 = White's first move). */
  ply: number;
  /** The move the user played (UCI). */
  playedUci: string;
  classification: 'mistake' | 'blunder';
  evalBeforeWhite: Score;
  evalAfterWhite: Score;
  createdAt: number;
  schedule: ScheduleEntry;
}

export interface ScanMarker {
  /** `scan:<gameKey>` */
  id: string;
  kind: 'scan';
  gameKey: string;
  /** `createdAt` of the review scanned last. */
  reviewCreatedAt: number;
  /** Candidate ids already handled (accepted, skipped or deleted). */
  ids: string[];
  createdAt: number;
}

type StoredRecord = MistakeRecord | ScanMarker;

const isMarker = (r: StoredRecord): r is ScanMarker => r.id.startsWith(SCAN_PREFIX);
export const scanMarkerId = (gameKey: string): string => `${SCAN_PREFIX}${gameKey}`;

/** Schedule of a puzzle that was never trained: due at once. */
export const newSchedule = (now: number): ScheduleEntry => ({
  due: now,
  interval: 0,
  lapses: 0,
  successes: 0,
});

/**
 * The records to delete so that at most `max` puzzles remain: not-due entries first, oldest
 * `createdAt` first within each group. Pure (exported for tests).
 */
export function evictionOrder(
  records: readonly MistakeRecord[],
  max: number,
  now: number,
): string[] {
  const excess = records.length - max;
  if (excess <= 0) return [];
  return [...records]
    .sort((a, b) => {
      const da = a.schedule.due <= now ? 1 : 0;
      const db = b.schedule.due <= now ? 1 : 0;
      return da - db || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
    })
    .slice(0, excess)
    .map((r) => r.id);
}

// ---------------------------------------------------------------------------------------------
// Backends

interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  get(id: string): Promise<StoredRecord | undefined>;
  all(): Promise<StoredRecord[]>;
  /** Writes `records` and deletes `deletes` in one transaction. */
  write(records: readonly StoredRecord[], deletes: readonly string[]): Promise<void>;
  /** Atomic read-modify-write of one record (undefined from `update`: leave it). */
  update(
    id: string,
    update: (prev: StoredRecord | undefined) => StoredRecord | undefined,
  ): Promise<StoredRecord | undefined>;
  clear(): Promise<void>;
}

class MemoryBackend implements Backend {
  readonly kind = 'memory';
  private readonly records = new Map<string, StoredRecord>();
  async get(id: string) {
    return this.records.get(id);
  }
  async all() {
    return [...this.records.values()];
  }
  async write(records: readonly StoredRecord[], deletes: readonly string[]) {
    for (const r of records) this.records.set(r.id, structuredClone(r));
    for (const id of deletes) this.records.delete(id);
  }
  async update(id: string, update: (prev: StoredRecord | undefined) => StoredRecord | undefined) {
    const next = update(this.records.get(id));
    if (next) this.records.set(id, structuredClone(next));
    return next;
  }
  async clear() {
    this.records.clear();
  }
}

const STORE = PUZZLE_STORES.mistakes;

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
  async get(id: string) {
    const tx = this.db.transaction(STORE, 'readonly');
    return (await request(tx.objectStore(STORE).get(id))) as StoredRecord | undefined;
  }
  async all() {
    const tx = this.db.transaction(STORE, 'readonly');
    return (await request(tx.objectStore(STORE).getAll())) as StoredRecord[];
  }
  async write(records: readonly StoredRecord[], deletes: readonly string[]) {
    const tx = this.db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    for (const r of records) os.put(r);
    for (const id of deletes) os.delete(id);
    await complete(tx);
  }
  update(id: string, update: (prev: StoredRecord | undefined) => StoredRecord | undefined) {
    return new Promise<StoredRecord | undefined>((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      let result: StoredRecord | undefined;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      const get = os.get(id);
      get.onsuccess = () => {
        try {
          result = update(get.result as StoredRecord | undefined);
        } catch (err) {
          tx.abort();
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        if (result) os.put(result);
      };
    });
  }
  async clear() {
    const tx = this.db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await complete(tx);
  }
}

// ---------------------------------------------------------------------------------------------
// Module state

/** `undefined`: `globalThis.indexedDB` at first use; `null`: memory only. */
let factoryOverride: IDBFactory | null | undefined;
let dbVersion: number | undefined;
let backendPromise: Promise<Backend> | null = null;
const limits = { mistakes: MAX_MISTAKES };
const listeners = new Set<() => void>();
/** Serialises writes that read the whole store first (bound enforcement). */
let writeChain: Promise<unknown> = Promise.resolve();

async function init(): Promise<Backend> {
  const factory =
    factoryOverride === undefined
      ? (globalThis as { indexedDB?: IDBFactory }).indexedDB
      : factoryOverride;
  if (factory) {
    try {
      return new IdbBackend(await openPuzzlesDb(factory, dbVersion));
    } catch (err) {
      console.warn('Mistake puzzles: IndexedDB unavailable, keeping them in memory', err);
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
      console.warn('Mistake puzzles: listener failed', err);
    }
  }
};

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => undefined);
  return run;
}

/**
 * Selects the storage (tests): an `IDBFactory` (e.g. fake-indexeddb), `null` for memory only or
 * `undefined` for `globalThis.indexedDB`; `version` overrides the database version, `max` the
 * bound. Forgets the current backend (data stays in the database).
 */
export function configureMistakeStore(
  factory: IDBFactory | null | undefined,
  opts: { version?: number; max?: number } = {},
): void {
  factoryOverride = factory;
  dbVersion = opts.version;
  limits.mistakes = opts.max ?? MAX_MISTAKES;
  backendPromise = null;
  writeChain = Promise.resolve();
}

export async function mistakeStoreKind(): Promise<Backend['kind']> {
  return (await backend()).kind;
}

// ---------------------------------------------------------------------------------------------
// Public API

/** Every mistake puzzle, newest first. */
export async function listMistakes(): Promise<MistakeRecord[]> {
  try {
    const all = await (await backend()).all();
    return all
      .filter((r): r is MistakeRecord => !isMarker(r))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

export async function getMistake(id: string): Promise<MistakeRecord | undefined> {
  if (id.startsWith(SCAN_PREFIX)) return undefined;
  try {
    const r = await (await backend()).get(id);
    return r && !isMarker(r) ? r : undefined;
  } catch {
    return undefined;
  }
}

/** Due puzzles (`schedule.due ≤ now`), earliest due first (ties: oldest first). */
export async function dueMistakes(now: number = Date.now()): Promise<MistakeRecord[]> {
  return (await listMistakes())
    .filter((r) => r.schedule.due <= now)
    .sort((a, b) => a.schedule.due - b.schedule.due || a.createdAt - b.createdAt);
}

/** Number of stored puzzles and of the due ones. */
export async function mistakeStats(
  now: number = Date.now(),
): Promise<{ total: number; due: number }> {
  const all = await listMistakes();
  return { total: all.length, due: all.filter((r) => r.schedule.due <= now).length };
}

/**
 * Adds puzzles (dedupe by id: an existing puzzle keeps its record and schedule) and enforces
 * {@link MAX_MISTAKES}. Resolves with the records that were new.
 */
export async function addMistakes(
  records: readonly MistakeRecord[],
  now: number = Date.now(),
): Promise<MistakeRecord[]> {
  if (records.length === 0) return [];
  try {
    const added = await serial(async () => {
      const b = await backend();
      const existing = (await b.all()).filter((r): r is MistakeRecord => !isMarker(r));
      const ids = new Set(existing.map((r) => r.id));
      const fresh: MistakeRecord[] = [];
      for (const r of records) {
        if (ids.has(r.id)) continue;
        ids.add(r.id);
        fresh.push(r);
      }
      if (fresh.length === 0) return [];
      const evict = evictionOrder([...existing, ...fresh], limits.mistakes, now);
      await b.write(fresh, evict);
      const evicted = new Set(evict);
      return fresh.filter((r) => !evicted.has(r.id));
    });
    if (added.length > 0) notify();
    return added;
  } catch (err) {
    console.warn('Mistake puzzles: could not store', err);
    return [];
  }
}

/**
 * Records a training result of a puzzle (`success` = solved without a miss), like the drill:
 * success → interval × 2.5 days, failure → due now. Resolves with the updated record.
 */
export async function recordMistakeResult(
  id: string,
  success: boolean,
  now: number = Date.now(),
  mistakes?: number,
): Promise<MistakeRecord | undefined> {
  try {
    const stored = await serial(async () =>
      (await backend()).update(id, (prev) =>
        prev && !isMarker(prev)
          ? { ...prev, schedule: reviewEntry(prev.schedule, success, now, mistakes) }
          : undefined,
      ),
    );
    if (stored) notify();
    return stored && !isMarker(stored) ? stored : undefined;
  } catch (err) {
    console.warn('Mistake puzzles: could not record the result', err);
    return undefined;
  }
}

/** Deletes a puzzle (its game's scan marker keeps the id, so a new scan does not re-add it). */
export async function deleteMistake(id: string): Promise<void> {
  if (id.startsWith(SCAN_PREFIX)) return;
  try {
    await serial(async () => (await backend()).write([], [id]));
    notify();
  } catch (err) {
    console.warn('Mistake puzzles: could not delete', err);
  }
}

/** Deletes every puzzle of a game and its scan marker (a later scan starts afresh). */
export async function deleteMistakesOfGame(gameKey: string): Promise<void> {
  try {
    await serial(async () => {
      const b = await backend();
      const ids = (await b.all()).filter((r) => r.gameKey === gameKey).map((r) => r.id);
      await b.write([], ids);
    });
    notify();
  } catch (err) {
    console.warn('Mistake puzzles: could not delete the game', err);
  }
}

/** Removes every puzzle and scan marker. */
export async function clearMistakes(): Promise<void> {
  try {
    await serial(async () => (await backend()).clear());
  } catch (err) {
    console.warn('Mistake puzzles: could not clear', err);
  }
  notify();
}

/** The scan marker of a game (generator). */
export async function getScanMarker(gameKey: string): Promise<ScanMarker | undefined> {
  try {
    const r = await (await backend()).get(scanMarkerId(gameKey));
    return r && isMarker(r) ? r : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adds candidate ids to a game's scan marker (created on first use; ids of earlier scans are
 * kept, `reviewCreatedAt` is the latest scanned review). Resolves with the stored marker.
 */
export async function markScanned(
  gameKey: string,
  reviewCreatedAt: number,
  ids: readonly string[],
  now: number = Date.now(),
): Promise<ScanMarker | undefined> {
  try {
    const stored = await serial(async () =>
      (await backend()).update(scanMarkerId(gameKey), (prev) => {
        // Ids stay across re-reviews: the cut search is independent of the review's depth, and a
        // deleted puzzle must not come back.
        const base = prev && isMarker(prev) ? prev.ids : [];
        const merged = [...new Set([...base, ...ids])];
        return {
          id: scanMarkerId(gameKey),
          kind: 'scan',
          gameKey,
          reviewCreatedAt,
          ids: merged,
          createdAt: now,
        } satisfies ScanMarker;
      }),
    );
    return stored && isMarker(stored) ? stored : undefined;
  } catch (err) {
    console.warn('Mistake puzzles: could not store the scan marker', err);
    return undefined;
  }
}

/** Drops scan markers of games that are not in `keep` (the ledger forgot them). */
export async function pruneScanMarkers(keep: ReadonlySet<string>): Promise<number> {
  try {
    return await serial(async () => {
      const b = await backend();
      const drop = (await b.all())
        .filter((r) => isMarker(r) && !keep.has(r.gameKey))
        .map((r) => r.id);
      if (drop.length > 0) await b.write([], drop);
      return drop.length;
    });
  } catch {
    return 0;
  }
}

/** Called after puzzles changed (added, result, delete, clear). Returns the unsubscribe. */
export function onMistakesChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
