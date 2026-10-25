/**
 * Operator identity for the portal (ADR-020 §2): the portal SPA runs the lichess OAuth PKCE flow
 * and posts the resulting access token to the hub once; the hub asks lichess who it belongs to
 * (`GET /api/account`) and forgets the token. The call goes through the nginx loopback egress
 * proxy (`PORTAL_LICHESS_PROXY`, `deploy/nginx/lichess-egress.conf.snippet`) so the unit keeps
 * `IPAddressDeny=any` with only localhost allowed.
 *
 * The token is only ever placed in the `Authorization` header of that one request: it is not
 * logged, stored, or included in any error.
 */
import { z } from 'zod';

/** The part of lichess' `/api/account` answer the hub keeps: id and username, nothing else. */
export interface LichessAccount {
  /** Lower-case lichess user id. */
  id: string;
  username: string;
}

/** `rejected`: lichess says the token is invalid (401/403) or the account is closed. */
export class LichessError extends Error {
  constructor(
    readonly kind: 'rejected' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'LichessError';
  }
}

/** Resolves the lichess account of an access token or rejects with a {@link LichessError}. */
export type LichessAccountFetcher = (accessToken: string) => Promise<LichessAccount>;

/** Answers above this size are refused (an account object is ~2 kB). */
const MAX_RESPONSE_BYTES = 256 * 1024;

const AccountSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/),
  disabled: z.boolean().optional(),
  closed: z.boolean().optional(),
});

export interface LichessFetcherOptions {
  /** Base URL ending in `/`; the request goes to `<base>api/account`. */
  baseUrl: string;
  timeoutMs: number;
  /** Injectable for tests. Default: global `fetch`. */
  fetch?: typeof fetch;
}

/** The production fetcher: one `GET <base>api/account` with a timeout, no redirects. */
export function createLichessFetcher(opts: LichessFetcherOptions): LichessAccountFetcher {
  const doFetch = opts.fetch ?? fetch;
  const url = new URL('api/account', opts.baseUrl).toString();
  return async (accessToken) => {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      const timeout = (err as Error)?.name === 'TimeoutError';
      throw new LichessError(
        'unavailable',
        timeout ? 'lichess did not answer in time' : 'lichess is unreachable',
      );
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new LichessError('rejected', 'lichess rejected the token');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new LichessError('unavailable', `lichess answered ${res.status}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw new LichessError('unavailable', 'lichess answer could not be read');
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new LichessError('unavailable', 'lichess answer too large');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LichessError('unavailable', 'lichess answer is not JSON');
    }
    const parsed = AccountSchema.safeParse(json);
    if (!parsed.success) throw new LichessError('unavailable', 'unexpected lichess answer');
    if (parsed.data.disabled === true || parsed.data.closed === true) {
      throw new LichessError('rejected', 'the lichess account is closed');
    }
    return { id: parsed.data.id.toLowerCase(), username: parsed.data.username };
  };
}
