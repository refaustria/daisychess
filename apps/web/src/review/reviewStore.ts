import type { Engine, ReviewSummary } from '@daisychess/engine-core';
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
  type PositionResult,
} from './BatchAnalyzer';
import { buildMoveDetails, type MoveDetails } from './details';
import {
  clearReviewCache,
  covers,
  gameKey,
  getStoredPositions,
  getStoredReview,
  MIN_CACHED_PLIES,
  positionId,
  putStoredPositions,
  putStoredReview,
  REVIEW_CACHE_VERSION,
  type ReviewPreset,
  type StoredReview,
  type StoredReviewSource,
} from './reviewCache';
import { ServerReviewEngine, type RemoteReviewClient } from './serverReviewEngine';
import {
  fetchServerPositions,
  fetchServerReview,
  serverStoreAvailable,
  storeServerPositions,
  storeServerReview,
} from './serverReviewStore';
import { browserEnginePool, PooledEngine, type PoolLease } from '../engine/wasmPool';
import { isRetryableEngineError, wasmHealth } from '../engine/wasmHealth';

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

/** The stored review (ADR-016) behind the shown result: loaded from the cache or just written. */
export interface StoredReviewInfo {
  preset: ReviewPreset;
  createdAt: number;
  engine: ReviewEngineInfo;
  /** True when the result was loaded from the cache (no engine ran). */
  fromCache: boolean;
  /** Where the record came from: this browser's cache or the server store (ADR-017). */
  source: StoredReviewSource;
}

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
  /**
   * The game store's `moves` array the current/last run reviews (identity: still the same array
   * means the review belongs to the game on the board, e.g. for the Play tab's Review button).
   */
  reviewed?: GameState['moves'];
  /** Set when the shown result is stored in the review cache (see {@link StoredReviewInfo}). */
  stored?: StoredReviewInfo;
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
   *
   * Review cache (ADR-016/017): when a review of this game with the same or a stronger preset is
   * stored (deep ≥ fast) — in this browser or on the server — it is shown instead (status `done`,
   * `stored.fromCache`) and no engine is used; the store never enters `running` for it. A finished
   * preset run is stored (locally, and on the server for token holders); the analysed positions of
   * every run (also cancelled/failed) are persisted and reused by later runs with the same or a
   * weaker budget, positions missing locally are fetched from the server before a run.
   */
  start(options?: ReviewOptions, meta?: StartMeta): Promise<ReviewSummary | undefined>;
  /**
   * Shows the stored review of the current game, if there is one (any preset). Never runs an
   * engine; does nothing while a review runs or when the shown review already belongs to the game.
   * Resolves true when a stored review is now shown.
   */
  loadCached(): Promise<boolean>;
  cancel(): void;
  /** Cancels a running review and returns to `idle`. The position cache is kept. */
  reset(): void;
  dismissAutoNotice(): void;
}

export type ReviewStore = ReviewState & ReviewActions;

/** Engine factory: returns an engine with a `load()` the pool calls once (lazily). */
export type CreateReviewEngine = () => Engine | Promise<Engine>;
/** Server client factory (one dedicated connection + session per review run); not loaded yet. */
export type CreateServerReviewClient = () => RemoteReviewClient | Promise<RemoteReviewClient>;

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
    clientInfo: { name: 'daisychess-web-review' },
  });
};

/** Upper bound for positions (FENs) kept in memory (least recently used dropped first). */
export const MAX_CACHED_POSITIONS = 5000;

/** `null`: no engine server configured (`auto` then silently uses the browser). */
let createServerClient: CreateServerReviewClient | null = createRemoteClient;
/** One analysed position for one search budget. */
interface CachedPosition {
  optionsKey: string;
  result: PositionResult;
}
/** FEN → results per budget (at most one per options key); Map order = least recently used first. */
const positions = new Map<string, CachedPosition[]>();
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
 * Replaces the browser engine factory of the shared pool (tests). Without a second argument the
 * server is treated as not configured, so a review never touches the network. Disposes the
 * current browser engine.
 */
