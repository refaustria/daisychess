export type OnlineSite = 'lichess' | 'chesscom';

export interface OnlinePlayer {
  name: string;
  rating?: number;
}

export interface OnlineGame {
  id: string;
  site: OnlineSite;
  white: OnlinePlayer;
  black: OnlinePlayer;
  /** PGN result token: 1-0, 0-1, 1/2-1/2 or * */
  result: '1-0' | '0-1' | '1/2-1/2' | '*';
  /** ISO 8601 timestamp. */
  date: string;
  /** Speed class, e.g. blitz, rapid, daily. */
  speed?: string;
  /** Human readable time control, e.g. "3+2". */
  timeControl?: string;
  opening?: string;
  /** Where the PGN can be fetched lazily when `pgn` is absent. */
  pgnUrl?: string;
  pgn?: string;
}

export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

export interface FetchOptions {
  max?: number;
  fetch?: FetchLike;
  /** Continue after a previous page (`OnlinePage.next`). */
  cursor?: string;
}

export interface OnlinePage {
  /** Newest first. */
  games: OnlineGame[];
  /** Opaque cursor for the next older page; absent when there is nothing older. */
  next?: string;
}

export type OnlineImportErrorKind =
  'invalid-username' | 'not-found' | 'rate-limited' | 'network' | 'bad-response';

export class OnlineImportError extends Error {
  readonly kind: OnlineImportErrorKind;
  constructor(kind: OnlineImportErrorKind, message: string) {
    super(message);
    this.name = 'OnlineImportError';
    this.kind = kind;
  }
}

export const SITE_LABEL: Record<OnlineSite, string> = {
  lichess: 'lichess',
  chesscom: 'chess.com',
};

export function defaultFetch(
  input: string,
  init?: { headers?: Record<string, string> },
): Promise<Response> {
  return globalThis.fetch(input, init);
}

interface HostState {
  /** Tail of the request queue (requests to one host run one at a time). */
  tail: Promise<unknown>;
  lastOk: number;
  blockedUntil: number;
}

const hosts = new WeakMap<FetchLike, Partial<Record<OnlineSite, HostState>>>();

function hostState(doFetch: FetchLike, site: OnlineSite): HostState {
  let per = hosts.get(doFetch);
  if (!per) hosts.set(doFetch, (per = {}));
  return (per[site] ??= { tail: Promise.resolve(), lastOk: 0, blockedUntil: 0 });
}

/** A TypeError this soon after a successful call is almost always a CORS-less 429 / 5xx, not a lost connection. */
const RECENT_OK_MS = 120_000;

function waitText(seconds: number): string {
  if (seconds <= 60) return 'a minute';
  return `${Math.ceil(seconds / 60)} minutes`;
}

function retryAfterSeconds(res: Response, site: OnlineSite): number {
  const h = Number(res.headers.get('Retry-After'));
  const floor = site === 'lichess' ? 60 : 1; // lichess asks for a full minute after a 429
  return Math.max(Number.isFinite(h) && h > 0 ? Math.ceil(h) : 60, floor);
}

/**
 * Performs a request and maps transport / HTTP failures to OnlineImportError.
 * Requests to the same site through the same fetch run strictly one at a time (lichess asks for that),
 * and after a 429 further requests fail fast until the Retry-After time has passed.
 */
export function request(
  site: OnlineSite,
  url: string,
  accept: string,
  doFetch: FetchLike,
  what: string,
): Promise<Response> {
  const st = hostState(doFetch, site);
  const run = async (): Promise<Response> => {
    const now = Date.now();
    if (now < st.blockedUntil) throw rateLimited(site, Math.ceil((st.blockedUntil - now) / 1000));
    let res: Response;
    try {
      res = await doFetch(url, { headers: { Accept: accept } });
    } catch {
      if (Date.now() - st.lastOk < RECENT_OK_MS) {
        st.blockedUntil = Date.now() + 60_000;
        throw rateLimited(site, 60);
      }
      throw new OnlineImportError(
        'network',
        `Could not reach ${SITE_LABEL[site]} – check your connection`,
      );
    }
    if (res.status === 404)
      throw new OnlineImportError('not-found', `${what} not found on ${SITE_LABEL[site]}`);
    if (res.status === 429) {
      const s = retryAfterSeconds(res, site);
      st.blockedUntil = Date.now() + s * 1000;
      throw rateLimited(site, s);
    }
    if (!res.ok)
      throw new OnlineImportError(
        'bad-response',
        `${SITE_LABEL[site]} returned an error (HTTP ${res.status})`,
      );
    st.lastOk = Date.now();
    return res;
  };
  const result = st.tail.then(run, run);
  st.tail = result.catch(() => undefined);
  return result;
}

function rateLimited(site: OnlineSite, seconds: number): OnlineImportError {
  return new OnlineImportError(
    'rate-limited',
    `${SITE_LABEL[site]} rate limit – try again in ${waitText(seconds)}`,
  );
}
