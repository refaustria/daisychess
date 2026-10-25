import type { Engine, ReviewSummary } from '@chesslab/engine-core';
import { create } from 'zustand';
import { UNAUTHORIZED_MESSAGE, useAnalysisStore } from '../store/analysisStore';
import { useGameStore, type GameState } from '../store/gameStore';
import { useSettingsStore, type ReviewEnginePreference } from '../store/settingsStore';
import {
  abortError,
  BatchAnalyzer,
  DEFAULT_REVIEW_DEPTH,
  isAbortError,
  type BatchGame,
  type BatchOptions,
  type BatchRun,
  type PositionCache,
} from './BatchAnalyzer';
import { buildMoveDetails, type MoveDetails } from './details';
import { ServerReviewEngine, type RemoteReviewClient } from './serverReviewEngine';

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

/** Where the current/last review runs (ADR-014). */
export interface ReviewEngineInfo {
  kind: 'server' | 'browser';
  /** Server engine name, e.g. "Stockfish 19". */
  name?: string;
  /** Threads per search on the server. */
  threads?: number;
}

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
  /** Engine of the current/last run; undefined while it is being chosen (server handshake). */
  runsOn?: ReviewEngineInfo;
  /** One-line notice when the server could not be used (fallback to the browser). */
  engineNotice?: string;
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
/** Server client factory (one dedicated connection + session per review run); not loaded yet. */
export type CreateServerReviewClient = () => RemoteReviewClient | Promise<RemoteReviewClient>;

const createWasmEngine: CreateReviewEngine = async () => {
  const { WasmEngineClient } = await import('../engine/WasmEngineClient');
  return new WasmEngineClient();
};

/** Handshake budget of the review's server connection (it doubles as the probe). */
export const REVIEW_HANDSHAKE_TIMEOUT_MS = 5_000;
/** In `auto` mode a failed server is not tried again for this long (same URL and token). */
export const SERVER_RETRY_COOLDOWN_MS = 60_000;

/** The engine server of the analysis settings (same URL and token as the live server engines). */
const createRemoteClient: CreateServerReviewClient = async () => {
  const { RemoteEngineClient } = await import('../engine/RemoteEngineClient');
  const url = useAnalysisStore.getState().settings.remoteUrl;
  const token = useSettingsStore.getState().serverToken;
  return new RemoteEngineClient({
    ...(url ? { url } : {}),
    ...(token ? { token } : {}),
    handshakeTimeoutMs: REVIEW_HANDSHAKE_TIMEOUT_MS,
    clientInfo: { name: 'chesslab-web-review' },
  });
};

/** Upper bound for cached positions per options key (oldest entries are dropped first). */
export const MAX_CACHED_POSITIONS = 5000;

let createEngine: CreateReviewEngine = createWasmEngine;
/** `null`: no engine server configured (`auto` then silently uses the browser). */
let createServerClient: CreateServerReviewClient | null = createRemoteClient;
let enginePromise: Promise<Engine> | null = null;
let engine: Engine | null = null;
const caches = new Map<string, PositionCache>();
/** Recent server failures (auto mode cooldown), keyed by server URL + token. */
const serverFailures = new Map<string, { until: number; reason: string; silent: boolean }>();
let current: { token: number; cancel(): void; promise: Promise<ReviewSummary | undefined> } | null =
  null;
let token = 0;
/** Promise of a run that was reset but may still be stopping the engine. */
let settling: Promise<unknown> = Promise.resolve();
/** True while the live analysis is disabled by the review store. */
let analysisSuspended = false;

/**
 * Replaces the browser engine factory (tests). Without a second argument the server is treated
 * as not configured, so a review never touches the network. Disposes the current engine.
 */
export function setReviewEngineFactory(
  factory: CreateReviewEngine,
  server: CreateServerReviewClient | null = null,
): void {
  createEngine = factory;
  createServerClient = server;
  void disposeReviewEngine();
}

/** Disposes the review engine and forgets all cached positions and server failures (tests, teardown). */
export async function disposeReviewEngine(): Promise<void> {
  current?.cancel();
  const e = engine;
  engine = null;
  enginePromise = null;
  caches.clear();
  serverFailures.clear();
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

/** Short reason for the fallback notice (protocol code → words). */
export function serverFailureReason(err: unknown, midRun = false): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'unauthorized') return UNAUTHORIZED_MESSAGE;
  if (code === 'closed') return midRun ? 'connection lost' : 'not reachable';
  if (code === 'timeout') return 'no response';
  if (code === 'no_capacity' || code === 'limit_exceeded') return 'too many sessions, busy';
  if (code === 'engine_crashed') return 'engine crashed';
  if (code === 'unknown_engine') return 'no engine available';
  return err instanceof Error ? err.message : String(err);
}

export const fallbackNotice = (reason: string): string =>
  `Server unavailable (${reason}) — reviewing in the browser`;

