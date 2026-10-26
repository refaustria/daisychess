// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_STORAGE_KEY,
  getLichessToken,
  hasScope,
  lichessFetch,
  LICHESS_CLIENT_ID,
  PENDING_STORAGE_KEY,
  resetLichessAuth,
  setLichessNavigate,
  useLichessAuth,
} from './auth';
import { challengeS256 } from './pkce';

type FetchArgs = [input: string, init?: RequestInit];
let fetchMock: ReturnType<typeof vi.fn<(...a: FetchArgs) => Promise<Response>>>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setUrl(path: string) {
  history.replaceState(null, '', path);
}

function setPending(
  state = 'st4te',
  verifier = 'v'.repeat(64),
  redirectUri = 'http://localhost:3000/',
) {
  sessionStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify({ verifier, state, redirectUri }));
}

function login(token = 'lio_secret', username = 'Alice', scopes = ['board:play']) {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, username, scopes }));
  resetLichessAuth();
}

/** Token + account endpoints. */
function lichessApi(opts: { tokenStatus?: number; accountStatus?: number } = {}) {
  fetchMock.mockImplementation(async (input, init) => {
    if (input === 'https://lichess.org/api/token' && init?.method === 'POST') {
      return opts.tokenStatus && opts.tokenStatus !== 200
        ? json(
            { error: 'invalid_grant', error_description: 'hash of code_verifier does not match' },
            opts.tokenStatus,
          )
        : json({ token_type: 'Bearer', access_token: 'lio_new', expires_in: 31536000 });
    }
    if (input === 'https://lichess.org/api/token' && init?.method === 'DELETE')
      return new Response(null, { status: 204 });
    if (input === 'https://lichess.org/api/account') {
      return opts.accountStatus
        ? json({}, opts.accountStatus)
        : json({ id: 'alice', username: 'Alice' });
    }
    return json({}, 404);
  });
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setUrl('/');
  fetchMock = vi.fn<(...a: FetchArgs) => Promise<Response>>(async () => json({}));
  vi.stubGlobal('fetch', fetchMock);
  resetLichessAuth();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setLichessNavigate(undefined);
});

