import { create } from 'zustand';
import { getLichessToken, useLichessAuth } from '../lichess/auth';
import { currentFen, useGameStore, type GameState } from '../store/gameStore';
import {
  EXPLORER_MAX_PLY,
  ExplorerError,
  fetchExplorer,
  queryKey,
  RATINGS,
  SPEEDS,
  type ExplorerDb,
  type ExplorerFetch,
  type ExplorerQuery,
  type ExplorerResult,
  type RatingGroup,
  type Speed,
} from './client';

/**
 * Explorer state. While the panel is active (`setActive(true)`) the store follows the viewed
 * position of the game store: changes are debounced ({@link DEBOUNCE_MS}), stale requests are
 * aborted, and responses are cached per (db, filters, position) for the session (LRU).
 */

export const STORAGE_KEY = 'daisychess.explorer';
export const DEBOUNCE_MS = 300;
export const CACHE_SIZE = 200;
export const DEFAULT_SPEEDS: Speed[] = [...SPEEDS];
export const DEFAULT_RATINGS: RatingGroup[] = [1600, 1800, 2000, 2200, 2500];

export type ExplorerStatus =
  /** Inactive, or nothing requested yet. */
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error'
  /** The position is deeper than the explorer index (50 plies). */
  | 'too_deep';

export interface ExplorerErrorInfo {
  kind: ExplorerError['kind'];
  message: string;
  /** Seconds (rate_limited). */
  retryAfter?: number;
  /** True when the request carried a token. */
  withToken: boolean;
}

export interface ExplorerSettings {
  db: ExplorerDb;
  speeds: Speed[];
  ratings: RatingGroup[];
  /**
   * Pasted lichess personal API token (no scope), the fallback when not logged in with lichess.
   * Stored only in localStorage, sent only as a header. The login token wins (see `explorerToken`).
   */
  token: string;
}

export interface ExplorerState extends ExplorerSettings {
  active: boolean;
  status: ExplorerStatus;
  /** Key of the position/filters the status and data belong to. */
  key?: string;
  /** FEN of the explored position (for matching loaded games). */
  fen?: string;
  data?: ExplorerResult;
  error?: ExplorerErrorInfo;
}

export interface ExplorerActions {
  /** Start/stop following the game store. The panel calls this on mount/unmount. */
  setActive(active: boolean): void;
  setDb(db: ExplorerDb): void;
  setSpeeds(speeds: Speed[]): void;
  setRatings(ratings: RatingGroup[]): void;
  setToken(token: string): void;
  /** Re-request the current position now (skips debounce, bypasses a cached error). */
  refresh(): void;
}

export type ExplorerStore = ExplorerState & ExplorerActions;

// --- persistence -------------------------------------------------------------------------------

function readSettings(): ExplorerSettings {
  const defaults: ExplorerSettings = { db: 'masters', speeds: DEFAULT_SPEEDS, ratings: DEFAULT_RATINGS, token: '' };
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const v = JSON.parse(raw) as Partial<Record<keyof ExplorerSettings, unknown>>;
    const speeds = Array.isArray(v.speeds) ? SPEEDS.filter((s) => (v.speeds as unknown[]).includes(s)) : null;
    const ratings = Array.isArray(v.ratings) ? RATINGS.filter((r) => (v.ratings as unknown[]).includes(r)) : null;
    return {
      db: v.db === 'lichess' || v.db === 'masters' ? v.db : defaults.db,
      speeds: speeds && speeds.length > 0 ? speeds : defaults.speeds,
      ratings: ratings && ratings.length > 0 ? ratings : defaults.ratings,
      token: typeof v.token === 'string' ? v.token : '',
    };
  } catch {
    return defaults;
  }
}

function writeSettings(s: ExplorerSettings): void {
  try {
    const { db, speeds, ratings, token } = s;
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ db, speeds, ratings, token }));
  } catch {
    // storage unavailable (private mode): settings live for the session only
  }
}

// --- cache -------------------------------------------------------------------------------------

const cache = new Map<string, ExplorerResult>();

function cacheGet(key: string): ExplorerResult | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
  }
  return hit;
}

function cachePut(key: string, value: ExplorerResult): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// --- helpers -----------------------------------------------------------------------------------

/** Plies from the standard start, derived from the FEN's move number and side to move. */
export function plyOfFen(fen: string): number {
  const [, side, , , , full] = fen.split(' ');
  const n = Number(full);
  return (Number.isFinite(n) && n > 0 ? (n - 1) * 2 : 0) + (side === 'b' ? 1 : 0);
}

