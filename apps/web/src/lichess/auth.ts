import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { challengeS256, createState, createVerifier } from './pkce';

/**
 * "Log in with lichess": OAuth 2.0 authorization code flow with PKCE (no client secret,
 * https://lichess.org/api#tag/OAuth) and the shared token store used by the explorer, the online
 * import ("My games") and live games.
 *
 * Flow: `login()` stores a random verifier + state in sessionStorage (only for the round trip)
 * and navigates to lichess.org/oauth. lichess redirects back to the same page with
 * `?code=&state=`; `handleCallback()` (called once from main.tsx) checks the state, exchanges the
 * code for a token, reads the username from /api/account, stores `{token, username, scopes}` in
 * localStorage `daisychess.lichess` and removes the parameters from the URL.
 *
 * The token is only ever sent as an `Authorization: Bearer` header to lichess hosts. It never
 * appears in a URL, a log line or an error message.
 */

export const LICHESS_ORIGIN = 'https://lichess.org';
export const LICHESS_AUTHORIZE_URL = `${LICHESS_ORIGIN}/oauth`;
export const LICHESS_TOKEN_URL = `${LICHESS_ORIGIN}/api/token`;
export const LICHESS_ACCOUNT_URL = `${LICHESS_ORIGIN}/api/account`;
export const LICHESS_TOKEN_TEST_URL = `${LICHESS_ORIGIN}/api/token/test`;
/** Shown by lichess on the consent page (ADR-021; was `daisychess.c.referee.at`). */
export const LICHESS_CLIENT_ID = 'play.daisychess.org';
/** Requested at login so live games can use the same token (the explorer needs no scope). */
export const LICHESS_SCOPES: readonly string[] = ['board:play', 'challenge:read', 'challenge:write'];
/** Where to create a personal access token; lichess prefills the scopes and description from the query. */
export const LICHESS_TOKEN_CREATE_URL = `${LICHESS_ORIGIN}/account/oauth/token/create?${LICHESS_SCOPES.map((x) => `scopes[]=${x}`).join('&')}&description=DaisyChess`;
export const AUTH_STORAGE_KEY = 'daisychess.lichess';
export const PENDING_STORAGE_KEY = 'daisychess.lichess.pkce';
/** Hosts that may receive the token. */
const TOKEN_HOSTS = new Set(['lichess.org', 'explorer.lichess.org']);

export const SCOPE_LABEL: Record<string, string> = {
  'board:play': 'Play games with the Board API',
  'challenge:read': 'Read incoming challenges',
  'challenge:write': 'Create, accept and decline challenges',
};

export type LichessAuthStatus = 'anonymous' | 'authorizing' | 'authenticated' | 'error';

/** How the login was made: OAuth redirect or a pasted personal access token. */
export type LichessAuthSource = 'oauth' | 'token';

export interface LichessAuthState {
  status: LichessAuthStatus;
  source?: LichessAuthSource;
  username?: string;
  token?: string;
  scopes: string[];
  error?: string;
}

export interface LichessAuthActions {
  login(): Promise<void>;
  /** Log in with a pasted personal access token (validated against lichess); throws a clear message. */
  loginWithToken(token: string): Promise<void>;
  logout(): Promise<void>;
  /** handle ?code=&state= on load; returns true if a callback was processed */
  handleCallback(): Promise<boolean>;
}

export type LichessAuthStore = LichessAuthState & LichessAuthActions;

interface StoredAuth {
  token: string;
  username: string;
  scopes: string[];
  /** Absent in objects stored before token logins existed: those are OAuth logins. */
  source: LichessAuthSource;
  /** Epoch ms; absent when lichess did not say. */
  expiresAt?: number;
}

interface PendingLogin {
  verifier: string;
  state: string;
  redirectUri: string;
}

// --- storage (every access guarded: private mode, blocked storage) ----------------------------