describe('login', () => {
  it('navigates to lichess.org/oauth with PKCE challenge, state and scopes', async () => {
    const nav = vi.fn<(url: string) => void>();
    setLichessNavigate(nav);
    setUrl('/?foo=1#x');
    await useLichessAuth.getState().login();
    expect(useLichessAuth.getState().status).toBe('authorizing');
    expect(nav).toHaveBeenCalledTimes(1);
    const url = new URL(nav.mock.calls[0]![0]);
    expect(`${url.origin}${url.pathname}`).toBe('https://lichess.org/oauth');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(LICHESS_CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('http://localhost:3000/');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('scope')).toBe('board:play challenge:read challenge:write');
    const pending = JSON.parse(sessionStorage.getItem(PENDING_STORAGE_KEY)!) as {
      verifier: string;
      state: string;
    };
    expect(p.get('state')).toBe(pending.state);
    expect(p.get('code_challenge')).toBe(await challengeS256(pending.verifier));
    expect(pending.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('fails cleanly when sessionStorage is blocked', async () => {
    const nav = vi.fn<(url: string) => void>();
    setLichessNavigate(nav);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    await useLichessAuth.getState().login();
    spy.mockRestore();
    expect(nav).not.toHaveBeenCalled();
    expect(useLichessAuth.getState().status).toBe('error');
  });
});

describe('handleCallback', () => {
  it('returns false without callback parameters', async () => {
    setUrl('/?foo=bar');
    expect(await useLichessAuth.getState().handleCallback()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(location.search).toBe('?foo=bar');
  });

  it('exchanges the code, reads the account, stores and cleans the URL', async () => {
    lichessApi();
    setPending('st4te', 'v'.repeat(64));
    setUrl('/?code=abc&state=st4te&foo=1#h');
    expect(await useLichessAuth.getState().handleCallback()).toBe(true);

    const s = useLichessAuth.getState();
    expect(s.status).toBe('authenticated');
    expect(s.username).toBe('Alice');
    expect(s.token).toBe('lio_new');
    expect(s.scopes).toEqual(['board:play', 'challenge:read', 'challenge:write']);
    expect(location.search).toBe('?foo=1');
    expect(location.hash).toBe('#h');
    expect(sessionStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();
    const stored = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!) as {
      token: string;
      username: string;
    };
    expect(stored).toMatchObject({ token: 'lio_new', username: 'Alice' });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://lichess.org/api/token');
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      code_verifier: 'v'.repeat(64),
      redirect_uri: 'http://localhost:3000/',
      client_id: LICHESS_CLIENT_ID,
    });
    const [accUrl, accInit] = fetchMock.mock.calls[1]!;
    expect(accUrl).toBe('https://lichess.org/api/account');
    expect(new Headers(accInit?.headers).get('Authorization')).toBe('Bearer lio_new');
  });

  it('processes the callback only once (idempotent)', async () => {
    lichessApi();
    setPending();
    setUrl('/?code=abc&state=st4te');
    const a = useLichessAuth.getState().handleCallback();
    const b = useLichessAuth.getState().handleCallback();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(
      fetchMock.mock.calls.filter(([u]) => u === 'https://lichess.org/api/token'),
    ).toHaveLength(1);
  });

  it('rejects a state mismatch without contacting lichess', async () => {
    lichessApi();
    setPending('expected');
    setUrl('/?code=abc&state=forged');
    expect(await useLichessAuth.getState().handleCallback()).toBe(true);
    const s = useLichessAuth.getState();
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/did not match/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(location.search).toBe('');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('rejects a callback without a pending login', async () => {
    setUrl('/?code=abc&state=x');
    expect(await useLichessAuth.getState().handleCallback()).toBe(true);
    expect(useLichessAuth.getState().status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps ?error= to an error status', async () => {
    setPending();
    setUrl('/?error=access_denied&error_description=user+cancelled&state=st4te');
    expect(await useLichessAuth.getState().handleCallback()).toBe(true);
    expect(useLichessAuth.getState()).toMatchObject({
      status: 'error',
      error: 'Login cancelled on lichess',
    });
    expect(location.search).toBe('');
  });

  it('reports a refused token exchange without the verifier or a token', async () => {
    lichessApi({ tokenStatus: 400 });
    setPending('st4te', 'w'.repeat(64));
    setUrl('/?code=abc&state=st4te');
    await useLichessAuth.getState().handleCallback();
    const s = useLichessAuth.getState();
    expect(s.status).toBe('error');
    expect(s.error).toContain('HTTP 400');
    expect(s.error).not.toContain('w'.repeat(10));
    expect(s.token).toBeUndefined();
  });

  it('revokes the new token when the account cannot be read', async () => {
    lichessApi({ accountStatus: 500 });
    setPending();
    setUrl('/?code=abc&state=st4te');
    await useLichessAuth.getState().handleCallback();
    const s = useLichessAuth.getState();
    expect(s.status).toBe('error');
    expect(s.error).not.toContain('lio_new');
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([u, i]) => u === 'https://lichess.org/api/token' && i?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('reports a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    setPending();
    setUrl('/?code=abc&state=st4te');
    await useLichessAuth.getState().handleCallback();
    expect(useLichessAuth.getState().error).toMatch(/Could not reach lichess/);
  });
});

describe('persistence', () => {
  it('restores a stored login', () => {
    login('lio_x', 'Bob', ['board:play', 'challenge:read']);
    expect(useLichessAuth.getState()).toMatchObject({
      status: 'authenticated',
      username: 'Bob',
      token: 'lio_x',
    });
    expect(getLichessToken()).toBe('lio_x');
    expect(hasScope('challenge:read')).toBe(true);
    expect(hasScope('challenge:write')).toBe(false);
  });

  it('ignores corrupt or expired entries', () => {
    localStorage.setItem(AUTH_STORAGE_KEY, '{nope');
    resetLichessAuth();
    expect(useLichessAuth.getState().status).toBe('anonymous');
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ token: 't', username: 'u', scopes: [], expiresAt: Date.now() - 1 }),
    );
    resetLichessAuth();
    expect(useLichessAuth.getState().status).toBe('anonymous');
    expect(getLichessToken()).toBeUndefined();
    expect(hasScope('board:play')).toBe(false);
  });

  it('follows a login/logout in another tab', () => {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({ token: 't2', username: 'Carol', scopes: [] }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: AUTH_STORAGE_KEY }));
    expect(useLichessAuth.getState().username).toBe('Carol');
    localStorage.removeItem(AUTH_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: AUTH_STORAGE_KEY }));
    expect(useLichessAuth.getState().status).toBe('anonymous');
  });
});

