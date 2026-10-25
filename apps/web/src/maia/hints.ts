/**
 * Human-like review hints (M23-3, ADR-019): for the inaccuracies, mistakes and blunders of a
 * reviewed game, what players at the mover's level typically play in the position before the move,
 * from the Maia networks on the engine server (`maia-<rating>`, a 1-node Lc0 search whose last
 * `info` carries the policy top 5).
 *
 * Framework-free: rating mapping, policy → hint conversion and the query runner. The zustand store
 * (`hintStore.ts`) adds caching, availability and the wiring to the review.
 */
import type {
  AnalyzeOptions,
  BestMove,
  EngineDescriptor,
  EngineInfo,
  MoveClass,
  PolicyEntry,
} from '@daisychess/engine-core';
import { Chess } from 'chess.js';

/** The Maia levels the server offers (ADR-019). */
export const MAIA_LEVELS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900] as const;
export const MAIA_MIN_RATING = 1100;
export const MAIA_MAX_RATING = 1900;
export const DEFAULT_MAIA_RATING = 1500;

/** Classes that get a hint. */
export const HINT_CLASSES: ReadonlySet<MoveClass> = new Set<MoveClass>([
  'inaccuracy',
  'mistake',
  'blunder',
]);

/** Note shown next to a level clamped to Maia's range. */
export const MAIA_HIGHEST_NOTE = "Maia's highest level";
export const MAIA_LOWEST_NOTE = "Maia's lowest level";

/** The Maia level used for one side. */
export interface MaiaLevel {
  rating: number;
  /** `pgn`: from the `WhiteElo`/`BlackElo` header; `setting`: the user's level setting. */
  source: 'pgn' | 'setting';
  /** The header rating when `source` is `pgn`. */
  elo?: number;
  /** Set when the rating was clamped to Maia's range. */
  note?: string;
}

export interface GameLevels {
  white: MaiaLevel;
  black: MaiaLevel;
}

/**
 * Rounds to the nearest Maia level (100 steps); ratings above 1900 / below 1100 are clamped with a
 * note ("Maia's highest level").
 */
export function nearestMaiaLevel(rating: number): { rating: number; note?: string } {
  if (rating > MAIA_MAX_RATING) return { rating: MAIA_MAX_RATING, note: MAIA_HIGHEST_NOTE };
  if (rating < MAIA_MIN_RATING) return { rating: MAIA_MIN_RATING, note: MAIA_LOWEST_NOTE };
  return { rating: Math.round(rating / 100) * 100 };
}

/** A stored level setting: one of {@link MAIA_LEVELS}, else the default. */
export function normalizeMaiaRating(v: unknown): number {
  return typeof v === 'number' && (MAIA_LEVELS as readonly number[]).includes(v)
    ? v
    : DEFAULT_MAIA_RATING;
}

/** Parses a PGN rating header (`1523`, `1523?` provisional); `?`, `-`, empty → undefined. */
export function parseElo(v: string | undefined): number | undefined {
  const m = /^\s*(\d{2,4})\b/.exec(v ?? '');
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 100 && n <= 4000 ? n : undefined;
}

/** Level per side: the PGN rating when present (clamped/rounded), else `fallback` (the setting). */
export function gameLevels(
  headers: Readonly<Record<string, string>>,
  fallback: number,
): GameLevels {
  const side = (key: 'WhiteElo' | 'BlackElo'): MaiaLevel => {
    const elo = parseElo(headers[key]);
    if (elo === undefined) return { rating: normalizeMaiaRating(fallback), source: 'setting' };
    const l = nearestMaiaLevel(elo);
    return { rating: l.rating, source: 'pgn', elo, ...(l.note ? { note: l.note } : {}) };
  };
  return { white: side('WhiteElo'), black: side('BlackElo') };
}

export const maiaEngineId = (rating: number): string => `maia-${rating}`;

/** One move of a hint: SAN in the position before the move and its probability (0…1). */
export interface HintMove {
  uci: string;
  san: string;
  p: number;
}

/** What players at `rating` play in the position before `ply`. */
export interface MaiaHint {
  ply: number;
  rating: number;
  /** Maia's three most likely moves, most likely first. */
  top: HintMove[];
  /** Probability of the move actually played, when it is in Maia's top 5. */
  playedP?: number;
  /** Probability of Stockfish's best move, when it is in Maia's top 5. */
  bestP?: number;
  /** The played move is Maia's most likely move. */
  playedIsTop: boolean;
  /** Smallest probability in the top 5 (a move outside it is less likely than this). */
  minP?: number;
  /** Number of policy entries received (≤ 5). */
  entries: number;
}

