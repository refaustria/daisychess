import type { Engine, ReviewSummary } from '@chesslab/engine-core';
import { create } from 'zustand';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore, type GameState } from '../store/gameStore';
import {
  BatchAnalyzer,
  DEFAULT_REVIEW_DEPTH,
  isAbortError,
  type BatchGame,
  type BatchOptions,
  type BatchRun,
  type PositionCache,
} from './BatchAnalyzer';
import { buildMoveDetails, type MoveDetails } from './details';

export type ReviewStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled';

/** Search budget per position: `movetime` (ms) takes precedence over `depth`. */
export interface ReviewOptions {
  depth?: number;
  movetime?: number;
}

export const REVIEW_PRESETS = {
  fast: { movetime: 300 },
  deep: { depth: DEFAULT_REVIEW_DEPTH },
} as const satisfies Record<string, ReviewOptions>;

/** Who started the current/last review. */
export type ReviewTrigger = 'manual' | 'auto';

export interface ReviewState {
  status: ReviewStatus;
  progress: { done: number; total: number };
  summary?: ReviewSummary;
  /** Per-move details (best line in SAN, evals, swing) for the plies of `summary`. */
  moveDetails: MoveDetails;
  error?: string;
  options: ReviewOptions;
  trigger: ReviewTrigger;
  /** Show the "Auto review (fast)" hint (auto-started review, not dismissed). */
  autoNotice: boolean;
}

export interface StartMeta {
  /** Started automatically after a game was loaded (see `autoReview.ts`). */
  auto?: boolean;
}

export interface ReviewActions {
  /**
   * Reviews the current game of `useGameStore`. Resolves with the summary, or undefined when the
   * run was cancelled, failed or superseded (see `status`/`error`). While running, a second call
   * returns the running promise.
   */
  start(options?: ReviewOptions, meta?: StartMeta): Promise<ReviewSummary | undefined>;
  cancel(): void;
  /** Cancels a running review and returns to `idle`. The position cache is kept. */
  reset(): void;
  dismissAutoNotice(): void;
}

export type ReviewStore = ReviewState & ReviewActions;

/** Engine factory: returns an engine with a `load()` the store calls once (lazily). */
export type CreateReviewEngine = () => Engine | Promise<Engine>;

const createWasmEngine: CreateReviewEngine = async () => {
  const { WasmEngineClient } = await import('../engine/WasmEngineClient');
  return new WasmEngineClient();
};

/** Upper bound for cached positions per options key (oldest entries are dropped first). */
export const MAX_CACHED_POSITIONS = 5000;

let createEngine: CreateReviewEngine = createWasmEngine;
let enginePromise: Promise<Engine> | null = null;
let engine: Engine | null = null;
const caches = new Map<string, PositionCache>();
let current: { token: number; cancel(): void; promise: Promise<ReviewSummary | undefined> } | null =
  null;
let token = 0;
/** Promise of a run that was reset but may still be stopping the engine. */
let settling: Promise<unknown> = Promise.resolve();
/** True while the live analysis is disabled by the review store. */
let analysisSuspended = false;

/** Replaces the engine factory (tests, later: remote engine). Disposes the current engine. */
export function setReviewEngineFactory(factory: CreateReviewEngine): void {
  createEngine = factory;
  void disposeReviewEngine();
}

/** Disposes the review engine and forgets all cached positions (tests, teardown). */
export async function disposeReviewEngine(): Promise<void> {
  current?.cancel();
  const e = engine;
  engine = null;
  enginePromise = null;
  caches.clear();
  if (e) await e.dispose().catch(() => undefined);
}

function getEngine(): Promise<Engine> {
  enginePromise ??= (async () => {
    const e = await createEngine();
    engine = e;
    await e.load();
    return e;
  })().catch((err: unknown) => {
    // Retry with a fresh engine next time.
    const e = engine;
    engine = null;
    enginePromise = null;
    if (e) void e.dispose().catch(() => undefined);
    throw err;
  });
  return enginePromise;
}

const optionsKey = (o: BatchOptions): string =>
  o.movetime !== undefined ? `mt:${o.movetime}` : `d:${o.depth}`;

function cacheFor(key: string): PositionCache {
  let c = caches.get(key);
  if (!c) caches.set(key, (c = new Map()));
  return c;
}