function readStored(): StoredAuth | null {
  try {
    const raw = globalThis.localStorage?.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Record<keyof StoredAuth, unknown>>;
    if (typeof v.token !== 'string' || !v.token || typeof v.username !== 'string' || !v.username) return null;
    const scopes = Array.isArray(v.scopes) ? v.scopes.filter((s): s is string => typeof s === 'string') : [];
    const out: StoredAuth = { token: v.token, username: v.username, scopes, source: v.source === 'token' ? 'token' : 'oauth' };
    if (typeof v.expiresAt === 'number') {
      if (v.expiresAt <= Date.now()) return null;
      out.expiresAt = v.expiresAt;
    }
    return out;
  } catch {
    return null;
  }
}

function writeStored(a: StoredAuth | null): void {
  try {
    if (a) globalThis.localStorage?.setItem(AUTH_STORAGE_KEY, JSON.stringify(a));
    else globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // storage unavailable: the login lasts for this page load only
  }
}

function readPending(): PendingLogin | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(PENDING_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Record<keyof PendingLogin, unknown>>;
    if (typeof v.verifier !== 'string' || typeof v.state !== 'string' || typeof v.redirectUri !== 'string') return null;
    return { verifier: v.verifier, state: v.state, redirectUri: v.redirectUri };
  } catch {
    return null;
  }
}

function clearPending(): void {
  try {
    globalThis.sessionStorage?.removeItem(PENDING_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}

function stateFromStored(a: StoredAuth | null): LichessAuthState {
  // Every field explicitly (setState merges): a stale username/token/error must not survive.
  return a
    ? { status: 'authenticated', source: a.source, token: a.token, username: a.username, scopes: [...a.scopes], error: undefined }
    : { status: 'anonymous', source: undefined, token: undefined, username: undefined, scopes: [], error: undefined };
}

// --- test hooks ---------------------------------------------------------------------------------

type Navigate = (url: string) => void;
const defaultNavigate: Navigate = (url) => globalThis.location.assign(url);
let navigateImpl: Navigate = defaultNavigate;

/** Test hook: replace the top-level navigation used by `login()` (undefined = location.assign). */
export function setLichessNavigate(fn: Navigate | undefined): void {
  navigateImpl = fn ?? defaultNavigate;
}

let callbackRun: Promise<boolean> | undefined;

/** Test hook: re-read the stored login and forget a processed callback. */
export function resetLichessAuth(): void {
  callbackRun = undefined;
  useLichessAuth.setState(stateFromStored(readStored()));
}

// --- helpers ------------------------------------------------------------------------------------

/** Redirect URI: this page without query or hash (https://play.daisychess.org/, http://localhost:4180/). */
export function redirectUri(): string {
  return `${globalThis.location.origin}${globalThis.location.pathname}`;
}

export function buildAuthorizeUrl(p: { challenge: string; state: string; redirectUri: string }): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: LICHESS_CLIENT_ID,
    redirect_uri: p.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: p.challenge,
    scope: LICHESS_SCOPES.join(' '),
    state: p.state,
  });
  return `${LICHESS_AUTHORIZE_URL}?${q.toString()}`;
}

const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description'];

/** Removes the OAuth parameters from the address bar (keeps other parameters and the hash). */
function cleanUrl(): void {
  try {
    const url = new URL(globalThis.location.href);
    for (const p of CALLBACK_PARAMS) url.searchParams.delete(p);
    const search = url.searchParams.toString();
    globalThis.history.replaceState(globalThis.history.state, '', `${url.pathname}${search ? `?${search}` : ''}${url.hash}`);
  } catch {
    /* history unavailable */
  }
}

/** Short, single-line text from lichess for an error message (never contains our token). */
function clip(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 160);
}

class LoginError extends Error {}

async function exchangeCode(code: string, pending: PendingLogin): Promise<{ token: string; scopes: string[]; expiresAt?: number }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: pending.verifier,
    redirect_uri: pending.redirectUri,
    client_id: LICHESS_CLIENT_ID,
  });
  let res: Response;
  try {
    res = await globalThis.fetch(LICHESS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    });
  } catch {
    throw new LoginError('Could not reach lichess – check your connection and try again');
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* handled below */
  }
  const o = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  if (!res.ok) {
    const desc = typeof o.error_description === 'string' ? o.error_description : typeof o.error === 'string' ? o.error : '';
    throw new LoginError(`lichess refused the login (HTTP ${res.status})${desc ? `: ${clip(desc)}` : ''}`);
  }
  if (typeof o.access_token !== 'string' || !o.access_token) throw new LoginError('Unexpected response from lichess');
  const scopes =
    typeof o.scope === 'string' && o.scope.trim() ? o.scope.split(/[\s,]+/).filter(Boolean) : [...LICHESS_SCOPES];
  const out: { token: string; scopes: string[]; expiresAt?: number } = { token: o.access_token, scopes };
  if (typeof o.expires_in === 'number' && o.expires_in > 0) out.expiresAt = Date.now() + o.expires_in * 1000;
  return out;
}