/** UCI → SAN in `fen` (castling as `e1g1` or `e1h1`); undefined when illegal. */
function toSan(chess: Chess, uci: string): string | undefined {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.length > 4 ? uci[4] : undefined;
  const legal = chess.moves({ verbose: true });
  const m =
    legal.find((x) => x.from === from && x.to === to && (x.promotion ?? undefined) === promotion) ??
    // King-takes-rook castling notation.
    legal.find(
      (x) =>
        x.from === from &&
        x.piece === 'k' &&
        (x.flags.includes('k') || x.flags.includes('q')) &&
        x.to[0] === (to[0] === 'h' ? 'g' : to[0] === 'a' ? 'c' : '') &&
        x.to[1] === to[1],
    );
  return m?.san;
}

/** Inputs of one hint query. */
export interface HintJob {
  ply: number;
  rating: number;
  /** Position before the move. */
  fenBefore: string;
  playedUci: string;
  /** Stockfish's best move in `fenBefore`, if known. */
  bestUci?: string;
}

/**
 * Converts Maia's policy (most probable first) into a hint; undefined when nothing usable is left
 * (no entries, or none legal in the position).
 */
export function hintFromPolicy(job: HintJob, policy: readonly PolicyEntry[]): MaiaHint | undefined {
  let chess: Chess;
  try {
    chess = new Chess(job.fenBefore);
  } catch {
    return undefined;
  }
  const moves: HintMove[] = [];
  for (const e of [...policy].sort((a, b) => b.p - a.p).slice(0, 5)) {
    const san = toSan(chess, e.uci);
    if (san && !moves.some((m) => m.san === san)) moves.push({ uci: e.uci, san, p: e.p });
  }
  if (moves.length === 0) return undefined;
  const playedSan = toSan(chess, job.playedUci);
  const bestSan = job.bestUci ? toSan(chess, job.bestUci) : undefined;
  const played = playedSan ? moves.find((m) => m.san === playedSan) : undefined;
  const best = bestSan ? moves.find((m) => m.san === bestSan) : undefined;
  return {
    ply: job.ply,
    rating: job.rating,
    top: moves.slice(0, 3),
    ...(played ? { playedP: played.p } : {}),
    ...(best ? { bestP: best.p } : {}),
    playedIsTop: playedSan !== undefined && moves[0]!.san === playedSan,
    ...(moves.length >= 5 ? { minP: moves[moves.length - 1]!.p } : {}),
    entries: moves.length,
  };
}

/** The per-move fields of the review details a hint job needs. */
export interface HintSourceDetail {
  ply: number;
  classification: MoveClass;
  fenBefore: string;
  playedUci: string;
  bestUci?: string;
  mover: 'white' | 'black';
}

/** Jobs for the plies classified inaccuracy/mistake/blunder, in ply order. */
export function hintJobs(
  details: Readonly<Record<number, HintSourceDetail>>,
  levels: GameLevels,
): HintJob[] {
  return Object.values(details)
    .filter((d) => HINT_CLASSES.has(d.classification))
    .sort((a, b) => a.ply - b.ply)
    .map((d) => ({
      ply: d.ply,
      rating: levels[d.mover].rating,
      fenBefore: d.fenBefore,
      playedUci: d.playedUci,
      ...(d.bestUci ? { bestUci: d.bestUci } : {}),
    }));
}

// ---------------------------------------------------------------------------------------------
// Runner

/**
 * The part of `RemoteEngineClient` the hints use (structural: tests pass a fake, and this module
 * does not pull the client into the main chunk). One instance = one connection + one server
 * session bound to one engine id.
 */
export interface MaiaClient {
  load(): Promise<void>;
  /** `welcome.engines` after `load()`. */
  readonly engines?: readonly EngineDescriptor[];
  analyze(
    fen: string,
    opts?: AnalyzeOptions,
  ): AsyncIterable<EngineInfo> & { readonly bestMove?: Promise<BestMove | null> };
  /** Releases the server session and closes the connection. */
  dispose(): Promise<void>;
}

/** Client factory: a fresh, not yet loaded client for `engineId` (`maia-1500`). */
export type CreateMaiaClient = (engineId: string) => MaiaClient | Promise<MaiaClient>;

/** How a hint run ended. */
export type HintRunStatus =
  /** Every job was attempted. */
  | 'done'
  /** The server refused the access token (restricted welcome). */
  | 'unauthorized'
  /** No server, no Maia on it, connection lost or not answering: partial results only. */
  | 'unavailable'
  /** `no_capacity` persisted through every retry. */
  | 'busy'
  | 'aborted';

