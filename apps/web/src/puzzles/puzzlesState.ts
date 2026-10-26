/**
 * Local puzzle state (ADR-023 §7, §8, §10): localStorage `daisychess.puzzles`, version 1 —
 * the Glicko-2 puzzle rating, difficulty, the last filter, daily results and streak, rush bests
 * and the ring of seen puzzle ids. Parsed defensively (like the trainer schedule): invalid parts
 * fall back to their defaults, garbage yields the default state. Not mirrored to native
 * Preferences (the WebView's localStorage persists).
 *
 * Pure functions over {@link PuzzlesState} plus a small module-level holder
 * ({@link getPuzzlesState}, {@link updatePuzzlesState}, {@link subscribePuzzlesState}) so the
 * stores and `nextPuzzle` share one copy.
 */
import {
  GLICKO_DEFAULT,
  glicko2Update,
  type Difficulty,
  type Puzzle,
  type PuzzleFilter,
} from '@daisychess/puzzles';

export const PUZZLES_KEY = 'daisychess.puzzles';
export const PUZZLES_STATE_VERSION = 1;
/** Seen puzzle ids kept (ring, oldest dropped). */
export const MAX_SEEN = 5000;
/** Daily results kept (most recent dates). */
export const MAX_DAILY_RESULTS = 60;
/** Longest accepted id / filter value (anything longer is garbage). */
const MAX_TEXT = 120;

export type DailyResult = 'solved' | 'failed';
export type RushDuration = 3 | 5;

export interface PuzzleRatingState {
  /** Glicko-2 rating, deviation, volatility. */
  r: number;
  rd: number;
  vol: number;
  /** Rated puzzles played. */
  n: number;
}

export interface PuzzlesState {
  v: typeof PUZZLES_STATE_VERSION;
  rating: PuzzleRatingState;
  difficulty: Difficulty;
  filter: PuzzleFilter;
  daily: {
    /** Consecutive UTC days solved, up to {@link PuzzlesState.daily.last}. */
    streak: number;
    /** Last date with a result (`YYYY-MM-DD`), or `''`. */
    last: string;
    /** Result per UTC date (≤ {@link MAX_DAILY_RESULTS}). */
    results: Record<string, DailyResult>;
  };
  rush: { best3: number; best5: number };
  /** Last seen puzzle ids, oldest first (≤ {@link MAX_SEEN}). */
  seen: string[];
}

