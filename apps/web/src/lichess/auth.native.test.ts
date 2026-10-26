// @vitest-environment jsdom
// lichess login inside the iOS/Android app (ADR-022, M26-2): system browser, custom-scheme
// redirect URI, callback delivered as a URL by the app URL dispatcher.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_PENDING_TTL_MS,
  AUTH_STORAGE_KEY,
  BROWSER_CANCEL_GRACE_MS,
  handleLichessCallback,
  isLichessCallbackUrl,
  LICHESS_APP_REDIRECT_URI,
  LICHESS_CLIENT_ID,
  PENDING_STORAGE_KEY,
  redirectUri,
  resetLichessAuth,
  setLichessBrowser,
  setLichessNavigate,
  useLichessAuth,
  type ExternalBrowser,
} from './auth';
import { challengeS256 } from './pkce';

type FetchArgs = [input: string, init?: RequestInit];
let fetchMock: ReturnType<typeof vi.fn<(...a: FetchArgs) => Promise<Response>>>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function lichessApi() {
  fetchMock.mockImplementation(async (input, init) => {
    if (input === 'https://lichess.org/api/token' && init?.method === 'POST')
      return json({ token_type: 'Bearer', access_token: 'lio_app', expires_in: 31536000 });
    if (input === 'https://lichess.org/api/token' && init?.method === 'DELETE')
      return new Response(null, { status: 204 });
    if (input === 'https://lichess.org/api/account') return json({ id: 'bob', username: 'Bob' });
    return json({}, 404);
  });
}

interface FakeBrowser extends ExternalBrowser {
  opened: string[];
  closed: number;
  finish(): void;
  failOpen: boolean;
}

function fakeBrowser(): FakeBrowser {
  let finished: (() => void) | undefined;
  const b: FakeBrowser = {
    opened: [],
    closed: 0,
    failOpen: false,
    async open(url) {
      if (b.failOpen) throw new Error('no browser');
      b.opened.push(url);
    },
    async close() {
      b.closed++;
    },
    async onFinished(cb) {
      finished = cb;
      return () => {
        finished = undefined;
      };
    },
    finish() {
      finished?.();
    },
  };
  return b;
}

function native(platform: 'ios' | 'android' = 'ios') {
  vi.stubEnv('MODE', 'mobile');
  vi.stubGlobal('Capacitor', { isNativePlatform: () => true, getPlatform: () => platform });
}

let browser: FakeBrowser;
let nav: ReturnType<typeof vi.fn<(url: string) => void>>;

/** Starts a login and returns the `state` sent to lichess. */
async function startLogin(): Promise<string> {
  await useLichessAuth.getState().login();
  const url = new URL(browser.opened.at(-1)!);
  return url.searchParams.get('state')!;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
  fetchMock = vi.fn<(...a: FetchArgs) => Promise<Response>>(async () => json({}));
  vi.stubGlobal('fetch', fetchMock);
  native();
  browser = fakeBrowser();
  setLichessBrowser(browser);
  nav = vi.fn<(url: string) => void>();
  setLichessNavigate(nav);
  resetLichessAuth();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setLichessNavigate(undefined);
  setLichessBrowser(undefined);
});