const serverKey = (): string =>
  `${useAnalysisStore.getState().settings.remoteUrl ?? ''}\n${useSettingsStore.getState().serverToken}`;

/** `auto` falls back silently when the server only refuses the (missing/wrong) token. */
const isUnauthorized = (err: unknown): boolean =>
  (err as { code?: unknown } | null)?.code === 'unauthorized';

function rememberFailure(key: string, reason: string, silent: boolean): void {
  serverFailures.set(key, { until: Date.now() + SERVER_RETRY_COOLDOWN_MS, reason, silent });
}

/** Fallback notice for `pref`, or undefined (auto + unauthorized: silent fallback). */
const noticeFor = (pref: ReviewEnginePreference, reason: string, silent: boolean) =>
  pref === 'auto' && silent ? undefined : fallbackNotice(reason);

interface Selected {
  engine: Engine;
  runsOn: ReviewEngineInfo;
  /** Set for a server run: disposed (session released) when the run ends or falls back. */
  server?: ServerReviewEngine;
  notice?: string;
}

const BROWSER: ReviewEngineInfo = { kind: 'browser' };

async function browserEngine(notice?: string): Promise<Selected> {
  return { engine: await getEngine(), runsOn: BROWSER, ...(notice ? { notice } : {}) };
}

/**
 * Picks the engine for one run (ADR-014): the server (a fresh dedicated session) for `server`,
 * and for `auto` unless it failed within {@link SERVER_RETRY_COOLDOWN_MS}; otherwise, or when the
 * handshake fails, the cached browser engine with a notice (none in `auto` when the server only
 * refused the token). `browser` never touches the network.
 */
async function selectEngine(pref: ReviewEnginePreference): Promise<Selected> {
  const factory = createServerClient;
  if (pref === 'browser') return browserEngine();
  if (!factory) {
    return browserEngine(pref === 'server' ? fallbackNotice('no server configured') : undefined);
  }
  const key = serverKey();
  const failed = serverFailures.get(key);
  if (pref === 'auto' && failed && failed.until > Date.now()) {
    return browserEngine(noticeFor(pref, failed.reason, failed.silent));
  }
  let server: ServerReviewEngine | null = null;
  try {
    server = new ServerReviewEngine(await factory());
    await server.load();
    serverFailures.delete(key);
    return {
      engine: server,
      server,
      runsOn: {
        kind: 'server',
        ...(server.engineName ? { name: server.engineName } : {}),
        ...(server.threads !== undefined ? { threads: server.threads } : {}),
      },
    };
  } catch (err) {
    if (server) void server.dispose().catch(() => undefined);
    const reason = serverFailureReason(err);
    rememberFailure(key, reason, isUnauthorized(err));
    return browserEngine(noticeFor(pref, reason, isUnauthorized(err)));
  }
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
      runsOn: undefined,
      engineNotice: undefined,
      trigger: meta?.auto ? 'auto' : 'manual',
      autoNotice: meta?.auto === true,
    });

    let cancelled = false;
    let run: { cancel(): void } | null = null;
    let selected: Selected | null = null;
    const isCurrent = (): boolean => current?.token === my;

    const promise = (async (): Promise<ReviewSummary | undefined> => {
      try {
        // A reset run may still be stopping its search; never overlap two runs on the engine.
        await settling;
        const pref = useSettingsStore.getState().reviewEngine;
        selected = await selectEngine(pref);
        if (cancelled) throw abortError();
        if (isCurrent()) set({ runsOn: selected.runsOn, engineNotice: selected.notice });
        const cache = cacheFor(optionsKey(batchOptions));
        try {
          for (;;) {
            const analyzer = new BatchAnalyzer({
              engine: selected.engine,
              options: batchOptions,
              cache,
            });
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
            let summary: ReviewSummary;
            try {
              summary = await r.promise;
            } catch (err) {
              const server = selected.server;
              if (!server || cancelled || isAbortError(err)) throw err;
              // The server dropped mid-review: finish on the browser engine. Positions analysed so
              // far stay in `cache` (same key for both engines), so only the rest is searched.
              selected = null; // disposed here, not again in `finally`
              void server.dispose().catch(() => undefined);
              const reason = serverFailureReason(err, true);
              rememberFailure(serverKey(), reason, isUnauthorized(err));
              const notice = noticeFor(pref, reason, isUnauthorized(err));
              if (isCurrent()) set({ runsOn: BROWSER, engineNotice: notice });
              selected = await browserEngine(notice);
              if (cancelled) throw abortError();
              continue;
            }
            if (isCurrent())
              set({
                status: 'done',
                summary,
                moveDetails: details(summary),
                progress: { done: total, total },
              });
            return summary;
          }
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
        // The review's server session is per run: release it (and its per-address slot) so the
        // live server engines keep their quota between reviews.
        const server = selected?.server;
        if (server) await server.dispose().catch(() => undefined);
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
      runsOn: undefined,
      engineNotice: undefined,
    });
  },

  dismissAutoNotice: () => set({ autoNotice: false }),
}));