function prune(cache: PositionCache): void {
  const excess = cache.size - MAX_CACHED_POSITIONS;
  if (excess <= 0) return;
  let i = 0;
  for (const k of cache.keys()) {
    if (i++ >= excess) break;
    cache.delete(k);
  }
}

/** The game of `useGameStore` in the form the analyzer expects. */
export function gameToBatch(s: Pick<GameState, 'startFen' | 'moves'>): BatchGame {
  return {
    startFen: s.startFen,
    moves: s.moves.map((m) => ({
      uci: `${m.from}${m.to}${m.promotion ?? ''}`,
      san: m.san,
      fenAfter: m.fen,
    })),
  };
}

function normalize(o: ReviewOptions): BatchOptions {
  return o.movetime !== undefined
    ? { movetime: o.movetime }
    : { depth: o.depth ?? DEFAULT_REVIEW_DEPTH };
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const useReviewStore = create<ReviewStore>()((set, get) => ({
  status: 'idle',
  progress: { done: 0, total: 0 },
  options: { ...REVIEW_PRESETS.deep },
  moveDetails: {},
  trigger: 'manual',
  autoNotice: false,

  start: (opts, meta) => {
    if (current) return current.promise;
    const options = opts ? { ...opts } : get().options;
    const batchOptions = normalize(options);
    const game = gameToBatch(useGameStore.getState());
    const my = ++token;
    const total = game.moves.length + 1;

    // Keep the live analysis from competing for CPU; restored when no review runs any more.
    const analysis = useAnalysisStore.getState();
    if (analysis.enabled) {
      analysis.setEnabled(false);
      analysisSuspended = true;
    }

    set({
      status: 'running',
      progress: { done: 0, total },
      summary: undefined,
      moveDetails: {},
      error: undefined,
      options,
      trigger: meta?.auto ? 'auto' : 'manual',
      autoNotice: meta?.auto === true,
    });

    let cancelled = false;
    let run: { cancel(): void } | null = null;
    const isCurrent = (): boolean => current?.token === my;

    const promise = (async (): Promise<ReviewSummary | undefined> => {
      try {
        // A reset run may still be stopping its search; never overlap two runs on the engine.
        await settling;
        const e = await getEngine();
        if (cancelled) throw Object.assign(new Error('Review cancelled'), { name: 'AbortError' });
        const cache = cacheFor(optionsKey(batchOptions));
        const analyzer = new BatchAnalyzer({ engine: e, options: batchOptions, cache });
        let r: BatchRun | null = null;
        const details = (summary: ReviewSummary): MoveDetails =>
          buildMoveDetails(summary, game, r?.results ?? [], get().moveDetails);
        r = analyzer.run(game, {
          onProgress: (done, t, partial) => {
            if (isCurrent())
              set({
                progress: { done, total: t },
                ...(partial ? { summary: partial, moveDetails: details(partial) } : {}),
              });
          },
        });
        run = r;
        try {
          const summary = await r.promise;
          if (isCurrent())
            set({
              status: 'done',
              summary,
              moveDetails: details(summary),
              progress: { done: total, total },
            });
          return summary;
        } finally {
          prune(cache);
        }
      } catch (err) {
        if (isCurrent()) {
          if (isAbortError(err)) set({ status: 'cancelled' });
          else set({ status: 'error', error: errorMessage(err) });
        }
        return undefined;
      } finally {
        if (isCurrent()) current = null;
        if (current === null && analysisSuspended) {
          analysisSuspended = false;
          // Unless the user re-enabled it in the meantime.
          if (!useAnalysisStore.getState().enabled) useAnalysisStore.getState().setEnabled(true);
        }
      }
    })();

    current = {
      token: my,
      cancel: () => {
        cancelled = true;
        run?.cancel();
      },
      promise,
    };
    return promise;
  },

  cancel: () => current?.cancel(),

  reset: () => {
    const c = current;
    current = null;
    if (c) {
      c.cancel();
      settling = c.promise;
    }
    set({
      status: 'idle',
      progress: { done: 0, total: 0 },
      summary: undefined,
      moveDetails: {},
      error: undefined,
      autoNotice: false,
    });
  },

  dismissAutoNotice: () => set({ autoNotice: false }),
}));