async function fetchUsername(token: string): Promise<string> {
  let res: Response;
  try {
    res = await globalThis.fetch(LICHESS_ACCOUNT_URL, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  } catch {
    throw new LoginError('Could not reach lichess – check your connection and try again');
  }
  if (!res.ok) throw new LoginError(`Could not read your lichess account (HTTP ${res.status})`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LoginError('Unexpected response from lichess');
  }
  const o = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const name = typeof o.username === 'string' ? o.username : typeof o.id === 'string' ? o.id : '';
  if (!name) throw new LoginError('Unexpected response from lichess');
  return name;
}

/** Checks a pasted token with POST /api/token/test (token in the body only, never in a URL). */
async function testToken(token: string): Promise<{ scopes: string[]; expiresAt?: number }> {
  let res: Response;
  try {
    res = await globalThis.fetch(LICHESS_TOKEN_TEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Accept: 'application/json' },
      body: token,
    });
  } catch {
    throw new LoginError('Could not reach lichess – check your connection and try again');
  }
  if (res.status === 429) throw new LoginError('lichess is rate limiting token checks – try again in a minute');
  if (!res.ok) throw new LoginError(`lichess could not check the token (HTTP ${res.status})`);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new LoginError('Unexpected response from lichess');
  }
  const map = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const entry = map[token];
  if (typeof entry !== 'object' || entry === null) throw new LoginError('Token invalid or expired');
  const o = entry as Record<string, unknown>;
  const scopes = typeof o.scopes === 'string' ? o.scopes.split(',').map((x) => x.trim()).filter(Boolean) : [];
  const out: { scopes: string[]; expiresAt?: number } = { scopes };
  if (typeof o.expires === 'number' && o.expires > 0) out.expiresAt = o.expires;
  return out;
}