export function defaultPuzzlesState(): PuzzlesState {
  return {
    v: PUZZLES_STATE_VERSION,
    rating: { r: GLICKO_DEFAULT.rating, rd: GLICKO_DEFAULT.rd, vol: GLICKO_DEFAULT.vol, n: 0 },
    difficulty: 'normal',
    filter: {},
    daily: { streak: 0, last: '', results: {} },
    rush: { best3: 0, best5: 0 },
    seen: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Parsing

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nonNegInt = (v: unknown): number => (finite(v) && v >= 0 ? Math.floor(v) : 0);
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT ? v : undefined;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseRating(v: unknown): PuzzleRatingState {
  const d = defaultPuzzlesState().rating;
  if (!isObj(v)) return d;
  const ok = finite(v.r) && v.r > 0 && v.r < 5000 && finite(v.rd) && v.rd > 0 && v.rd <= 350;
  const vol = finite(v.vol) && v.vol > 0 && v.vol < 1 ? v.vol : d.vol;
  return ok ? { r: v.r as number, rd: v.rd as number, vol, n: nonNegInt(v.n) } : d;
}

function parseDaily(v: unknown): PuzzlesState['daily'] {
  const out: PuzzlesState['daily'] = { streak: 0, last: '', results: {} };
  if (!isObj(v)) return out;
  out.streak = nonNegInt(v.streak);
  out.last = typeof v.last === 'string' && DATE.test(v.last) ? v.last : '';
  if (isObj(v.results)) {
    for (const [k, r] of Object.entries(v.results)) {
      if (DATE.test(k) && (r === 'solved' || r === 'failed')) out.results[k] = r;
    }
    out.results = trimResults(out.results);
  }
  if (!out.last) out.streak = 0;
  return out;
}

/** Parses the stored JSON defensively; garbage yields {@link defaultPuzzlesState}. */
export function parsePuzzlesState(raw: string | null): PuzzlesState {
  const state = defaultPuzzlesState();
  if (!raw) return state;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return state;
  }
  if (!isObj(v) || v.v !== PUZZLES_STATE_VERSION) return state;
  state.rating = parseRating(v.rating);
  if (v.difficulty === 'easier' || v.difficulty === 'normal' || v.difficulty === 'harder') {
    state.difficulty = v.difficulty;
  }
  if (isObj(v.filter)) {
    const theme = text(v.filter.theme);
    const opening = text(v.filter.opening);
    state.filter = { ...(theme ? { theme } : {}), ...(opening ? { opening } : {}) };
  }
  state.daily = parseDaily(v.daily);
  if (isObj(v.rush))
    state.rush = { best3: nonNegInt(v.rush.best3), best5: nonNegInt(v.rush.best5) };
  if (Array.isArray(v.seen)) {
    const ids = v.seen.filter((x): x is string => text(x) !== undefined);
    state.seen = [...new Set(ids)].slice(-MAX_SEEN);
  }
  return state;
}

export function serializePuzzlesState(state: PuzzlesState): string {
  return JSON.stringify({
    ...state,
    seen: state.seen.slice(-MAX_SEEN),
    daily: { ...state.daily, results: trimResults(state.daily.results) },
  });
}

// ---------------------------------------------------------------------------------------------
// Pure updates

/**
 * Settles one rated puzzle (ADR-023 §7): Glicko-2 against the puzzle's `rating`/`rd`,
 * `solved` = win. Unrated puzzles (no rating, e.g. mistake puzzles) leave the state unchanged.
 */
export function applyPuzzleResult(
  state: PuzzlesState,
  puzzle: Pick<Puzzle, 'rating' | 'rd'>,
  solved: boolean,
): PuzzlesState {
  if (puzzle.rating === undefined) return state;
  const next = glicko2Update(
    { rating: state.rating.r, rd: state.rating.rd, vol: state.rating.vol },
    [{ rating: puzzle.rating, rd: puzzle.rd ?? 350, score: solved ? 1 : 0 }],
  );
  return {
    ...state,
    rating: { r: next.rating, rd: next.rd, vol: next.vol, n: state.rating.n + 1 },
  };
}

/** Adds `id` to the end of the seen ring (moved to the end when present; ≤ {@link MAX_SEEN}). */
export function markSeen(state: PuzzlesState, id: string): PuzzlesState {
  if (state.seen[state.seen.length - 1] === id) return state;
  const seen = state.seen.filter((s) => s !== id);
  seen.push(id);
  return { ...state, seen: seen.length > MAX_SEEN ? seen.slice(-MAX_SEEN) : seen };
}

/** The seen ids as a set (for `choosePuzzle`). */
export const seenSet = (state: PuzzlesState): ReadonlySet<string> => new Set(state.seen);

const DAY_MS = 86_400_000;
function dateMs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}
const daysBetween = (a: string, b: string): number => Math.round((dateMs(b) - dateMs(a)) / DAY_MS);

function trimResults(results: Record<string, DailyResult>): Record<string, DailyResult> {
  const keys = Object.keys(results).sort();
  if (keys.length <= MAX_DAILY_RESULTS) return results;
  return Object.fromEntries(keys.slice(-MAX_DAILY_RESULTS).map((k) => [k, results[k]!]));
}

/**
 * Records the daily puzzle result for `date` (`YYYY-MM-DD`, UTC). Only the first result of a day
 * counts (retries are free). Solved continues the streak when the previous result was the day
 * before (else starts at 1); failed resets it to 0.
 */