export function setReviewEngineFactory(
  factory: CreateReviewEngine,
  server: CreateServerReviewClient | null = null,
): void {
  createServerClient = server;
  current?.cancel();
  browserEnginePool.setFactory(factory);
}

/**
 * Disposes the shared browser engine (also when a drill or game holds it) and forgets all cached
 * positions and server failures (tests, teardown).
 */
export async function disposeReviewEngine(): Promise<void> {
  current?.cancel();
  positions.clear();
  serverFailures.clear();
  await browserEnginePool.dispose();
}

/** True when an engine server is configured (the review/drill can fall back to it). */
export function serverConfigured(): boolean {
  return createServerClient !== null;
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
  /** Set for a browser run: the lease of the shared engine, released when the run ends. */
  lease?: PoolLease;
  notice?: string;
}

const BROWSER: ReviewEngineInfo = { kind: 'browser' };

/** The shared browser engine for one run (waits while a drill check or engine move holds it). */
async function browserEngine(notice?: string, signal?: AbortSignal): Promise<Selected> {
  const lease = await browserEnginePool.acquire('review', signal ? { signal } : {});
  return { engine: lease.engine, runsOn: BROWSER, lease, ...(notice ? { notice } : {}) };
}

/** The browser engine is disabled for this session (its degraded retry failed too; ADR-015). */
export const browserEngineDisabled = (): boolean => wasmHealth().disabled !== undefined;

export const BROWSER_UNAVAILABLE_NOTICE = 'Browser engine unavailable — reviewing on the server';

/**
 * Picks the engine for one run (ADR-014): the server (a fresh dedicated session) for `server`,
 * and for `auto` unless it failed within {@link SERVER_RETRY_COOLDOWN_MS}; otherwise, or when the
 * handshake fails, the cached browser engine with a notice (none in `auto` when the server only
 * refused the token). `browser` never touches the network.
 */
async function selectEngine(
  pref: ReviewEnginePreference,
  browser: (notice?: string) => Promise<Selected> = browserEngine,
  trace: { server: boolean } = { server: false },
): Promise<Selected> {
  const factory = createServerClient;
  if (pref === 'browser') return browser();
  if (!factory) {
    return browser(pref === 'server' ? fallbackNotice('no server configured') : undefined);
  }
  const key = serverKey();
  const failed = serverFailures.get(key);
  if (pref === 'auto' && failed && failed.until > Date.now()) {
    return browser(noticeFor(pref, failed.reason, failed.silent));
  }
  let server: ServerReviewEngine | null = null;
  trace.server = true;
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
    return browser(noticeFor(pref, reason, isUnauthorized(err)));
  }
}

/** An engine for short searches outside the review (openings drill), see {@link openSearchEngine}. */
export interface SearchEngineLease {
  engine: Engine;
  runsOn: ReviewEngineInfo;
  /** Fallback notice (same texts as the review's). */
  notice?: string;
  /** Releases the server session or terminates the browser engine. Idempotent. */
  dispose(): Promise<void>;
}

export interface OpenSearchEngineOptions {
  /** The browser path waits while another user (the review) holds the shared engine. */
  onWait?: (waiting: boolean) => void;
}

/**
 * Picks an engine exactly like the review does (ADR-014: setting `reviewEngine`, server URL and
 * token, handshake as probe, 60 s failure cooldown in `auto`). The server path opens its own
 * session. The browser path shares the review's pooled browser engine (ADR-015): each search
 * leases it and gives it back, so it waits while a review runs (`onWait`) and never adds a WASM
 * instance. The caller owns the lease and must `dispose()` it. A server that fails mid-use should
 * be reported with {@link reportSearchServerFailure} before falling back to
 * `openSearchEngine('browser')`.
 */
export async function openSearchEngine(
  pref: ReviewEnginePreference = useSettingsStore.getState().reviewEngine,
  opts: OpenSearchEngineOptions = {},
): Promise<SearchEngineLease> {
  const pooledBrowser = async (notice?: string): Promise<Selected> => ({
    engine: new PooledEngine(browserEnginePool, {
      purpose: 'drill',
      ...(opts.onWait ? { onWait: (waiting: boolean) => opts.onWait?.(waiting) } : {}),
    }),
    runsOn: BROWSER,
    ...(notice ? { notice } : {}),
  });
  const selected = await selectEngine(pref, pooledBrowser);
  let disposed = false;
  return {
    engine: selected.engine,
    runsOn: selected.runsOn,
    ...(selected.notice ? { notice: selected.notice } : {}),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await selected.engine.dispose().catch(() => undefined);
    },
  };
}