describe('redirectUri / isLichessCallbackUrl', () => {
  it('uses the reverse-domain app scheme in the app and the page on the web', () => {
    expect(LICHESS_APP_REDIRECT_URI).toBe('org.daisychess.app://lichess-callback');
    expect(redirectUri()).toBe(LICHESS_APP_REDIRECT_URI);
    vi.unstubAllEnvs(); // web build
    expect(redirectUri()).toBe('http://localhost:3000/');
  });

  it('matches only the callback URL', () => {
    expect(isLichessCallbackUrl('org.daisychess.app://lichess-callback?code=a&state=b')).toBe(true);
    expect(isLichessCallbackUrl('ORG.DaisyChess.App://Lichess-Callback?code=a')).toBe(true);
    expect(isLichessCallbackUrl('org.daisychess.app://lichess-callback')).toBe(true);
    expect(isLichessCallbackUrl('org.daisychess.app://lichess-callback/?code=a')).toBe(true);
    expect(isLichessCallbackUrl('org.daisychess.app://lichess-callback#x')).toBe(true);
    expect(isLichessCallbackUrl('org.daisychess.app://lichess-callbackX?code=a')).toBe(false);
    expect(isLichessCallbackUrl('org.daisychess.app://lichess-callback/other?code=a')).toBe(false);
    expect(isLichessCallbackUrl('daisychess://lichess-callback?code=a')).toBe(false);
    expect(isLichessCallbackUrl('daisychess://setup?token=x')).toBe(false);
    expect(isLichessCallbackUrl('https://play.daisychess.org/?code=a&state=b')).toBe(false);
    expect(isLichessCallbackUrl('')).toBe(false);
  });
});