export interface HintRunOptions {
  createClient: CreateMaiaClient;
  onHint(hint: MaiaHint): void;
  signal?: AbortSignal;
  /** Backoff before each retry after `no_capacity`/`rate_limited` (ms). */
  retryDelaysMs?: readonly number[];
  /** Minimum time between two `analyze` of one client (server: 20 analyze/s per connection). */
  minIntervalMs?: number;
  /** A handshake or query without an answer for this long ends the run (`unavailable`). */
  timeoutMs?: number;
  /** Injectable clock for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export const HINT_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;
export const HINT_MIN_INTERVAL_MS = 60;
export const HINT_TIMEOUT_MS = 10_000;

const RETRY_CODES = new Set(['no_capacity', 'rate_limited']);
const FATAL_CODES = new Set([
  'closed',
  'timeout',
  'unknown_engine',
  'engine_crashed',
  'node_lost',
  'denied',
]);

const codeOf = (err: unknown): string | undefined => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
};

class HintTimeout extends Error {
  readonly code = 'timeout';
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HintTimeout(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** One 1-node Maia search; resolves with the policy of the last `info` carrying one. */
async function queryPolicy(client: MaiaClient, fen: string): Promise<PolicyEntry[] | undefined> {
  let policy: PolicyEntry[] | undefined;
  for await (const info of client.analyze(fen, {})) {
    if (info.policy && info.policy.length > 0) policy = info.policy;
  }
  return policy;
}

/**
 * Runs the jobs: grouped by rating, one dedicated client (connection + session) per rating, groups
 * one after another (at most one Maia session of this tab at a time, so the per-address session
 * cap leaves room for the live analysis), each group's queries sequentially and at most one per
 * {@link HINT_MIN_INTERVAL_MS}. Every client is disposed (session released) when its group ends.
 *
 * - `no_capacity` / `rate_limited` on a query: retried after each of `retryDelaysMs`; when they
 *   are exhausted the run ends `busy`.
 * - Handshake failure: `unauthorized` for a refused token, else `unavailable` (no Maia on the
 *   server, not reachable); the welcome must list the engine with `style: 'human'`.
 * - Connection lost / no answer within `timeoutMs`: `unavailable` (hints so far are kept).
 * - Any other per-query error (e.g. a position the server rejects) skips that job.
 */
export async function runHintJobs(
  jobs: readonly HintJob[],
  opts: HintRunOptions,
): Promise<HintRunStatus> {
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;
  const delays = opts.retryDelaysMs ?? HINT_RETRY_DELAYS_MS;
  const minInterval = opts.minIntervalMs ?? HINT_MIN_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? HINT_TIMEOUT_MS;
  const aborted = () => opts.signal?.aborted === true;

  const groups = new Map<number, HintJob[]>();
  for (const j of jobs) {
    const g = groups.get(j.rating);
    if (g) g.push(j);
    else groups.set(j.rating, [j]);
  }

  for (const [rating, group] of groups) {
    if (aborted()) return 'aborted';
    // Jobs of this group done so far; a lost node (close 1012) gets one fresh session for the rest.
    let next = 0;
    let nodeRetried = false;
    const runGroup = async (): Promise<HintRunStatus | 'retry' | undefined> => {
      const engineId = maiaEngineId(rating);
      let client: MaiaClient | undefined;
      const release = async () => {
        const c = client;
        client = undefined;
        if (c) await c.dispose().catch(() => undefined);
      };
      try {
        client = await opts.createClient(engineId);
        await withTimeout(client.load(), timeoutMs);
      } catch (err) {
        await release();
        return codeOf(err) === 'unauthorized' ? 'unauthorized' : 'unavailable';
      }
      const descriptor = client.engines?.find((e) => e.id === engineId);
      if (client.engines && (!descriptor || !descriptor.enabled || descriptor.style !== 'human')) {
        await release();
        return 'unavailable';
      }
      if (aborted()) {
        await release();
        return 'aborted';
      }

      let lastSent = -Infinity;
      for (; next < group.length; next++) {
        const job = group[next]!;
        let attempt = 0;
        for (;;) {
          if (aborted()) {
            await release();
            return 'aborted';
          }
          const wait = lastSent + minInterval - now();
          if (wait > 0) await sleep(wait, opts.signal);
          if (aborted()) {
            await release();
            return 'aborted';
          }
          lastSent = now();
          try {
            const policy = await withTimeout(queryPolicy(client, job.fenBefore), timeoutMs);
            const hint = policy ? hintFromPolicy(job, policy) : undefined;
            if (hint && !aborted()) opts.onHint(hint);
            break;
          } catch (err) {
            const code = codeOf(err);
            if (code !== undefined && RETRY_CODES.has(code)) {
              if (attempt >= delays.length) {
                await release();
                return 'busy';
              }
              await sleep(delays[attempt]!, opts.signal);
              attempt++;
              continue;
            }
            if (code === 'node_lost' && !nodeRetried) {
              nodeRetried = true;
              await release();
              return 'retry';
            }
            if (code === 'unauthorized') {
              await release();
              return 'unauthorized';
            }
            if (code === undefined || FATAL_CODES.has(code) || err instanceof HintTimeout) {
              await release();
              return 'unavailable';
            }
            break; // per-position rejection (invalid_request, limit_exceeded, …): skip the job
          }
        }
      }
      await release();
      return undefined;
    };
    for (;;) {
      const status = await runGroup();
      if (status === 'retry') continue;
      if (status) return status;
      break;
    }
  }
  return aborted() ? 'aborted' : 'done';
}