/**
 * Remembers a server failure of a {@link openSearchEngine} lease (cooldown in `auto`) and returns
 * the fallback notice to show for `pref` (undefined: silent fallback).
 */
export function reportSearchServerFailure(
  err: unknown,
  pref: ReviewEnginePreference = useSettingsStore.getState().reviewEngine,
): string | undefined {
  const reason = serverFailureReason(err, true);
  rememberFailure(serverKey(), reason, isUnauthorized(err));
  return noticeFor(pref, reason, isUnauthorized(err));
}

export const optionsKey = (o: BatchOptions): string =>
  o.movetime !== undefined ? `mt:${o.movetime}` : `d:${o.depth ?? DEFAULT_REVIEW_DEPTH}`;

/**
 * True when a result searched with budget `key` serves a search with `o`: the same budget; for a
 * movetime a movetime at least as long; for a depth a depth limit at least as deep or a result
 * that reached that depth (e.g. a Fast run on the server often reaches depth 20+).
 */
export function satisfies(key: string, result: PositionResult, o: BatchOptions): boolean {
  if (key === optionsKey(o)) return true;
  const mt = key.startsWith('mt:') ? Number(key.slice(3)) : undefined;
  const depthLimit = key.startsWith('d:') ? Number(key.slice(2)) : undefined;
  if (o.movetime !== undefined) return mt !== undefined && mt >= o.movetime;
  const d = o.depth ?? DEFAULT_REVIEW_DEPTH;
  return (depthLimit !== undefined && depthLimit >= d) || (result.depth ?? 0) >= d;
}

function addPosition(fen: string, key: string, result: PositionResult): void {
  const list = positions.get(fen) ?? [];
  const i = list.findIndex((e) => e.optionsKey === key);
  if (i >= 0) list[i] = { optionsKey: key, result };
  else list.push({ optionsKey: key, result });
  positions.delete(fen);
  positions.set(fen, list);
}

function prunePositions(): void {
  const excess = positions.size - MAX_CACHED_POSITIONS;
  if (excess <= 0) return;
  let i = 0;
  for (const k of positions.keys()) {
    if (i++ >= excess) break;
    positions.delete(k);
  }
}

/** Merges the persisted positions of `fens` into memory (entries in memory win). */
async function loadPersistedPositions(fens: readonly string[]): Promise<void> {
  for (const p of await getStoredPositions(fens)) {
    const list = positions.get(p.fen);
    if (!list?.some((e) => e.optionsKey === p.optionsKey))
      addPosition(p.fen, p.optionsKey, p.result);
  }
}

/** True when some position in memory satisfies budget `o` for `fen`. */
const hasSatisfying = (fen: string, o: BatchOptions): boolean =>
  (positions.get(fen) ?? []).some((e) => satisfies(e.optionsKey, e.result, o));

/**
 * Fetches from the server store (ADR-017) the positions of `fens` that have no result in memory
 * satisfying `o`: for the run's own budget key and, for a depth run, also for the Fast preset
 * (its results often reached the depth already). Entries in memory win; silent on any failure.
 */
async function loadServerPositions(fens: readonly string[], o: BatchOptions): Promise<void> {
  if (!serverStoreAvailable()) return;
  const missing = [...new Set(fens)].filter((fen) => !hasSatisfying(fen, o));
  if (missing.length === 0) return;
  const key = optionsKey(o);
  const keys = [key];
  const fastKey = optionsKey(normalize(REVIEW_PRESETS.fast));
  if (o.movetime === undefined && fastKey !== key) keys.push(fastKey);
  for (const p of await fetchServerPositions(keys, missing)) {
    const list = positions.get(p.fen);
    if (!list?.some((e) => e.optionsKey === p.optionsKey))
      addPosition(p.fen, p.optionsKey, p.result);
  }
}

