/**
 * Server-side review store (ADR-017): finished game reviews and position results in one SQLite
 * file (`node:sqlite`, WAL), so every device gets the same review for the same game.
 *
 * - `reviews`: one row per game key (the strongest preset wins), the record gzip-compressed.
 * - `positions`: one row per (search budget, FEN).
 * - Size cap: `maxBytes` of payload (an estimate incl. a per-row overhead); above it the least
 *   recently used rows are evicted — positions first, then reviews — down to 90 %.
 *
 * Nothing personal is stored: no PGN headers, names or addresses; only moves and evaluations.
 * All methods are synchronous (SQLite in-process); callers catch errors.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  StoredReviewRecordSchema,
  coversPreset,
  type PositionResult,
  type ReviewPreset,
  type StoredReviewRecord,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';

export interface ReviewStoreConfig {
  /** SQLite file; its directory is created. */
  path: string;
  /** Payload cap in bytes (env `REVIEW_STORE_MAX_BYTES`, default 5 GB). */
  maxBytes: number;
}

export interface ReviewStoreStats {
  reviews: number;
  positions: number;
  bytes: number;
  maxBytes: number;
}

export interface StoredReviewRow {
  gameKey: string;
  preset: ReviewPreset;
  startFen: string;
  /** SAN moves. */
  moves: string[];
  record: StoredReviewRecord;
  createdAt: number;
}

export interface PutReviewInput {
  gameKey: string;
  preset: ReviewPreset;
  startFen: string;
  moves: string[];
  record: StoredReviewRecord;
}