export function recordDaily(state: PuzzlesState, date: string, result: DailyResult): PuzzlesState {
  if (!DATE.test(date) || state.daily.results[date]) return state;
  const d = state.daily;
  const consecutive = d.last !== '' && daysBetween(d.last, date) === 1;
  const streak = result === 'failed' ? 0 : consecutive ? d.streak + 1 : 1;
  const later = d.last !== '' && date < d.last;
  return {
    ...state,
    daily: {
      // A result for an older date (clock skew) is recorded but does not move the streak.
      streak: later ? d.streak : streak,
      last: later ? d.last : date,
      results: trimResults({ ...d.results, [date]: result }),
    },
  };
}

/** The streak as shown on `today` (`YYYY-MM-DD`): 0 when the last result is older than yesterday. */
export function dailyStreak(state: PuzzlesState, today: string): number {
  const d = state.daily;
  if (!d.last || !DATE.test(today)) return 0;
  const gap = daysBetween(d.last, today);
  return gap === 0 || gap === 1 ? d.streak : 0;
}

/** The last `n` daily results, oldest first. */
export function recentDailyResults(
  state: PuzzlesState,
  n = 30,
): Array<{ date: string; result: DailyResult }> {
  return Object.keys(state.daily.results)
    .sort()
    .slice(-n)
    .map((date) => ({ date, result: state.daily.results[date]! }));
}

/** Records a rush score; keeps the best per duration. */
export function recordRush(
  state: PuzzlesState,
  duration: RushDuration,
  score: number,
): PuzzlesState {
  const key = duration === 3 ? 'best3' : 'best5';
  const s = nonNegInt(score);
  if (s <= state.rush[key]) return state;
  return { ...state, rush: { ...state.rush, [key]: s } };
}

// ---------------------------------------------------------------------------------------------
// Storage and the shared holder

/** Minimal storage surface (localStorage in the app, a fake in tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export function loadPuzzlesState(storage: KeyValueStorage | undefined): PuzzlesState {
  try {
    return parsePuzzlesState(storage?.getItem(PUZZLES_KEY) ?? null);
  } catch {
    return defaultPuzzlesState(); // storage blocked
  }
}

export function savePuzzlesState(storage: KeyValueStorage | undefined, state: PuzzlesState): void {
  try {
    storage?.setItem(PUZZLES_KEY, serializePuzzlesState(state));
  } catch {
    // Storage full or blocked: the state lives on for this session only.
  }
}

function defaultStorage(): KeyValueStorage | undefined {
  try {
    return (globalThis as { localStorage?: KeyValueStorage }).localStorage;
  } catch {
    return undefined;
  }
}

let storageOverride: KeyValueStorage | null | undefined;
let current: PuzzlesState | null = null;
const listeners = new Set<(s: PuzzlesState) => void>();

const storage = (): KeyValueStorage | undefined =>
  storageOverride === undefined ? defaultStorage() : (storageOverride ?? undefined);

/**
 * Selects the storage (tests): a fake, `null` for none (memory only), `undefined` for
 * `localStorage`. Forgets the loaded state.
 */
export function configurePuzzlesStorage(s: KeyValueStorage | null | undefined): void {
  storageOverride = s;
  current = null;
}

/** The current state (loaded from storage on first use). */
export function getPuzzlesState(): PuzzlesState {
  return (current ??= loadPuzzlesState(storage()));
}

/** Applies `f`, saves and notifies the subscribers; returns the new state. */
export function updatePuzzlesState(f: (s: PuzzlesState) => PuzzlesState): PuzzlesState {
  const prev = getPuzzlesState();
  const next = f(prev);
  if (next === prev) return prev;
  current = next;
  savePuzzlesState(storage(), next);
  for (const l of listeners) l(next);
  return next;
}

/** "Reset puzzle rating and history": back to the defaults (stored). */
export function resetPuzzlesState(): PuzzlesState {
  return updatePuzzlesState(() => defaultPuzzlesState());
}

export function subscribePuzzlesState(listener: (s: PuzzlesState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