/**
 * The per-run cache for the analyzer: every position of the game that has a result satisfying
 * `o` (the same budget first, else the deepest). `seeded` remembers what came from elsewhere.
 */
function runCache(
  fens: readonly string[],
  o: BatchOptions,
): { cache: PositionCache; seeded: Map<string, PositionResult> } {
  const key = optionsKey(o);
  const cache: PositionCache = new Map();
  const seeded = new Map<string, PositionResult>();
  for (const fen of fens) {
    const list = positions.get(fen);
    if (!list) continue;
    const ok = list.filter((e) => satisfies(e.optionsKey, e.result, o));
    if (ok.length === 0) continue;
    const pick =
      ok.find((e) => e.optionsKey === key) ??
      ok.reduce((a, b) => ((b.result.depth ?? 0) > (a.result.depth ?? 0) ? b : a));
    cache.set(fen, pick.result);
    seeded.set(fen, pick.result);
    positions.delete(fen);
    positions.set(fen, list);
  }
  return { cache, seeded };
}

/**
 * Takes the positions searched by a run into memory, persists the run's positions and offers the
 * newly searched ones to the server store (token holders; silent).
 */
function absorbRun(
  fens: readonly string[],
  o: BatchOptions,
  run: { cache: PositionCache; seeded: Map<string, PositionResult> },
): void {
  const key = optionsKey(o);
  const fresh: { fen: string; result: PositionResult }[] = [];
  for (const [fen, result] of run.cache) {
    if (run.seeded.get(fen) !== result) {
      addPosition(fen, key, result);
      fresh.push({ fen, result });
    }
  }
  if (fresh.length > 0) void storeServerPositions(key, fresh);
  const usedAt = Date.now();
  const entries = [...new Set(fens)].flatMap((fen) =>
    (positions.get(fen) ?? []).map((e) => ({
      id: positionId(e.optionsKey, fen),
      fen,
      optionsKey: e.optionsKey,
      result: e.result,
      usedAt,
      version: REVIEW_CACHE_VERSION,
    })),
  );
  prunePositions();
  void putStoredPositions(entries);
}

/** `fast` / `deep` when `o` is one of {@link REVIEW_PRESETS}; custom budgets are not cached. */
export function presetOf(o: ReviewOptions): ReviewPreset | undefined {
  const key = optionsKey(normalize(o));
  for (const p of ['fast', 'deep'] as const) {
    if (optionsKey(normalize(REVIEW_PRESETS[p])) === key) return p;
  }
  return undefined;
}

const keyOfGame = (game: BatchGame): string =>
  gameKey(
    game.startFen,
    game.moves.map((m) => m.uci),
  );

/** Guards against key collisions: the stored record really is this game. */
const sameGame = (r: StoredReview, game: BatchGame): boolean =>
  r.startFen === game.startFen &&
  r.moves.length === game.moves.length &&
  r.moves.every((san, i) => game.moves[i]!.san === san);

/** Store state showing the stored review `r` of the game `moves`. */
function storedState(
  r: StoredReview,
  moves: GameState['moves'],
  trigger: ReviewTrigger,
  source: StoredReviewSource,
): Partial<ReviewState> {
  const total = r.moves.length + 1;
  return {
    status: 'done',
    progress: { done: total, total },
    summary: r.summary,
    moveDetails: r.moveDetails,
    error: undefined,
    options: { ...r.options },
    runsOn: r.engine,
    engineNotice: undefined,
    trigger,
    // A stored Deep review needs no "run Deep" hint.
    autoNotice: trigger === 'auto' && r.preset === 'fast',
    reviewed: moves,
    stored: { preset: r.preset, createdAt: r.createdAt, engine: r.engine, fromCache: true, source },
  };
}

/** A stored review found locally or on the server. */
interface Found {
  review: StoredReview;
  source: StoredReviewSource;
}

/**
 * The stored review of `game` (any preset): this browser's cache first, then the server store
 * (ADR-017). A server hit is written to the local cache so the next load is local.
 */