export function queryFor(g: Pick<GameState, 'startFen' | 'moves' | 'ply'>, s: ExplorerSettings): ExplorerQuery {
  const play = g.moves.slice(0, g.ply).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`);
  const q: ExplorerQuery = { db: s.db, fen: g.startFen, play };
  if (s.db === 'lichess') {
    // "All" is sent as no filter.
    if (s.speeds.length < SPEEDS.length) q.speeds = s.speeds;
    if (s.ratings.length < RATINGS.length) q.ratings = s.ratings;
  }
  return q;
}

// --- runtime (module state, not serialisable) ---------------------------------------------------

let fetchImpl: ExplorerFetch | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let inflight: AbortController | undefined;
let unsubscribe: (() => void) | undefined;
let unsubscribeAuth: (() => void) | undefined;
/** Requests are not sent before this time (after a 429). */
let blockedUntil = 0;
/** The explorer rejected an anonymous request: don't retry without a token. */
let anonymousRejected = false;

/** Test hook: inject fetch (undefined = global fetch). */
export function setExplorerFetch(f: ExplorerFetch | undefined): void {
  fetchImpl = f;
}

/** Test hook: clear cache and module state. */
export function resetExplorerRuntime(): void {
  cache.clear();
  clearTimers();
  inflight?.abort();
  inflight = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  unsubscribeAuth?.();
  unsubscribeAuth = undefined;
  blockedUntil = 0;
  anonymousRejected = false;
}

function clearTimers(): void {
  if (timer !== undefined) clearTimeout(timer);
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  timer = retryTimer = undefined;
}

/** Token for explorer requests: the lichess login's token, else the pasted one, else ''. */
export function explorerToken(pasted: string): string {
  return getLichessToken() ?? pasted.trim();
}

const settingsOf = (s: ExplorerState): ExplorerSettings => ({
  db: s.db,
  speeds: s.speeds,
  ratings: s.ratings,
  token: s.token,
});

export const useExplorerStore = create<ExplorerStore>()((set, get) => {
  /** Reacts to a position or settings change. `immediate` skips the debounce. */
  const update = (immediate: boolean, force = false): void => {
    const s = get();
    if (!s.active) return;
    const g = useGameStore.getState();
    const fen = currentFen(g);
    const q = queryFor(g, settingsOf(s));
    const key = queryKey(q);
    if (!force && key === s.key && s.status !== 'idle') return;

    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    inflight?.abort();
    inflight = undefined;

    if (plyOfFen(fen) > EXPLORER_MAX_PLY) {
      set({ key, fen, status: 'too_deep', data: undefined, error: undefined });
      return;
    }
    const hit = cacheGet(key);
    if (hit) {
      set({ key, fen, status: 'ready', data: hit, error: undefined });
      return;
    }
    if (!explorerToken(s.token) && anonymousRejected) {
      set({ key, fen, status: 'error', data: undefined, error: tokenRequired() });
      return;
    }
    set({ key, fen, status: 'loading', data: undefined, error: undefined });
    const wait = Math.max(immediate ? 0 : DEBOUNCE_MS, blockedUntil - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      void run(key, q);
    }, wait);
  };

  const run = async (key: string, q: ExplorerQuery): Promise<void> => {
    const ctrl = new AbortController();
    inflight = ctrl;
    const token = explorerToken(get().token);
    try {
      const data = await fetchExplorer(q, {
        signal: ctrl.signal,
        ...(token ? { token } : {}),
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
      });
      cachePut(key, data);
      if (ctrl.signal.aborted || get().key !== key) return;
      set({ status: 'ready', data, error: undefined });
    } catch (e) {
      if (ctrl.signal.aborted || get().key !== key) return;
      const err =
        e instanceof ExplorerError ? e : new ExplorerError('network', 'Could not reach the lichess explorer');
      if (err.kind === 'unauthorized' && !token) anonymousRejected = true;
      const info: ExplorerErrorInfo =
        err.kind === 'unauthorized' && !token
          ? tokenRequired()
          : { kind: err.kind, message: err.message, withToken: token !== '' };
      if (err.retryAfter !== undefined) info.retryAfter = err.retryAfter;
      set({ status: 'error', data: undefined, error: info });
      if (err.kind === 'rate_limited') {
        const secs = err.retryAfter ?? 60;
        blockedUntil = Date.now() + secs * 1000;
        if (retryTimer !== undefined) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          if (get().key === key && get().status === 'error') update(true, true);
        }, secs * 1000);
      }
    } finally {
      if (inflight === ctrl) inflight = undefined;
    }
  };

  const changeSettings = (patch: Partial<ExplorerSettings>): void => {
    set(patch);
    writeSettings(settingsOf(get()));
    update(false);
  };

  return {
    ...readSettings(),
    active: false,
    status: 'idle',

    setActive: (active) => {
      if (active === get().active) return;
      if (active) {
        set({ active: true });
        unsubscribe?.();
        unsubscribe = useGameStore.subscribe((g, prev) => {
          if (g.ply !== prev.ply || g.moves !== prev.moves || g.startFen !== prev.startFen) update(false);
        });
        // Logging in (or out) with lichess changes the token: retry a failed request with it.
        unsubscribeAuth?.();
        unsubscribeAuth = useLichessAuth.subscribe((a, prev) => {
          if (a.token === prev.token && a.status === prev.status) return;
          anonymousRejected = false;
          if (get().status === 'error') update(true, true);
        });
        update(true, true);
      } else {
        unsubscribe?.();
        unsubscribe = undefined;
        unsubscribeAuth?.();
        unsubscribeAuth = undefined;
        clearTimers();
        inflight?.abort();
        inflight = undefined;
        // Keep cached data visible next time via the cache; reset status so re-activation fetches.
        set({ active: false, status: 'idle', key: undefined });
      }
    },
    setDb: (db) => changeSettings({ db }),
    setSpeeds: (speeds) => changeSettings({ speeds: SPEEDS.filter((s) => speeds.includes(s)) }),
    setRatings: (ratings) => changeSettings({ ratings: RATINGS.filter((r) => ratings.includes(r)) }),
    setToken: (token) => {
      set({ token: token.trim() });
      writeSettings(settingsOf(get()));
      anonymousRejected = false;
      update(true, true);
    },
    refresh: () => update(true, true),
  };
});

function tokenRequired(): ExplorerErrorInfo {
  return {
    kind: 'unauthorized',
    message: 'The lichess explorer requires a lichess API token',
    withToken: false,
  };
}