/** Estimated per-row overhead (keys, indexes, page slack) added to the payload size. */
export const ROW_OVERHEAD_BYTES = 64;
/** Eviction target as a share of `maxBytes`. */
export const EVICTION_TARGET = 0.9;
/** `last_used` is rewritten on a hit at most this often (keeps reads cheap). */
export const TOUCH_INTERVAL_MS = 3_600_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS reviews (
  game_key   TEXT PRIMARY KEY,
  preset     TEXT NOT NULL,
  start_fen  TEXT NOT NULL,
  moves      TEXT NOT NULL,
  record     BLOB NOT NULL,
  bytes      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_lru ON reviews(last_used);
CREATE TABLE IF NOT EXISTS positions (
  opts_key  TEXT NOT NULL,
  fen       TEXT NOT NULL,
  result    BLOB NOT NULL,
  bytes     INTEGER NOT NULL,
  last_used INTEGER NOT NULL,
  PRIMARY KEY (opts_key, fen)
);
CREATE INDEX IF NOT EXISTS positions_lru ON positions(last_used);
`;

type SqliteModule = { DatabaseSync: typeof DatabaseSync };

/** `node:sqlite`, or null when this Node has none (Node < 22.13). */
export async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    const mod = (await import('node:sqlite')) as SqliteModule;
    return typeof mod.DatabaseSync === 'function' ? mod : null;
  } catch {
    return null;
  }
}

export class ReviewStore {
  private readonly stmts: {
    getReview: StatementSync;
    reviewBytes: StatementSync;
    putReview: StatementSync;
    touchReview: StatementSync;
    deleteReview: StatementSync;
    getPosition: StatementSync;
    positionBytes: StatementSync;
    putPosition: StatementSync;
    touchPosition: StatementSync;
    deletePosition: StatementSync;
    lruReviews: StatementSync;
    lruPositions: StatementSync;
    countReviews: StatementSync;
    countPositions: StatementSync;
  };
  /** Running total of the `bytes` column over both tables. */
  private total = 0;
  private closed = false;

  private constructor(
    private readonly db: DatabaseSync,
    private readonly cfg: ReviewStoreConfig,
    private readonly log: PoolLogger,
  ) {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);
    this.stmts = {
      getReview: db.prepare(
        'SELECT preset, start_fen, moves, record, created_at, last_used FROM reviews WHERE game_key = ?',
      ),
      reviewBytes: db.prepare('SELECT preset, bytes FROM reviews WHERE game_key = ?'),
      putReview: db.prepare(
        `INSERT INTO reviews (game_key, preset, start_fen, moves, record, bytes, created_at, last_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_key) DO UPDATE SET preset = excluded.preset, start_fen = excluded.start_fen,
           moves = excluded.moves, record = excluded.record, bytes = excluded.bytes,
           created_at = excluded.created_at, last_used = excluded.last_used`,
      ),
      touchReview: db.prepare('UPDATE reviews SET last_used = ? WHERE game_key = ?'),
      deleteReview: db.prepare('DELETE FROM reviews WHERE game_key = ?'),
      getPosition: db.prepare(
        'SELECT result, last_used FROM positions WHERE opts_key = ? AND fen = ?',
      ),
      positionBytes: db.prepare('SELECT bytes FROM positions WHERE opts_key = ? AND fen = ?'),
      putPosition: db.prepare(
        `INSERT INTO positions (opts_key, fen, result, bytes, last_used) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(opts_key, fen) DO UPDATE SET result = excluded.result, bytes = excluded.bytes,
           last_used = excluded.last_used`,
      ),
      touchPosition: db.prepare('UPDATE positions SET last_used = ? WHERE opts_key = ? AND fen = ?'),
      deletePosition: db.prepare('DELETE FROM positions WHERE opts_key = ? AND fen = ?'),
      lruReviews: db.prepare('SELECT game_key, bytes FROM reviews ORDER BY last_used ASC LIMIT ?'),
      lruPositions: db.prepare(
        'SELECT opts_key, fen, bytes FROM positions ORDER BY last_used ASC LIMIT ?',
      ),
      countReviews: db.prepare('SELECT COUNT(*) AS n FROM reviews'),
      countPositions: db.prepare('SELECT COUNT(*) AS n FROM positions'),
    };
    const sum = (table: string) =>
      Number(db.prepare(`SELECT COALESCE(SUM(bytes), 0) AS b FROM ${table}`).get()?.b ?? 0);
    this.total = sum('reviews') + sum('positions');
  }

  /**
   * Opens (creating directory and file) the store. Rejects when `node:sqlite` is unavailable or
   * the file cannot be opened; the caller then runs without a store.
   */
  static async open(cfg: ReviewStoreConfig, log: PoolLogger): Promise<ReviewStore> {
    const sqlite = await loadSqlite();
    if (!sqlite) throw new Error('node:sqlite is not available (Node >= 22.13 required)');
    mkdirSync(path.dirname(cfg.path), { recursive: true });
    const db = new sqlite.DatabaseSync(cfg.path);
    const store = new ReviewStore(db, cfg, log);
    store.evictIfNeeded();
    log.info({ path: cfg.path, ...store.stats() }, 'review store opened');
    return store;
  }

  get path(): string {
    return this.cfg.path;
  }

  stats(): ReviewStoreStats {
    return {
      reviews: Number(this.stmts.countReviews.get()?.n ?? 0),
      positions: Number(this.stmts.countPositions.get()?.n ?? 0),
      bytes: this.total,
      maxBytes: this.cfg.maxBytes,
    };
  }

  /** The stored review of `gameKey` (any preset), marking it used. */
  getReview(gameKey: string, now: number = Date.now()): StoredReviewRow | undefined {
    const row = this.stmts.getReview.get(gameKey);
    if (!row) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(gunzipSync(row.record as Uint8Array).toString('utf8'));
    } catch {
      parsed = undefined;
    }
    const record = StoredReviewRecordSchema.safeParse(parsed);
    if (!record.success) {
      // Written by an incompatible server version: drop it rather than serve it.
      this.log.warn({ gameKey }, 'review store: dropping unreadable record');
      this.deleteReview(gameKey);
      return undefined;
    }
    if (now - Number(row.last_used) > TOUCH_INTERVAL_MS) this.stmts.touchReview.run(now, gameKey);
    return {
      gameKey,
      preset: row.preset as ReviewPreset,
      startFen: String(row.start_fen),
      moves: String(row.moves).split(' '),
      record: record.data,
      createdAt: Number(row.created_at),
    };
  }

  /**
   * Stores a review; a weaker preset never replaces a stronger one (`superseded`), the same or a
   * stronger preset replaces the stored row.
   */
  putReview(input: PutReviewInput, now: number = Date.now()): 'stored' | 'superseded' {
    const existing = this.stmts.reviewBytes.get(input.gameKey);
    if (existing) {
      const prev = existing.preset as ReviewPreset;
      if (prev !== input.preset && coversPreset(prev, input.preset)) return 'superseded';
    }
    const blob = gzipSync(JSON.stringify(input.record));
    const moves = input.moves.join(' ');
    const bytes =
      blob.byteLength +
      input.gameKey.length +
      input.startFen.length +
      moves.length +
      ROW_OVERHEAD_BYTES;
    this.stmts.putReview.run(
      input.gameKey,
      input.preset,
      input.startFen,
      moves,
      blob,
      bytes,
      now,
      now,
    );
    this.total += bytes - Number(existing?.bytes ?? 0);
    this.evictIfNeeded();
    return 'stored';
  }

  /** Results of `fens` for one search budget, marking them used. */
  getPositions(optsKey: string, fens: readonly string[], now: number = Date.now()): Map<string, PositionResult> {
    const out = new Map<string, PositionResult>();
    for (const fen of fens) {
      const row = this.stmts.getPosition.get(optsKey, fen);
      if (!row) continue;
      out.set(fen, JSON.parse(Buffer.from(row.result as Uint8Array).toString('utf8')) as PositionResult);
      if (now - Number(row.last_used) > TOUCH_INTERVAL_MS) {
        this.stmts.touchPosition.run(now, optsKey, fen);
      }
    }
    return out;
  }

  /** Stores (or replaces) the results of one search budget. Returns the number written. */
  putPositions(
    optsKey: string,
    entries: readonly { fen: string; result: PositionResult }[],
    now: number = Date.now(),
  ): number {
    if (entries.length === 0) return 0;
    let delta = 0;
    this.transaction(() => {
      for (const { fen, result } of entries) {
        const prev = this.stmts.positionBytes.get(optsKey, fen);
        const blob = Buffer.from(JSON.stringify(result), 'utf8');
        const bytes = blob.byteLength + optsKey.length + fen.length + ROW_OVERHEAD_BYTES;
        this.stmts.putPosition.run(optsKey, fen, blob, bytes, now);
        delta += bytes - Number(prev?.bytes ?? 0);
      }
    });
    this.total += delta;
    this.evictIfNeeded();
    return entries.length;
  }

  /** Removes everything (tests, operator tooling). */
  clear(): void {
    this.db.exec('DELETE FROM positions; DELETE FROM reviews;');
    this.total = 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // -------------------------------------------------------------------------------------------

  private deleteReview(gameKey: string): void {
    const row = this.stmts.reviewBytes.get(gameKey);
    if (!row) return;
    this.stmts.deleteReview.run(gameKey);
    this.total -= Number(row.bytes);
  }

  /**
   * Least-recently-used eviction down to {@link EVICTION_TARGET} of `maxBytes`: positions first
   * (cheap to recompute), then whole reviews.
   */
  private evictIfNeeded(): void {
    if (this.total <= this.cfg.maxBytes) return;
    const target = Math.floor(this.cfg.maxBytes * EVICTION_TARGET);
    const before = this.total;
    let removed = 0;
    this.transaction(() => {
      while (this.total > target) {
        const rows = this.stmts.lruPositions.all(500);
        if (rows.length === 0) break;
        for (const r of rows) {
          if (this.total <= target) break;
          this.stmts.deletePosition.run(r.opts_key as string, r.fen as string);
          this.total -= Number(r.bytes);
          removed++;
        }
      }
      while (this.total > target) {
        const rows = this.stmts.lruReviews.all(100);
        if (rows.length === 0) break;
        for (const r of rows) {
          if (this.total <= target) break;
          this.stmts.deleteReview.run(r.game_key as string);
          this.total -= Number(r.bytes);
          removed++;
        }
      }
    });
    this.log.info(
      { removed, before, after: this.total, maxBytes: this.cfg.maxBytes },
      'review store: evicted least recently used rows',
    );
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}