/** Best effort: revoke a token on lichess (logout, or a login that failed half-way). */
async function revoke(token: string): Promise<void> {
  try {
    await globalThis.fetch(LICHESS_TOKEN_URL, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  } catch {
    /* offline or blocked: the token expires on its own; it is gone from this browser anyway */
  }
}

function errorText(error: string, description: string | null): string {
  if (error === 'access_denied') return 'Login cancelled on lichess';
  return `lichess login failed: ${clip(description || error)}`;
}

// --- store --------------------------------------------------------------------------------------

export const useLichessAuth: UseBoundStore<StoreApi<LichessAuthStore>> = create<LichessAuthStore>()((set, get) => {
  const fail = (error: string): void => set({ status: 'error', error, token: undefined, username: undefined, scopes: [] });

  const processCallback = async (): Promise<boolean> => {
    let params: URLSearchParams;
    try {
      params = new URLSearchParams(globalThis.location.search);
    } catch {
      return false;
    }
    const code = params.get('code');
    const state = params.get('state');
    const error = params.get('error');
    const pending = readPending();
    // Only our own round trip: the redirect carries `state`, or we have a pending login.
    if (error !== null && (state !== null || pending !== null)) {
      clearPending();
      cleanUrl();
      fail(errorText(error, params.get('error_description')));
      return true;
    }
    if (code === null || state === null) return false;
    clearPending();
    cleanUrl();
    if (!pending || pending.state !== state) {
      fail('Login failed: the response from lichess did not match this login attempt. Please try again.');
      return true;
    }
    set({ status: 'authorizing', error: undefined });
    let token: string | undefined;
    try {
      const t = await exchangeCode(code, pending);
      token = t.token;
      const username = await fetchUsername(t.token);
      const stored: StoredAuth = { token: t.token, username, scopes: t.scopes, source: 'oauth' };
      if (t.expiresAt !== undefined) stored.expiresAt = t.expiresAt;
      writeStored(stored);
      set(stateFromStored(stored));
    } catch (e) {
      if (token) void revoke(token);
      writeStored(null);
      fail(e instanceof LoginError ? e.message : 'lichess login failed');
    }
    return true;
  };

  return {
    ...stateFromStored(readStored()),

    login: async () => {
      set({ status: 'authorizing', error: undefined });
      const verifier = createVerifier();
      const state = createState();
      const uri = redirectUri();
      try {
        globalThis.sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify({ verifier, state, redirectUri: uri }));
      } catch {
        fail('Logging in needs session storage, which this browser blocks for the site');
        return;
      }
      let challenge: string;
      try {
        challenge = await challengeS256(verifier);
      } catch {
        clearPending();
        fail('Logging in needs a secure connection (https)');
        return;
      }
      navigateImpl(buildAuthorizeUrl({ challenge, state, redirectUri: uri }));
    },

    loginWithToken: async (raw) => {
      const token = raw.trim();
      if (!token || /\s/.test(token)) {
        const msg = 'Paste a single token without spaces or line breaks';
        set({ status: 'error', error: msg });
        throw new LoginError(msg);
      }
      const prev = get();
      set({ status: 'authorizing', error: undefined });
      try {
        const info = await testToken(token);
        const username = await fetchUsername(token);
        const stored: StoredAuth = { token, username, scopes: info.scopes, source: 'token' };
        if (info.expiresAt !== undefined) stored.expiresAt = info.expiresAt;
        writeStored(stored);
        set(stateFromStored(stored));
      } catch (e) {
        const msg = e instanceof LoginError ? e.message : 'Token login failed';
        // A failed attempt leaves an existing login untouched.
        if (prev.status === 'authenticated') set({ ...prev, error: undefined });
        else set({ status: 'error', error: msg, token: undefined, username: undefined, scopes: [], source: undefined });
        throw new LoginError(msg);
      }
    },

    logout: async () => {
      const { token, source } = get();
      writeStored(null);
      clearPending();
      set(stateFromStored(null));
      // A pasted token was created by the user and may be in use elsewhere: only forget it here.
      if (token && source !== 'token') await revoke(token);
    },

    handleCallback: () => {
      callbackRun ??= processCallback();
      return callbackRun;
    },
  };
});

// Another tab logged in or out: follow it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== AUTH_STORAGE_KEY && e.key !== null) return;
    if (useLichessAuth.getState().status === 'authorizing') return;
    useLichessAuth.setState(stateFromStored(readStored()));
  });
}

// --- non-React access ---------------------------------------------------------------------------

/** The token while logged in, else undefined. */
export function getLichessToken(): string | undefined {
  const s = useLichessAuth.getState();
  return s.status === 'authenticated' ? s.token : undefined;
}

export function hasScope(scope: string): boolean {
  const s = useLichessAuth.getState();
  return s.status === 'authenticated' && s.scopes.includes(scope);
}

/**
 * `fetch` for lichess: adds `Authorization: Bearer <token>` when logged in. `input` is an absolute
 * URL on lichess.org / explorer.lichess.org or a path ("/api/account") relative to lichess.org;
 * other hosts are rejected so the token cannot leak. A 401 on a request that carried the current
 * token means it was revoked or expired: the store logs out with an error message.
 */
export async function lichessFetch(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, LICHESS_ORIGIN);
  if (url.protocol !== 'https:' || !TOKEN_HOSTS.has(url.hostname)) {
    throw new TypeError('lichessFetch only requests lichess.org');
  }
  const token = getLichessToken();
  const headers = new Headers(init?.headers);
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  const res = await globalThis.fetch(url.toString(), { ...init, headers });
  if (res.status === 401 && token && getLichessToken() === token) {
    writeStored(null);
    useLichessAuth.setState({
      status: 'error',
      token: undefined,
      username: undefined,
      scopes: [],
      error: 'Your lichess login expired or was revoked – please log in again',
    });
  }
  return res;
}
