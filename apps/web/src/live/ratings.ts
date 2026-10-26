/**
 * The user's lichess ratings (`perfs` of GET /api/account) for the Live tab overview. One request,
 * cached for five minutes; concurrent callers share the request in flight.
 */
import { lichessFetch } from '../lichess/auth';

export const PERF_KEYS = ['bullet', 'blitz', 'rapid', 'classical', 'correspondence'] as const;
export type PerfKey = (typeof PERF_KEYS)[number];

export interface PerfRating {
  rating: number;
  provisional: boolean;
  games: number;
}

export type LichessRatings = Partial<Record<PerfKey, PerfRating>>;

export const RATINGS_TTL_MS = 5 * 60_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Picks the five time-control perfs out of an /api/account response; missing ones are left out. */
export function parsePerfs(json: unknown): LichessRatings {
  const out: LichessRatings = {};
  const perfs = isObj(json) && isObj(json.perfs) ? json.perfs : {};
  for (const k of PERF_KEYS) {
    const p = perfs[k];
    if (!isObj(p) || typeof p.rating !== 'number' || !Number.isFinite(p.rating)) continue;
    out[k] = {
      rating: Math.round(p.rating),
      provisional: p.prov === true,
      games: typeof p.games === 'number' ? p.games : 0,
    };
  }
  return out;
}

let cache: { user: string; at: number; ratings: LichessRatings } | null = null;
let inflight: { user: string; promise: Promise<LichessRatings> } | null = null;

export function resetRatingsCache(): void {
  cache = null;
  inflight = null;
}

/** Ratings of `user`, from the cache when younger than {@link RATINGS_TTL_MS}. Rejects on failure. */
export function fetchRatings(user: string, now: () => number = Date.now): Promise<LichessRatings> {
  if (cache && cache.user === user && now() - cache.at < RATINGS_TTL_MS)
    return Promise.resolve(cache.ratings);
  if (inflight && inflight.user === user) return inflight.promise;
  const promise = (async () => {
    const res = await lichessFetch('/api/account', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ratings = parsePerfs(await res.json());
    cache = { user, at: now(), ratings };
    return ratings;
  })();
  const entry = { user, promise };
  inflight = entry;
  const clear = () => {
    if (inflight === entry) inflight = null;
  };
  promise.then(clear, clear);
  return promise;
}
