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

export type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>;

export interface FetchOptions {
  max?: number;
  fetch?: FetchLike;
}

export type OnlineImportErrorKind =
  | 'invalid-username'
  | 'not-found'
  | 'rate-limited'
  | 'network'
  | 'bad-response';

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

export function defaultFetch(input: string, init?: { headers?: Record<string, string> }): Promise<Response> {
  return globalThis.fetch(input, init);
}

/** Performs a request and maps transport / HTTP failures to OnlineImportError. */
export async function request(
  site: OnlineSite,
  url: string,
  accept: string,
  doFetch: FetchLike,
  what: string,
): Promise<Response> {
  let res: Response;
  try {
    res = await doFetch(url, { headers: { Accept: accept } });
  } catch {
    throw new OnlineImportError('network', `Could not reach ${SITE_LABEL[site]} – check your connection`);
  }
  if (res.status === 404) throw new OnlineImportError('not-found', `${what} not found on ${SITE_LABEL[site]}`);
  if (res.status === 429)
    throw new OnlineImportError('rate-limited', `${SITE_LABEL[site]} is rate limiting requests – try again in a minute`);
  if (!res.ok) throw new OnlineImportError('bad-response', `${SITE_LABEL[site]} returned an error (HTTP ${res.status})`);
  return res;
}
