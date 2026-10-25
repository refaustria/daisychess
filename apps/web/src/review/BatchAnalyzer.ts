import {
  reviewGame,
  scoreToWhitePov,
  sideToMove,
  type AnalyzeOptions,
  type BestMove,
  type Engine,
  type EngineInfo,
  type ReviewSummary,
  type Score,
} from '@daisychess/engine-core';
import { Chess } from 'chess.js';

/** One move of the game to review. `fenAfter` is the position reached by the move. */
export interface BatchMove {
  uci: string;
  san: string;
  fenAfter: string;
}

export interface BatchGame {
  startFen: string;
  moves: BatchMove[];
}

/** Analysis result of one position (White-POV eval, engine best move and line in UCI). */
export interface PositionResult {
  eval: Score;
  bestMove?: string;
  /** Principal variation of the last info, at most {@link MAX_PV_PLIES} moves (UCI). */
  pv?: string[];
  /** Depth of the last info (reached depth; lets a deeper budget reuse a movetime result). */
  depth?: number;
}

/** Plies of the principal variation kept per position. */
export const MAX_PV_PLIES = 8;

/**
 * Positions already analysed, keyed by full FEN. Only reuse it with identical (or, see the review
 * store, at least as strong) search options.
 */
export type PositionCache = Map<string, PositionResult>;

export interface BatchOptions {
  /** Depth limit per position. Default 18 (ignored when `movetime` is set). */
  depth?: number;
  /** Time per position in ms. Takes precedence over `depth`. */
  movetime?: number;
  multipv?: 1;
  /**
   * Perspective of the scores the engine yields. `'white'` (default): already White POV, as
   * {@link WasmEngineClient} (via UciSession) and the remote client deliver them. `'stm'`: raw UCI
   * scores relative to the side to move; converted with `scoreToWhitePov`.
   */
  pov?: 'white' | 'stm';
}

/** The engine's analysis stream; `bestMove` is provided by `AnalysisHandle` and optional otherwise. */
type Handle = AsyncIterable<EngineInfo> & { readonly bestMove?: Promise<BestMove | null> };

export interface BatchAnalyzerConfig {
  /** A loaded engine. The analyzer never loads or disposes it. */
  engine: Engine;
  options?: BatchOptions;
  /** Only sequential analysis is supported (one engine, one search at a time). */
  concurrency?: 1;
  /** Shared cache (e.g. kept by the store across runs); a new one is created when omitted. */
  cache?: PositionCache;
  /**
   * A search that produces no output (info, end of stream, best move) for this long fails with
   * {@link EngineStallError} and the engine is told to stop. Undefined/0: no watchdog.
   */
  stallMs?: number;
}