describe('login in the app', () => {
  it('opens lichess in the system browser with the app redirect URI; round trip in localStorage', async () => {
    const before = Date.now();
    await useLichessAuth.getState().login();
    expect(nav).not.toHaveBeenCalled();
    expect(browser.opened).toHaveLength(1);
    const url = new URL(browser.opened[0]!);
    expect(`${url.origin}${url.pathname}`).toBe('https://lichess.org/oauth');
    expect(url.searchParams.get('redirect_uri')).toBe(LICHESS_APP_REDIRECT_URI);
    expect(url.searchParams.get('client_id')).toBe(LICHESS_CLIENT_ID);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(sessionStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();
    const pending = JSON.parse(localStorage.getItem(PENDING_STORAGE_KEY)!) as {
      verifier: string;
      state: string;
      redirectUri: string;
      createdAt: number;
    };
    expect(pending.redirectUri).toBe(LICHESS_APP_REDIRECT_URI);
    expect(pending.createdAt).toBeGreaterThanOrEqual(before);
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(url.searchParams.get('code_challenge')).toBe(await challengeS256(pending.verifier));
    expect(useLichessAuth.getState().status).toBe('authorizing');
  });

  it('reports a browser that cannot be opened and drops the round trip', async () => {
    browser.failOpen = true;
    await useLichessAuth.getState().login();
    expect(useLichessAuth.getState()).toMatchObject({
      status: 'error',
      error: 'Could not open the browser for the lichess login',
    });
    expect(localStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();
  });

  it('closing the browser without logging in leaves `authorizing` after the grace period', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await startLogin();
    browser.finish();
    expect(useLichessAuth.getState().status).toBe('authorizing');
    await vi.advanceTimersByTimeAsync(BROWSER_CANCEL_GRACE_MS);
    expect(useLichessAuth.getState().status).toBe('anonymous');
  });

  it('a callback arriving right after the browser closed still logs in', async () => {
    lichessApi();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const state = await startLogin();
    browser.finish();
    await vi.advanceTimersByTimeAsync(BROWSER_CANCEL_GRACE_MS + 10); // reset to anonymous…
    expect(
      await handleLichessCallback(`${LICHESS_APP_REDIRECT_URI}?code=c0de&state=${state}`),
    ).toBe(true); // …but the round trip is still valid
    expect(useLichessAuth.getState()).toMatchObject({ status: 'authenticated', username: 'Bob' });
  });
});

describe('handleLichessCallback', () => {
  it('exchanges the code with the app redirect URI, stores the login, closes the browser', async () => {
    lichessApi();
    const state = await startLogin();
    const pending = JSON.parse(localStorage.getItem(PENDING_STORAGE_KEY)!) as { verifier: string };
    expect(
      await handleLichessCallback(`${LICHESS_APP_REDIRECT_URI}?code=c0de&state=${state}`),
    ).toBe(true);
    const s = useLichessAuth.getState();
    expect(s).toMatchObject({
      status: 'authenticated',
      username: 'Bob',
      token: 'lio_app',
      source: 'oauth',
    });
    expect(browser.closed).toBe(1);
    expect(localStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!)).toMatchObject({ token: 'lio_app' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://lichess.org/api/token');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: 'authorization_code',
      code: 'c0de',
      code_verifier: pending.verifier,
      redirect_uri: LICHESS_APP_REDIRECT_URI,
      client_id: LICHESS_CLIENT_ID,
    });
    // The page URL is not touched (there is nothing to clean in the app).
    expect(location.href).toBe('http://localhost:3000/');
  });

  it('survives the WebView being restarted while the browser was in front', async () => {
    lichessApi();
    const state = await startLogin();
    resetLichessAuth(); // a fresh page load: module state gone, localStorage kept
    expect(useLichessAuth.getState().status).toBe('anonymous');
    await handleLichessCallback(`${LICHESS_APP_REDIRECT_URI}?code=c0de&state=${state}`);
    expect(useLichessAuth.getState().status).toBe('authenticated');
  });

  it('ignores the same URL delivered twice (launch URL + appUrlOpen)', async () => {
    lichessApi();
    const state = await startLogin();
    const url = `${LICHESS_APP_REDIRECT_URI}?code=c0de&state=${state}`;
    expect(await handleLichessCallback(url)).toBe(true);
    expect(await handleLichessCallback(url)).toBe(true);
    expect(useLichessAuth.getState().status).toBe('authenticated');
    expect(
      fetchMock.mock.calls.filter(
        ([u, i]) => u === 'https://lichess.org/api/token' && i?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('rejects a forged state without contacting lichess', async () => {
    lichessApi();
    await startLogin();
    expect(await handleLichessCallback(`${LICHESS_APP_REDIRECT_URI}?code=c0de&state=forged`)).toBe(
      true,
    );
    expect(useLichessAuth.getState()).toMatchObject({ status: 'error' });
    expect(useLichessAuth.getState().error).toMatch(/did not match/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a callback whose round trip expired', async () => {
    lichessApi();
    const state = await startLogin();
    const p = JSON.parse(localStorage.getItem(PENDING_STORAGE_KEY)!) as Record<string, unknown>;
    localStorage.setItem(
      PENDING_STORAGE_KEY,
      JSON.stringify({ ...p, createdAt: Date.now() - APP_PENDING_TTL_MS - 1 }),
    );
    await handleLichessCallback(`${LICHESS_APP_REDIRECT_URI}?code=c0de&state=${state}`);
    expect(useLichessAuth.getState().status).toBe('error');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps error=access_denied to a cancelled login', async () => {
    const state = await startLogin();
    await handleLichessCallback(
      `${LICHESS_APP_REDIRECT_URI}?error=access_denied&error_description=user+cancelled&state=${state}`,
    );
    expect(useLichessAuth.getState()).toMatchObject({
      status: 'error',
      error: 'Login cancelled on lichess',
    });
    expect(localStorage.getItem(PENDING_STORAGE_KEY)).toBeNull();
  });

  it('returns false for other URLs and leaves the store alone', async () => {
    await startLogin();
    expect(await handleLichessCallback('daisychess://lichess-callback?code=c0de&state=x')).toBe(
      false,
    );
    expect(await handleLichessCallback('https://play.daisychess.org/?code=c0de&state=x')).toBe(
      false,
    );
    expect(await handleLichessCallback(`${LICHESS_APP_REDIRECT_URI}`)).toBe(false); // no parameters
    expect(useLichessAuth.getState().status).toBe('authorizing');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logout after an app login revokes the token as on the web', async () => {
    lichessApi();
    const state = await startLogin();
    await handleLichessCallback(`${LICHESS_APP_REDIRECT_URI}?code=c0de&state=${state}`);
    await useLichessAuth.getState().logout();
    expect(useLichessAuth.getState().status).toBe('anonymous');
    const del = fetchMock.mock.calls.find(
      ([u, i]) => u === 'https://lichess.org/api/token' && i?.method === 'DELETE',
    );
    expect(new Headers(del?.[1]?.headers).get('Authorization')).toBe('Bearer lio_app');
  });
});
