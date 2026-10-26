import type { PortalApi } from '../api';
import { errorText } from '../api';
import type { Me } from '../types';
import { challengeS256, createState, createVerifier } from './pkce';

/**
 * "Log in with lichess" for the operator portal: OAuth 2.0 authorization code flow with PKCE
 * (public client, no secret). The portal needs no scope: the hub only asks lichess who the token
 * belongs to (`GET /api/account` works without scopes).
 *
 * Client id: its own (`portal.daisychess.org`),
 * not the app's (`play.daisychess.org`). lichess shows the id on the
 * consent page, so operators see that they log in to the portal and not to the chess app, and a
 * leaked portal id cannot be mistaken for the app's. lichess needs no client registration.
 *
 * The lichess access token lives in one local variable: it is exchanged, posted once to the hub
 * (`POST /api/portal/login`, the hub swaps it for a session cookie), and revoked at lichess
 * (`DELETE /api/token`) straight away. It is never stored (no localStorage, no sessionStorage; only
 * the PKCE verifier + state survive the redirect, in sessionStorage) and never logged.
 */
export const LICHESS_ORIGIN = 'https://lichess.org';
export const LICHESS_AUTHORIZE_URL = `${LICHESS_ORIGIN}/oauth`;
export const LICHESS_TOKEN_URL = `${LICHESS_ORIGIN}/api/token`;
export const PORTAL_CLIENT_ID = 'portal.daisychess.org';
export const PENDING_STORAGE_KEY = 'daisychess.portal.pkce';

interface Pending {
  verifier: string;
  state: string;
  redirectUri: string;
}

export interface LichessDeps {
  fetch?: typeof fetch;
  navigate?: (url: string) => void;
}

/** This page without query or hash, e.g. `https://play.daisychess.org/portal/`. */
export function redirectUri(): string {
  return `${globalThis.location.origin}${globalThis.location.pathname}`;
}

export function buildAuthorizeUrl(p: {
  challenge: string;
  state: string;
  redirectUri: string;
}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: PORTAL_CLIENT_ID,
    redirect_uri: p.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: p.challenge,
    state: p.state,
  });
  return `${LICHESS_AUTHORIZE_URL}?${q.toString()}`;
}

/** Starts the login: stores verifier + state for the round trip and navigates to lichess. */
export async function startLogin(deps: LichessDeps = {}): Promise<void> {
  const navigate = deps.navigate ?? ((url: string) => globalThis.location.assign(url));
  const verifier = createVerifier();
  const state = createState();
  const uri = redirectUri();
  try {
    globalThis.sessionStorage.setItem(
      PENDING_STORAGE_KEY,
      JSON.stringify({ verifier, state, redirectUri: uri }),
    );
  } catch {
    throw new Error('Logging in needs session storage, which this browser blocks for the site.');
  }
  let challenge: string;
  try {
    challenge = await challengeS256(verifier);
  } catch {
    clearPending();
    throw new Error('Logging in needs a secure connection (https).');
  }
  navigate(buildAuthorizeUrl({ challenge, state, redirectUri: uri }));
}

function readPending(): Pending | null {
  try {
    const raw = globalThis.sessionStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Record<keyof Pending, unknown>>;
    if (
      typeof v.verifier !== 'string' ||
      typeof v.state !== 'string' ||
      typeof v.redirectUri !== 'string'
    )
      return null;
    return { verifier: v.verifier, state: v.state, redirectUri: v.redirectUri };
  } catch {
    return null;
  }
}

function clearPending(): void {
  try {
    globalThis.sessionStorage.removeItem(PENDING_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description'];

function cleanUrl(): void {
  try {
    const url = new URL(globalThis.location.href);
    for (const p of CALLBACK_PARAMS) url.searchParams.delete(p);
    const search = url.searchParams.toString();
    globalThis.history.replaceState(
      globalThis.history.state,
      '',
      `${url.pathname}${search ? `?${search}` : ''}`,
    );
  } catch {
    /* history unavailable */
  }
}

function clip(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function exchangeCode(
  doFetch: typeof fetch,
  code: string,
  pending: Pending,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
    client_id: PORTAL_CLIENT_ID,
  });
  let res: Response;
  try {
    res = await doFetch(LICHESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch {
    throw new Error('Could not reach lichess. Check your connection and try again.');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* handled below */
  }
  const o = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  if (!res.ok) {
    const desc =
      typeof o.error_description === 'string'
        ? o.error_description
        : typeof o.error === 'string'
          ? o.error
          : '';
    throw new Error(
      `lichess refused the login (HTTP ${res.status})${desc ? `: ${clip(desc)}` : ''}`,
    );
  }
  if (typeof o.access_token !== 'string' || !o.access_token)
    throw new Error('Unexpected response from lichess.');
  return o.access_token;
}

/** Best effort: the hub needed the token once; lichess forgets it now. */
async function revoke(doFetch: typeof fetch, token: string): Promise<void> {
  try {
    await doFetch(LICHESS_TOKEN_URL, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* offline or blocked: the token expires on its own */
  }
}

export type CallbackResult =
  { kind: 'none' } | { kind: 'error'; message: string } | { kind: 'ok'; me: Me };

let callbackRun: Promise<CallbackResult> | undefined;

/** Test hook: forget a processed callback. */
export function resetCallbackGuard(): void {
  callbackRun = undefined;
}

/**
 * Processes `?code=&state=` (or `?error=`) if this page load is the redirect back from lichess.
 * Runs at most once per page load (React StrictMode mounts twice); later calls get the same result.
 */
export function completeLoginFromUrl(
  api: PortalApi,
  deps: LichessDeps = {},
): Promise<CallbackResult> {
  callbackRun ??= run(api, deps);
  return callbackRun;
}

async function run(api: PortalApi, deps: LichessDeps): Promise<CallbackResult> {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const params = new URLSearchParams(globalThis.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  const pending = readPending();
  if (error !== null && (state !== null || pending !== null)) {
    clearPending();
    cleanUrl();
    const message =
      error === 'access_denied'
        ? 'Login cancelled on lichess.'
        : `lichess login failed: ${clip(params.get('error_description') || error)}`;
    return { kind: 'error', message };
  }
  if (code === null || state === null) return { kind: 'none' };
  clearPending();
  cleanUrl();
  if (!pending || pending.state !== state) {
    return {
      kind: 'error',
      message:
        'Login failed: the response from lichess did not match this login attempt. Please try again.',
    };
  }
  let token: string | undefined;
  try {
    token = await exchangeCode(doFetch, code, pending);
    const me = await api.login(token);
    return { kind: 'ok', me };
  } catch (e) {
    return {
      kind: 'error',
      message: e instanceof Error && !('status' in e) ? e.message : errorText(e),
    };
  } finally {
    if (token) await revoke(doFetch, token);
    token = undefined;
  }
}