/** The engine stopped answering during a search (see {@link BatchAnalyzerConfig.stallMs}). */
export class EngineStallError extends Error {
  constructor(ms: number) {
    super(
      `the engine stopped responding (no output for ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`})`,
    );
    this.name = 'EngineStallError';
  }
}

export interface BatchCallbacks {
  /** After every position (cached, terminal or searched). `partial` reviews the analysed prefix. */
  onProgress?(done: number, total: number, partial?: ReviewSummary): void;
  onDone?(summary: ReviewSummary): void;
  /** Every rejection, including cancellation (`err.name === 'AbortError'`). */
  onError?(err: Error): void;
}

export interface BatchRun {
  /** Stops the current search and rejects `promise` with an AbortError. Idempotent. */
  cancel(): void;
  promise: Promise<ReviewSummary>;
  /**
   * Results of the positions analysed so far, in game order (index 0 = start position). Filled
   * before each `onProgress`; read-only for callers (e.g. to build per-move details with PVs).
   */
  readonly results: readonly PositionResult[];
}

export const DEFAULT_REVIEW_DEPTH = 18;

export function abortError(message = 'Review cancelled'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export const isAbortError = (err: unknown): boolean =>
  err instanceof Error && err.name === 'AbortError';

/** Terminal positions are not searched: checkmate → `{mate: 0}`, stalemate → `{cp: 0}`. */
export function terminalEval(chess: Chess): Score | null {
  // `reviewGame` treats `mate: 0` in the position *after* a move as checkmate delivered by the
  // mover (win probability 100 for the mover), whichever colour was mated.
  if (chess.isCheckmate()) return { mate: 0 };
  if (chess.isStalemate()) return { cp: 0 };
  return null;
}

/**
 * Analyses every position of a game with one engine, sequentially, and reviews it with
 * `reviewGame`. Framework-free; the review store drives it.
 *
 * - Cancellation: {@link BatchRun.cancel} calls `engine.stop()` and abandons the current
 *   iterator; the promise rejects only after `stop()` has settled, i.e. once the engine is idle,
 *   so a following run never receives output of the aborted search.
 * - Caching: every completed position is stored in {@link cache} before the next one starts;
 *   an aborted search is never cached. Re-running the same game (or one sharing positions)
 *   only searches the missing positions.
 */
export class BatchAnalyzer {
  readonly cache: PositionCache;
  private readonly engine: Engine;
  private readonly options: Required<Pick<BatchOptions, 'pov'>> & BatchOptions;
  private readonly stallMs: number;

  constructor(config: BatchAnalyzerConfig) {
    if (config.concurrency !== undefined && config.concurrency !== 1) {
      throw new Error('BatchAnalyzer: only concurrency 1 is supported');
    }
    const o = config.options ?? {};
    for (const [k, v] of [
      ['depth', o.depth],
      ['movetime', o.movetime],
    ] as const) {
      if (v !== undefined && (!Number.isInteger(v) || v <= 0)) {
        throw new Error(`BatchAnalyzer: ${k} must be a positive integer, got ${v}`);
      }
    }
    this.engine = config.engine;
    this.options = { ...o, pov: o.pov ?? 'white' };
    this.cache = config.cache ?? new Map();
    this.stallMs = config.stallMs ?? 0;
  }

  /** Search options sent to the engine for every position. */
  get searchOptions(): AnalyzeOptions {
    const { movetime, depth } = this.options;
    return movetime !== undefined
      ? { movetime, multipv: 1 }
      : { depth: depth ?? DEFAULT_REVIEW_DEPTH, multipv: 1 };
  }

  run(game: BatchGame, callbacks: BatchCallbacks = {}): BatchRun {
    let cancelled = false;
    let stopping: Promise<void> | null = null;
    let rejectAbort: (err: Error) => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    aborted.catch(() => undefined);

    const cancel = (): void => {
      if (cancelled) return;
      cancelled = true;
      stopping = this.engine.stop().catch(() => undefined);
      rejectAbort(abortError());
    };

    const throwIfCancelled = async (): Promise<void> => {
      if (!cancelled) return;
      await stopping;
      throw abortError();
    };

    const results: PositionResult[] = [];
    const promise = (async (): Promise<ReviewSummary> => {
      const { positions, moves } = prepare(game);
      const total = positions.length;
      const partial = (): ReviewSummary | undefined =>
        results.length < 2
          ? undefined
          : reviewGame({
              positions: results.map((r, i) => reviewPosition(positions[i]!.fen, r)),
              moves: moves.slice(0, results.length - 1),
            });

      for (const pos of positions) {
        await throwIfCancelled();
        let result = this.cache.get(pos.fen);
        if (!result) {
          result = pos.terminal ? { eval: pos.terminal } : await this.search(pos.fen, aborted);
          await throwIfCancelled();
          this.cache.set(pos.fen, result);
        }
        results.push(result);
        callbacks.onProgress?.(results.length, total, partial());
      }
      await throwIfCancelled();
      return reviewGame({
        positions: results.map((r, i) => reviewPosition(positions[i]!.fen, r)),
        moves,
      });
    })();

    // Normalise rejections and fire the callbacks.
    const settled = promise.then(
      (summary) => {
        callbacks.onDone?.(summary);
        return summary;
      },
      async (err: unknown) => {
        let e = err instanceof Error ? err : new Error(String(err));
        if (cancelled) {
          // Settle only once the engine is idle. An engine error racing a cancel still counts
          // as a cancellation.
          await stopping;
          if (!isAbortError(e)) e = abortError();
        }
        callbacks.onError?.(e);
        throw e;
      },
    );
    return { cancel, promise: settled, results };
  }

  /** Runs one search to completion (or until `aborted` rejects). */
  private async search(fen: string, aborted: Promise<never>): Promise<PositionResult> {
    const handle = this.engine.analyze(fen, this.searchOptions) as Handle;
    const it = handle[Symbol.asyncIterator]();
    let last: EngineInfo | undefined;
    // Watchdog: every awaited step must settle within `stallMs` (a silent worker never ends).
    const step = <T>(p: Promise<T>): Promise<T> => {
      if (this.stallMs <= 0) return Promise.race([p, aborted]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void this.engine.stop().catch(() => undefined);
          reject(new EngineStallError(this.stallMs));
        }, this.stallMs);
      });
      return Promise.race([p, aborted, stalled]).finally(() => clearTimeout(timer));
    };
    try {
      for (;;) {
        const r = await step(it.next());
        if (r.done) break;
        if ((r.value.multipv ?? 1) === 1) last = r.value;
      }
    } catch (err) {
      // Abandon the iterator (UciSession stops the search on return()).
      void Promise.resolve(it.return?.()).catch(() => undefined);
      throw err;
    }
    const best = handle.bestMove ? await step(handle.bestMove) : null;
    if (!last) throw new Error(`Engine returned no evaluation for ${fen}`);
    const score =
      this.options.pov === 'stm' ? scoreToWhitePov(last.score, sideToMove(fen)) : last.score;
    const bestMove = best?.move ?? last.pv[0];
    const pv = last.pv.slice(0, MAX_PV_PLIES);
    return {
      eval: score,
      ...(bestMove !== undefined ? { bestMove } : {}),
      ...(pv.length > 0 ? { pv } : {}),
      ...(Number.isFinite(last.depth) ? { depth: last.depth } : {}),
    };
  }
}

/** `reviewGame` input for one position (the PV stays in the web layer). */
function reviewPosition(
  fen: string,
  r: PositionResult,
): { fen: string; eval: Score; bestMove?: string } {
  return { fen, eval: r.eval, ...(r.bestMove !== undefined ? { bestMove: r.bestMove } : {}) };
}

interface PreparedPosition {
  fen: string;
  terminal: Score | null;
}

/** Validates the game with chess.js: positions, terminal evals and legal-move counts. */
function prepare(game: BatchGame): {
  positions: PreparedPosition[];
  moves: Array<{ uci: string; san: string; legalMoves: number }>;
} {
  const chess = new Chess(game.startFen);
  const positions: PreparedPosition[] = [{ fen: game.startFen, terminal: terminalEval(chess) }];
  const moves = game.moves.map((m, i) => {
    const legalMoves = chess.moves().length;
    try {
      chess.move({ from: m.uci.slice(0, 2), to: m.uci.slice(2, 4), promotion: m.uci[4] });
    } catch {
      throw new Error(`Illegal move ${m.uci} at ply ${i + 1}`);
    }
    positions.push({ fen: m.fenAfter, terminal: terminalEval(chess) });
    return { uci: m.uci, san: m.san, legalMoves };
  });
  return { positions, moves };
}
