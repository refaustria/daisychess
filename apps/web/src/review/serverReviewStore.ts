/**
 * The server review store (ADR-017) as seen from the browser: finished reviews and position
 * results shared by every device, behind the shared api connection. Every function is best
 * effort — a down or old server, a missing token or a timeout makes reads return nothing and
 * writes do nothing, so the review behaves exactly as without a server.
 */
import {
  REVIEW_BOUNDS,
  type PositionResult as WirePositionResult,
  type ReviewStatsMessage,
  type StoredMoveDetail,
  type StoredReview as WireStoredReview,
  type StoredReviewRecord,
} from '@daisychess/engine-core';
import { apiConfigured, apiRequest, canWriteReviews } from '../server/apiConnection';
import { useSettingsStore } from '../store/settingsStore';
import type { BatchGame, PositionResult } from './BatchAnalyzer';
import type { MoveDetail, MoveDetails } from './details';
import { REVIEW_CACHE_VERSION, type StoredReview } from './reviewCache';

/** Positions per `review.positions.*` message. */
export const POSITIONS_CHUNK = REVIEW_BOUNDS.positionsPerMessage;

/**
 * True when the server store may be used: the api is configured and the review engine setting
 * is not `browser` (which never touches the network, ADR-014).
 */
export function serverStoreAvailable(): boolean {
  return apiConfigured() && useSettingsStore.getState().reviewEngine !== 'browser';
}

/** Wire ↔ web move details (`Record<string, …>` on the wire, keyed by ply number in the web). */
export function toWireDetails(details: MoveDetails): Record<string, StoredMoveDetail> {
  return Object.fromEntries(Object.entries(details).map(([ply, d]) => [String(ply), d]));
}

export function fromWireDetails(details: Record<string, StoredMoveDetail>): MoveDetails {
  const out: MoveDetails = {};
  for (const [ply, d] of Object.entries(details)) out[Number(ply)] = d satisfies MoveDetail;
  return out;
}

export function toWireRecord(r: StoredReview): StoredReviewRecord {
  return {
    version: r.version,
    options: r.options,
    engine: r.engine,
    summary: r.summary,
    moveDetails: toWireDetails(r.moveDetails),
  };
}

/** The web's record from a wire `StoredReview`. */
export function fromWireReview(r: WireStoredReview): StoredReview {
  return {
    gameKey: r.gameKey,
    startFen: r.startFen,
    moves: r.moves,
    preset: r.preset,
    options: r.options,
    summary: r.summary,
    moveDetails: fromWireDetails(r.moveDetails),
    engine: r.engine,
    createdAt: r.createdAt,
    version: r.version,
  };
}

/**
 * The server's review of `game` under `key` (any preset), or undefined: not stored, server not
 * reachable, record of another cache version.
 */
export async function fetchServerReview(
  game: BatchGame,
  key: string,
): Promise<StoredReview | undefined> {
  if (!serverStoreAvailable()) return undefined;
  const moves = game.moves.map((m) => m.san);
  if (moves.length < REVIEW_BOUNDS.plies.min || moves.length > REVIEW_BOUNDS.plies.max)
    return undefined;
  try {
    const reply = await apiRequest({
      type: 'review.get',
      gameKey: key,
      startFen: game.startFen,
      moves,
    });
    if (!reply.found || !reply.record || !reply.preset || reply.createdAt === undefined)
      return undefined;
    if (reply.record.version !== REVIEW_CACHE_VERSION) return undefined;
    return fromWireReview({
      ...reply.record,
      gameKey: key,
      startFen: game.startFen,
      moves,
      preset: reply.preset,
      createdAt: reply.createdAt,
    });
  } catch {
    return undefined;
  }
}

/** Offers a finished review to the server (token holders only); failures are ignored. */
export async function storeServerReview(r: StoredReview): Promise<boolean> {
  if (!serverStoreAvailable()) return false;
  if (r.moves.length < REVIEW_BOUNDS.plies.min || r.moves.length > REVIEW_BOUNDS.plies.max)
    return false;
  try {
    // The handshake tells whether writes are allowed; a read usually opened the connection
    // already. Without the token the server would refuse anyway, so skip the frame.
    if (!canWriteReviews()) {
      await apiRequest({ type: 'review.stats.get' });
      if (!canWriteReviews()) return false;
    }
    const reply = await apiRequest({
      type: 'review.put',
      gameKey: r.gameKey,
      startFen: r.startFen,
      moves: r.moves,
      preset: r.preset,
      record: toWireRecord(r),
    });
    return reply.stored;
  } catch {
    return false;
  }
}

export interface ServerPosition {
  fen: string;
  optionsKey: string;
  result: PositionResult;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Position results stored on the server for `fens`, for each of `optsKeys` (chunks of
 * {@link POSITIONS_CHUNK}, sent one after the other). Missing positions are simply absent.
 */
export async function fetchServerPositions(
  optsKeys: readonly string[],
  fens: readonly string[],
): Promise<ServerPosition[]> {
  if (!serverStoreAvailable()) return [];
  const out: ServerPosition[] = [];
  const unique = [...new Set(fens)];
  try {
    for (const optsKey of optsKeys) {
      for (const chunk of chunks(unique, POSITIONS_CHUNK)) {
        const reply = await apiRequest({ type: 'review.positions.get', optsKey, fens: chunk });
        for (const [fen, result] of Object.entries(reply.results)) {
          out.push({ fen, optionsKey: optsKey, result: result satisfies WirePositionResult });
        }
      }
    }
  } catch {
    // Keep what arrived; the rest is searched.
  }
  return out;
}

/** Offers position results of one budget to the server (token holders only); silent. */
export async function storeServerPositions(
  optsKey: string,
  entries: readonly { fen: string; result: PositionResult }[],
): Promise<void> {
  if (!serverStoreAvailable() || entries.length === 0 || !canWriteReviews()) return;
  try {
    for (const chunk of chunks(entries, POSITIONS_CHUNK)) {
      await apiRequest({ type: 'review.positions.put', optsKey, entries: chunk });
    }
  } catch {
    // Best effort.
  }
}

export type ServerReviewStats = Omit<ReviewStatsMessage, 'type'>;

/** Size of the server store, or undefined when there is none / it is not reachable. */
export async function fetchServerReviewStats(): Promise<ServerReviewStats | undefined> {
  if (!serverStoreAvailable()) return undefined;
  try {
    const { type: _type, ...stats } = await apiRequest({ type: 'review.stats.get' });
    void _type;
    return stats;
  } catch {
    return undefined;
  }
}
