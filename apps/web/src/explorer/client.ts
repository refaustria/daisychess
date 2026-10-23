/**
 * Client for the lichess Opening Explorer (https://lichess.org/api#tag/Opening-Explorer).
 *
 * Since November 2025 the explorer rejects anonymous requests (HTTP 401, nginx HTML body) to fend
 * off a DDoS; every request needs a lichess personal API token (no scope) as a Bearer header
 * (https://lichess.org/@/thibault/blog/the-opening-explorer-now-requires-authentication/FSWh9Zg3).
 * The limit is about 20 requests per minute per lichess user. The service is CORS-enabled
 * (`Access-Control-Allow-Headers` includes Authorization), so requests go straight from the browser.
 *
 * The token is only ever sent in the Authorization header: never in a URL, never logged.
 * Responses are validated by hand (light, no zod) and normalised to {@link ExplorerResult}.
 */

export const EXPLORER_ORIGIN = 'https://explorer.lichess.org';
export const LICHESS_EXPORT_URL = 'https://lichess.org/game/export/';
export const TOKEN_CREATE_URL = 'https://lichess.org/account/oauth/token/create?description=ChessLab+explorer';
/** Explorer index depth: positions after this many plies (from the standard start) are not indexed. */
export const EXPLORER_MAX_PLY = 50;

export type ExplorerDb = 'masters' | 'lichess';
export const SPEEDS = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'] as const;
export type Speed = (typeof SPEEDS)[number];
/** Rating groups: each value covers up to the next one (2500 = 2500+). */
export const RATINGS = [0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500] as const;
export type RatingGroup = (typeof RATINGS)[number];

export interface ExplorerQuery {
  db: ExplorerDb;
  /** FEN of the root position (the game's start position). */
  fen: string;
  /** UCI moves played from `fen` to reach the explored position (lets the API name transpositions). */
  play: string[];
  /** Lichess DB only. Empty = all. */
  speeds?: readonly Speed[];
  /** Lichess DB only. Empty = all. */
  ratings?: readonly RatingGroup[];
}

export interface ExplorerPlayer {
  name: string;
  rating?: number;
}

export interface ExplorerGame {
  id: string;
  winner: 'white' | 'black' | null;
  white: ExplorerPlayer;
  black: ExplorerPlayer;
  year?: number;
  /** "YYYY-MM" when known. */
  month?: string;
  speed?: string;
  /** Move played from the explored position in this game (UCI), when the API says so. */
  uci?: string;
}

export interface ExplorerMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  averageRating?: number;
}

export interface ExplorerResult {
  white: number;
  draws: number;
  black: number;
  opening: { eco: string; name: string } | null;
  moves: ExplorerMove[];
  topGames: ExplorerGame[];
  recentGames: ExplorerGame[];
}

export type ExplorerErrorKind = 'unauthorized' | 'rate_limited' | 'network' | 'bad_response' | 'not_found';

export class ExplorerError extends Error {
  readonly kind: ExplorerErrorKind;
  /** Seconds to wait (rate_limited). */
  readonly retryAfter?: number;
  readonly status?: number;
  constructor(kind: ExplorerErrorKind, message: string, extra: { retryAfter?: number; status?: number } = {}) {
    super(message);
    this.name = 'ExplorerError';
    this.kind = kind;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
    if (extra.status !== undefined) this.status = extra.status;
  }
}

export type ExplorerFetch = (
  input: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

export interface ExplorerRequestOptions {
  token?: string;
  signal?: AbortSignal;
  fetch?: ExplorerFetch;
}

/** Default wait after a 429 when `Retry-After` is missing or unreadable (not CORS-exposed). */
export const DEFAULT_RETRY_AFTER = 60;

const defaultFetch: ExplorerFetch = (input, init) => globalThis.fetch(input, init);

export function buildExplorerUrl(q: ExplorerQuery): string {
  const p = new URLSearchParams();
  if (q.db === 'lichess') p.set('variant', 'standard');
  p.set('fen', q.fen);
  if (q.play.length > 0) p.set('play', q.play.join(','));
  if (q.db === 'masters') {
    p.set('topGames', '10');
  } else {
    if (q.speeds && q.speeds.length > 0) p.set('speeds', q.speeds.join(','));
    if (q.ratings && q.ratings.length > 0) p.set('ratings', q.ratings.join(','));
    p.set('topGames', '4');
    p.set('recentGames', '4');
  }
  p.set('moves', '12');
  return `${EXPLORER_ORIGIN}/${q.db}?${p.toString()}`;
}

/** Stable cache key for a query (db + filters + position path). */
export function queryKey(q: ExplorerQuery): string {
  return buildExplorerUrl(q);
}

function parseRetryAfter(res: Response): number {
  const raw = res.headers.get('Retry-After');
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
  }
  return DEFAULT_RETRY_AFTER;
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

async function send(url: string, accept: string, opts: ExplorerRequestOptions): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept };
  const token = opts.token?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await (opts.fetch ?? defaultFetch)(url, opts.signal ? { headers, signal: opts.signal } : { headers });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ExplorerError('network', 'Could not reach the lichess explorer – check your connection');
  }
  if (res.status === 401 || res.status === 403) {
    throw new ExplorerError(
      'unauthorized',
      token ? 'The lichess token was rejected' : 'The lichess explorer requires a lichess API token',
      { status: res.status },
    );
  }
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res);
    throw new ExplorerError('rate_limited', `Rate limited by lichess – retry in ${retryAfter} s`, {
      retryAfter,
      status: 429,
    });
  }
  if (res.status === 404) throw new ExplorerError('not_found', 'Not found on lichess', { status: 404 });
  if (!res.ok) {
    throw new ExplorerError('bad_response', `The lichess explorer returned an error (HTTP ${res.status})`, {
      status: res.status,
    });
  }
  return res;
}