async function findStored(game: BatchGame, key: string): Promise<Found | undefined> {
  const local = await getStoredReview(key);
  if (local && sameGame(local, game)) return { review: local, source: 'local' };
  const remote = await fetchServerReview(game, key);
  if (!remote || !sameGame(remote, game)) return undefined;
  void putStoredReview(remote);
  return { review: remote, source: 'server' };
}

/**
 * Clears the review cache (stored reviews and positions, also those kept in memory). The shown
 * review stays but no longer counts as stored (Start is enabled again).
 */
export async function clearReviewCaches(): Promise<void> {
  positions.clear();
  await clearReviewCache();
  if (useReviewStore.getState().stored) useReviewStore.setState({ stored: undefined });
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
    const preset = presetOf(options);
    const reviewed = useGameStore.getState().moves;
    const game = gameToBatch(useGameStore.getState());
    const fens = [game.startFen, ...game.moves.map((m) => m.fenAfter)];
    const key = preset && game.moves.length >= MIN_CACHED_PLIES ? keyOfGame(game) : undefined;
    const trigger: ReviewTrigger = meta?.auto ? 'auto' : 'manual';

    // The shown result already is a stored review of this game, as strong as requested: no-op.
    const shown = get();
    if (
      key &&
      preset &&
      shown.status === 'done' &&
      shown.reviewed === reviewed &&
      covers(shown.stored?.preset, preset)
    ) {
      return Promise.resolve(shown.summary);
    }

    const my = ++token;
    const total = game.moves.length + 1;
    let cancelled = false;
    const aborter = new AbortController();
    let run: { cancel(): void } | null = null;
    let selected: Selected | null = null;
    const isCurrent = (): boolean => current?.token === my;

    /** The stored review of this game (local, then server), if it makes this run unnecessary. */
    const lookup = async (): Promise<Found | undefined> => {
      if (!key || !preset) return undefined;
      const found = await findStored(game, key).catch(() => undefined);
      return found && covers(found.review.preset, preset) ? found : undefined;
    };
    const showStored = (f: Found): ReviewSummary => {
      if (isCurrent()) set(storedState(f.review, reviewed, trigger, f.source));
      return f.review.summary;
    };

    const begin = (): void => {
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
        trigger,
        autoNotice: meta?.auto === true,
        reviewed,
        stored: undefined,
      });
    };

    const engineRun = async (): Promise<ReviewSummary | undefined> => {
      try {
        // A reset run may still be stopping its search; never overlap two runs on the engine.
        await settling;
        await loadPersistedPositions(fens).catch(() => undefined);
        if (cancelled) throw abortError();
        // Positions other devices analysed (server store); silent when there is no server.
        await loadServerPositions(fens, batchOptions).catch(() => undefined);
        if (cancelled) throw abortError();
        const pref = useSettingsStore.getState().reviewEngine;
        const trace = { server: false };
        const browser = (notice?: string) => browserEngine(notice, aborter.signal);
        // The browser engine failed for good (ADR-015): the server once, if configured and allowed.
        const serverInstead = async (err: unknown): Promise<Selected> => {
          if (pref === 'browser' || trace.server || !createServerClient || !browserEngineDisabled())
            throw err;
          const s = await selectEngine('server', () => Promise.reject(err), trace);
          return { ...s, notice: s.notice ?? BROWSER_UNAVAILABLE_NOTICE };
        };
        selected = await selectEngine(pref, browser, trace).catch(serverInstead);
        if (cancelled) throw abortError();
        if (isCurrent()) set({ runsOn: selected.runsOn, engineNotice: selected.notice });
        const forRun = runCache(fens, batchOptions);
        const cache = forRun.cache;
        let recreated = false;
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
              if (cancelled || isAbortError(err)) throw err;
              const server = selected.server;
              if (!server) {
                // The browser engine failed: never hand it to the next user. Out of memory → one
                // fresh (degraded, single-threaded) instance; disabled → the server, if allowed.
                const lease = selected.lease;
                const notice = selected.notice;
                selected = null;
                lease?.release({ broken: true });
                if (isRetryableEngineError(err) && !recreated) {
                  recreated = true;
                  selected = await browser(notice);
                } else {
                  selected = await serverInstead(err);
                  if (isCurrent()) set({ runsOn: selected.runsOn, engineNotice: selected.notice });
                }
                if (cancelled) throw abortError();
                continue;
              }
              // The server dropped mid-review: finish on the browser engine. Positions analysed so
              // far stay in `cache` (same key for both engines), so only the rest is searched.
              selected = null; // disposed here, not again in `finally`
              void server.dispose().catch(() => undefined);
              const reason = serverFailureReason(err, true);
              rememberFailure(serverKey(), reason, isUnauthorized(err));
              const notice = noticeFor(pref, reason, isUnauthorized(err));
              if (isCurrent()) set({ runsOn: BROWSER, engineNotice: notice });
              selected = await browser(notice);
              if (cancelled) throw abortError();
              continue;
            }
            const moveDetails = details(summary);
            let stored: StoredReviewInfo | undefined;
            if (key && preset) {
              const createdAt = Date.now();
              const engine = selected.runsOn;
              stored = { preset, createdAt, engine, fromCache: false, source: 'local' };
              const record: StoredReview = {
                gameKey: key,
                startFen: game.startFen,
                moves: game.moves.map((m) => m.san),
                preset,
                options:
                  batchOptions.movetime !== undefined
                    ? { movetime: batchOptions.movetime }
                    : { depth: batchOptions.depth ?? DEFAULT_REVIEW_DEPTH },
                summary,
                moveDetails,
                engine,
                createdAt,
                version: REVIEW_CACHE_VERSION,
              };
              void putStoredReview(record);
              // Shared with every device (ADR-017); token holders only, failures ignored.
              void storeServerReview(record);
            }
            if (isCurrent())
              set({
                status: 'done',
                summary,
                moveDetails,
                progress: { done: total, total },
                stored,
              });
            return summary;
          }
        } finally {
          // Also after a cancel or failure: what was searched stays available.
          absorbRun(fens, batchOptions, forRun);
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
        // The shared browser engine stays loaded for the next user (idle disposal in the pool).
        selected?.lease?.release();
        if (isCurrent()) current = null;
        if (current === null && analysisSuspended) {
          analysisSuspended = false;
          // Unless the user re-enabled it in the meantime.
          if (!useAnalysisStore.getState().enabled) useAnalysisStore.getState().setEnabled(true);
        }
      }
    };

    let promise: Promise<ReviewSummary | undefined>;
    if (key && preset) {
      // A preset review of a cacheable game: look it up (this browser, then the server) before
      // anything runs, so a stored review never shows a progress bar or leases an engine. The
      // local index answers at once when it knows the game; otherwise the lookup costs one
      // IndexedDB read and, with a server, one round trip (or nothing during its cooldown).
      promise = (async () => {
        const stored = await lookup();
        if (cancelled || !isCurrent()) {
          if (isCurrent()) current = null;
          return undefined;
        }
        if (stored) {
          const summary = showStored(stored);
          current = null;
          return summary;
        }
        begin();
        return engineRun();
      })();
    } else {
      begin();
      promise = engineRun();
    }

    current = {
      token: my,
      cancel: () => {
        cancelled = true;
        aborter.abort();
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
      reviewed: undefined,
      stored: undefined,
    });
  },

  loadCached: async () => {
    if (current) return false;
    const moves = useGameStore.getState().moves;
    if (moves.length < MIN_CACHED_PLIES) return false;
    const belongs = (): boolean => {
      const s = get();
      return s.status === 'done' && s.reviewed === moves;
    };
    if (belongs()) return false;
    const game = gameToBatch(useGameStore.getState());
    const found = await findStored(game, keyOfGame(game)).catch(() => undefined);
    if (!found) return false;
    // Still the same game, nothing started meanwhile.
    if (current || useGameStore.getState().moves !== moves || belongs()) return false;
    set(storedState(found.review, moves, 'manual', found.source));
    return true;
  },

  dismissAutoNotice: () => set({ autoNotice: false }),
}));
