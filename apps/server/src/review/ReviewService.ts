/**
 * Handles the `review.*` messages (ADR-017) for the connections of one WebSocket server: auth
 * split (reads open, writes token-only), key verification (the key is recomputed from the moves
 * replayed with chess.js, so nothing can be stored under a foreign key), size and quota checks.
 * Every request is answered with exactly one message; the store itself may be absent (disabled or
 * failed to open), in which case reads find nothing and writes are refused with `disabled`.
 */
import { Chess } from 'chess.js';
import {
  REVIEW_BOUNDS,
  reviewGameKey,
  type PositionResult,
  type ReviewClientMessage,
  type ReviewPositionsGetMessage,
  type ReviewPositionsPutMessage,
  type ReviewPutMessage,
  type ReviewStatsMessage,
  type ReviewStoreReason,
  type ServerMessage,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import { PutQuota } from './putQuota.js';
import type { ReviewStore } from './ReviewStore.js';

/** What the service needs to know about the requesting connection. */
export interface ReviewClientContext {
  readonly id: number;
  readonly ip: string;
  /** The connection's `hello` carried the valid access token (or the server is public). */
  readonly analysisAllowed: boolean;
}

export interface ReviewServiceOptions {
  /** Null: the store is off or failed to open. */
  store: ReviewStore | null;
  /** `review.put` + `review.positions.put` per client address per UTC day. */
  putPerIpPerDay: number;
  logger: PoolLogger;
  /** Wall clock (tests). */
  now?: () => number;
}

/** UCI moves of a SAN game replayed with chess.js, or null when the FEN or a move is illegal. */
export function replaySan(startFen: string, sans: readonly string[]): string[] | null {
  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch {
    return null;
  }
  const uci: string[] = [];
  for (const san of sans) {
    try {
      const m = chess.move(san);
      uci.push(`${m.from}${m.to}${m.promotion ?? ''}`);
    } catch {
      return null;
    }
  }
  return uci;
}

export class ReviewService {
  private readonly store: ReviewStore | null;
  private readonly quota: PutQuota;
  private readonly log: PoolLogger;
  private readonly now: () => number;

  constructor(opts: ReviewServiceOptions) {
    this.store = opts.store;
    this.now = opts.now ?? Date.now;
    this.quota = new PutQuota(opts.putPerIpPerDay, this.now);
    this.log = opts.logger;
  }

  /** `welcome.capabilities.reviewStore`. */
  get enabled(): boolean {
    return this.store !== null;
  }

  /** `/health/detail` and `review.stats`. */
  stats(): Omit<ReviewStatsMessage, 'type'> {
    const s = this.store?.stats();
    return s
      ? { enabled: true, ...s }
      : { enabled: false, reviews: 0, positions: 0, bytes: 0, maxBytes: 0 };
  }

  handle(ctx: ReviewClientContext, msg: ReviewClientMessage): ServerMessage {
    switch (msg.type) {
      case 'review.get':
        return this.get(msg.gameKey, msg.startFen, msg.moves);
      case 'review.put':
        return this.put(ctx, msg);
      case 'review.positions.get':
        return this.getPositions(msg);
      case 'review.positions.put':
        return this.putPositions(ctx, msg);
      case 'review.stats.get':
        return { type: 'review.stats', ...this.stats() };
    }
  }

  close(): void {
    this.store?.close();
  }

  // -------------------------------------------------------------------------------------------

  private get(gameKey: string, startFen: string, moves: string[]): ServerMessage {
    const miss: ServerMessage = { type: 'review.record', gameKey, found: false };
    if (!this.store) return miss;
    try {
      const row = this.store.getReview(gameKey, this.now());
      if (!row || row.startFen !== startFen || !sameMoves(row.moves, moves)) return miss;
      return {
        type: 'review.record',
        gameKey,
        found: true,
        preset: row.preset,
        record: row.record,
        createdAt: row.createdAt,
      };
    } catch (err) {
      this.log.error({ gameKey, err: (err as Error).message }, 'review store: read failed');
      return miss;
    }
  }

  private put(ctx: ReviewClientContext, msg: ReviewPutMessage): ServerMessage {
    const refuse = (reason: ReviewStoreReason): ServerMessage => {
      if (reason !== 'superseded') {
        this.log.info({ conn: ctx.id, gameKey: msg.gameKey, reason }, 'review.put refused');
      }
      return { type: 'review.stored', gameKey: msg.gameKey, stored: false, reason };
    };
    const gate = this.writeGate(ctx);
    if (gate) return refuse(gate);
    const uci = replaySan(msg.startFen, msg.moves);
    if (!uci) return refuse('illegal_game');
    if (reviewGameKey(msg.startFen, uci) !== msg.gameKey) return refuse('key_mismatch');
    if (JSON.stringify(msg.record).length > REVIEW_BOUNDS.recordMaxBytes) return refuse('too_large');
    try {
      const outcome = this.store!.putReview(
        {
          gameKey: msg.gameKey,
          preset: msg.preset,
          startFen: msg.startFen,
          moves: msg.moves,
          record: msg.record,
        },
        this.now(),
      );
      if (outcome === 'superseded') return refuse('superseded');
      this.log.info(
        { conn: ctx.id, gameKey: msg.gameKey, preset: msg.preset, plies: msg.moves.length },
        'review stored',
      );
      return { type: 'review.stored', gameKey: msg.gameKey, stored: true };
    } catch (err) {
      this.log.error({ gameKey: msg.gameKey, err: (err as Error).message }, 'review store: write failed');
      return refuse('storage_error');
    }
  }

  private getPositions(msg: ReviewPositionsGetMessage): ServerMessage {
    const results: Record<string, PositionResult> = {};
    if (this.store) {
      try {
        for (const [fen, r] of this.store.getPositions(msg.optsKey, msg.fens, this.now())) {
          results[fen] = r;
        }
      } catch (err) {
        this.log.error({ err: (err as Error).message }, 'review store: positions read failed');
      }
    }
    return { type: 'review.positions', optsKey: msg.optsKey, results };
  }

  private putPositions(ctx: ReviewClientContext, msg: ReviewPositionsPutMessage): ServerMessage {
    const refuse = (reason: ReviewStoreReason): ServerMessage => {
      this.log.info({ conn: ctx.id, optsKey: msg.optsKey, reason }, 'review.positions.put refused');
      return { type: 'review.positions.stored', optsKey: msg.optsKey, stored: false, reason };
    };
    const gate = this.writeGate(ctx);
    if (gate) return refuse(gate);
    try {
      this.store!.putPositions(msg.optsKey, msg.entries, this.now());
      return { type: 'review.positions.stored', optsKey: msg.optsKey, stored: true };
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'review store: positions write failed');
      return refuse('storage_error');
    }
  }

  /** Why a write is refused before it is looked at, or null when it may proceed. */
  private writeGate(ctx: ReviewClientContext): ReviewStoreReason | null {
    if (!this.store) return 'disabled';
    if (!ctx.analysisAllowed) return 'unauthorized';
    if (!this.quota.take(ctx.ip)) return 'quota';
    return null;
  }
}

function sameMoves(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}