const bad = (): ExplorerError => new ExplorerError('bad_response', 'Unexpected response from the lichess explorer');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad();
  return v;
};

function parsePlayer(v: unknown): ExplorerPlayer {
  if (!isObj(v)) return { name: '?' };
  const name = typeof v.name === 'string' && v.name ? v.name : '?';
  return typeof v.rating === 'number' ? { name, rating: v.rating } : { name };
}

function parseGame(v: unknown): ExplorerGame | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id) return null;
  const g: ExplorerGame = {
    id: v.id,
    winner: v.winner === 'white' || v.winner === 'black' ? v.winner : null,
    white: parsePlayer(v.white),
    black: parsePlayer(v.black),
  };
  if (typeof v.year === 'number') g.year = v.year;
  if (typeof v.month === 'string' && v.month) g.month = v.month;
  if (typeof v.speed === 'string') g.speed = v.speed;
  if (typeof v.uci === 'string') g.uci = v.uci;
  return g;
}

function parseGames(v: unknown): ExplorerGame[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw bad();
  return v.map(parseGame).filter((g): g is ExplorerGame => g !== null);
}

function parseMove(v: unknown): ExplorerMove {
  if (!isObj(v) || typeof v.uci !== 'string' || typeof v.san !== 'string') throw bad();
  const m: ExplorerMove = { uci: v.uci, san: v.san, white: count(v.white), draws: count(v.draws), black: count(v.black) };
  if (typeof v.averageRating === 'number' && v.averageRating > 0) m.averageRating = v.averageRating;
  return m;
}

/** Validates and normalises an explorer JSON body (masters or lichess). Throws `bad_response`. */
export function parseExplorerResult(raw: unknown): ExplorerResult {
  if (!isObj(raw) || !Array.isArray(raw.moves)) throw bad();
  const op = raw.opening;
  return {
    white: count(raw.white),
    draws: count(raw.draws),
    black: count(raw.black),
    opening: isObj(op) && typeof op.eco === 'string' && typeof op.name === 'string' ? { eco: op.eco, name: op.name } : null,
    moves: raw.moves.map(parseMove),
    topGames: parseGames(raw.topGames),
    recentGames: parseGames(raw.recentGames),
  };
}

/** Explorer statistics for a position. Rejects with {@link ExplorerError} (or an AbortError). */
export async function fetchExplorer(q: ExplorerQuery, opts: ExplorerRequestOptions = {}): Promise<ExplorerResult> {
  const res = await send(buildExplorerUrl(q), 'application/json', opts);
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    if (isAbort(e)) throw e;
    throw bad();
  }
  return parseExplorerResult(body);
}

/** PGN of an explorer game: OTB masters games from the explorer, lichess games from lichess.org. */
export async function fetchExplorerGamePgn(
  db: ExplorerDb,
  id: string,
  opts: ExplorerRequestOptions = {},
): Promise<string> {
  const safeId = encodeURIComponent(id);
  let res: Response;
  if (db === 'masters') {
    res = await send(`${EXPLORER_ORIGIN}/masters/pgn/${safeId}`, 'application/x-chess-pgn', opts);
  } else {
    // lichess.org game export is public: never send the token to a second host.
    res = await send(`${LICHESS_EXPORT_URL}${safeId}?clocks=false&evals=false`, 'application/x-chess-pgn', {
      ...opts,
      token: undefined,
    });
  }
  const text = await res.text();
  if (!text.trim()) throw bad();
  return text;
}