describe('logout', () => {
  it('revokes the token and clears the state and storage', async () => {
    login('lio_x');
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await useLichessAuth.getState().logout();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://lichess.org/api/token');
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer lio_x');
    expect(useLichessAuth.getState()).toMatchObject({ status: 'anonymous', scopes: [] });
    expect(useLichessAuth.getState().token).toBeUndefined();
    expect(useLichessAuth.getState().username).toBeUndefined();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('logs out locally even when revoking fails', async () => {
    login('lio_x');
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await useLichessAuth.getState().logout();
    expect(useLichessAuth.getState().status).toBe('anonymous');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });
});

describe('lichessFetch', () => {
  it('adds the Authorization header when logged in', async () => {
    login('lio_x');
    await lichessFetch('/api/account', { headers: { Accept: 'application/json' } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://lichess.org/api/account');
    const h = new Headers(init?.headers);
    expect(h.get('Authorization')).toBe('Bearer lio_x');
    expect(h.get('Accept')).toBe('application/json');
  });

  it('sends no header when anonymous', async () => {
    await lichessFetch('https://lichess.org/api/games/user/alice');
    expect(new Headers(fetchMock.mock.calls[0]![1]?.headers).has('Authorization')).toBe(false);
  });

  it('refuses non-lichess hosts', async () => {
    login('lio_x');
    await expect(lichessFetch('https://evil.example/api')).rejects.toThrow(TypeError);
    await expect(lichessFetch('http://lichess.org/api')).rejects.toThrow(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs out with a message when lichess rejects the token', async () => {
    login('lio_x');
    fetchMock.mockResolvedValue(json({ error: 'No such token' }, 401));
    const res = await lichessFetch('/api/account');
    expect(res.status).toBe(401);
    const s = useLichessAuth.getState();
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/log in again/);
    expect(getLichessToken()).toBeUndefined();
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });
});

describe('loginWithToken', () => {
  const TOKEN = 'lip_secretToken123';
  function tokenApi(opts: { entry?: unknown; testStatus?: number; accountStatus?: number } = {}) {
    fetchMock.mockImplementation(async (input, init) => {
      if (input === 'https://lichess.org/api/token/test') {
        if (opts.testStatus) return json({}, opts.testStatus);
        const entry =
          'entry' in opts
            ? opts.entry
            : { userId: 'alice', scopes: 'board:play,challenge:read', expires: 1893456000000 };
        return json({ [String(init?.body)]: entry });
      }
      if (input === 'https://lichess.org/api/account') {
        return opts.accountStatus
          ? json({}, opts.accountStatus)
          : json({ id: 'alice', username: 'Alice' });
      }
      return json({}, 404);
    });
  }

  it('validates, reads scopes and expiry, stores the token and trims it', async () => {
    tokenApi();
    await useLichessAuth.getState().loginWithToken(`  ${TOKEN}\n`);
    const s = useLichessAuth.getState();
    expect(s).toMatchObject({
      status: 'authenticated',
      source: 'token',
      username: 'Alice',
      scopes: ['board:play', 'challenge:read'],
    });
    expect(getLichessToken()).toBe(TOKEN);
    expect(hasScope('board:play')).toBe(true);
    expect(hasScope('challenge:write')).toBe(false);
    expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!)).toEqual({
      token: TOKEN,
      username: 'Alice',
      scopes: ['board:play', 'challenge:read'],
      source: 'token',
      expiresAt: 1893456000000,
    });
    // The token only travels in the body of the test request, never in a URL.
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://lichess.org/api/token/test');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(TOKEN);
    expect(fetchMock.mock.calls.every(([u]) => !u.includes(TOKEN))).toBe(true);
    expect(new Headers(fetchMock.mock.calls[1]![1]?.headers).get('Authorization')).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it('rejects empty and multi-line input without a request', async () => {
    for (const bad of ['', '   ', 'a\nb', 'a b']) {
      await expect(useLichessAuth.getState().loginWithToken(bad)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useLichessAuth.getState().status).toBe('error');
  });

  it('rejects an invalid or expired token', async () => {
    tokenApi({ entry: null });
    await expect(useLichessAuth.getState().loginWithToken(TOKEN)).rejects.toThrow(
      'Token invalid or expired',
    );
    const s = useLichessAuth.getState();
    expect(s).toMatchObject({ status: 'error', error: 'Token invalid or expired' });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('allows missing scopes', async () => {
    tokenApi({ entry: { userId: 'alice', scopes: '', expires: null } });
    await useLichessAuth.getState().loginWithToken(TOKEN);
    const s = useLichessAuth.getState();
    expect(s.status).toBe('authenticated');
    expect(s.scopes).toEqual([]);
    expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!).expiresAt).toBeUndefined();
  });

  it('fails when the account cannot be read, storing nothing', async () => {
    tokenApi({ accountStatus: 500 });
    await expect(useLichessAuth.getState().loginWithToken(TOKEN)).rejects.toThrow(/account/);
    expect(useLichessAuth.getState().status).toBe('error');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('reports a network failure without the token', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    await expect(useLichessAuth.getState().loginWithToken(TOKEN)).rejects.toThrow(
      /Could not reach/,
    );
    expect(useLichessAuth.getState().error).not.toContain(TOKEN);
  });

  it('does not revoke a pasted token on logout', async () => {
    tokenApi();
    await useLichessAuth.getState().loginWithToken(TOKEN);
    fetchMock.mockClear();
    await useLichessAuth.getState().logout();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useLichessAuth.getState().status).toBe('anonymous');
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('treats stored objects without `source` as OAuth logins (revoked on logout)', async () => {
    login('lio_old');
    expect(useLichessAuth.getState().source).toBe('oauth');
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await useLichessAuth.getState().logout();
    expect(fetchMock.mock.calls[0]![1]?.method).toBe('DELETE');
  });
});

describe('token path scopes', () => {
  it('restores source and scopes of a pasted token from storage', () => {
    localStorage.setItem(
      AUTH_STORAGE_KEY,
      JSON.stringify({
        token: 'lip_x',
        username: 'Al',
        scopes: ['board:play', 'challenge:read', 'challenge:write'],
        source: 'token',
      }),
    );
    useLichessAuth.setState(useLichessAuth.getInitialState());
    window.dispatchEvent(new StorageEvent('storage', { key: AUTH_STORAGE_KEY }));
    expect(useLichessAuth.getState()).toMatchObject({ status: 'authenticated', source: 'token' });
    expect(hasScope('board:play')).toBe(true);
  });
});
