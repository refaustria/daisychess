import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * "Log in with lichess" (M13-1): OAuth PKCE round trip with mocked lichess endpoints. The
 * callback is simulated by opening `/?code=…&state=…` with the pending verifier/state already in
 * sessionStorage (as `login()` leaves them before redirecting).
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Accept,Authorization,Content-Type',
  'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
};
const STATE = 'e2eStateValue0123456789abcdefgh';
const VERIFIER = 'e2e-verifier-'.padEnd(64, 'x');
const TOKEN = 'lio_e2eToken';

interface Seen {
  tokenBody?: Record<string, string>;
  accountAuth?: string;
  revoked?: string;
  explorerAuth: string[];
  explorerUrls: string[];
}

async function mockLichess(page: Page): Promise<Seen> {
  const seen: Seen = { explorerAuth: [], explorerUrls: [] };
  await page.route('https://lichess.org/api/token', async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (req.method() === 'DELETE') {
      seen.revoked = req.headers().authorization ?? '';
      return route.fulfill({ status: 204, headers: CORS });
    }
    seen.tokenBody = Object.fromEntries(new URLSearchParams(req.postData() ?? ''));
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ token_type: 'Bearer', access_token: TOKEN, expires_in: 31536000 }),
    });
  });
  await page.route('https://lichess.org/api/account', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    seen.accountAuth = req.headers().authorization ?? '';
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'e2euser', username: 'E2eUser' }),
    });
  });
  await page.route('https://explorer.lichess.org/**', (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const auth = req.headers().authorization;
    seen.explorerUrls.push(req.url());
    if (auth) seen.explorerAuth.push(auth);
    if (!auth) return route.fulfill({ status: 401, headers: CORS, contentType: 'text/html', body: '401' });
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({
        white: 10,
        draws: 5,
        black: 5,
        opening: null,
        moves: [{ uci: 'e2e4', san: 'e4', averageRating: 2400, white: 10, draws: 5, black: 5 }],
        topGames: [],
      }),
    });
  });
  return seen;
}

test('callback logs in, cleans the URL; explorer uses the token; logout revokes', async ({ page, baseURL }) => {
  const seen = await mockLichess(page);
  await page.addInitScript(
    ({ state, verifier, redirectUri }) => {
      if (location.search.includes('code=')) {
        sessionStorage.setItem('chesslab.lichess.pkce', JSON.stringify({ verifier, state, redirectUri }));
      }
    },
    { state: STATE, verifier: VERIFIER, redirectUri: `${baseURL}/` },
  );
  await page.goto(`/?code=abc&state=${STATE}`);
  await expect(page.locator('cg-board')).toBeVisible();

  const chip = page.getByTestId('account-chip');
  await expect(chip).toHaveText('E2eUser');
  expect(new URL(page.url()).search).toBe('');
  expect(seen.tokenBody).toEqual({
    grant_type: 'authorization_code',
    code: 'abc',
    code_verifier: VERIFIER,
    redirect_uri: `${baseURL}/`,
    client_id: 'chesslab.c.referee.at',
  });
  expect(seen.accountAuth).toBe(`Bearer ${TOKEN}`);

  await chip.click();
  await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  const account = page.getByTestId('lichess-account');
  await expect(account).toContainText('Logged in as E2eUser');
  await expect(account.getByRole('list', { name: 'Granted permissions' })).toContainText('board:play');

  await page.getByRole('tab', { name: 'Explorer' }).click();
  await expect(page.getByText('20 games')).toBeVisible();
  await expect(page.getByTestId('explorer-auth')).toHaveText('Using your lichess login (E2eUser)');
  expect(seen.explorerAuth[0]).toBe(`Bearer ${TOKEN}`);
  expect(seen.explorerUrls.every((u) => !u.includes(TOKEN))).toBe(true);

  // Survives a reload.
  await page.reload();
  await expect(page.getByTestId('account-chip')).toHaveText('E2eUser');

  await page.getByTestId('account-chip').click();
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.getByTestId('account-chip')).toHaveText('Log in');
  await expect(page.getByTestId('lichess-account').getByRole('button', { name: 'Log in with lichess' })).toBeVisible();
  await expect.poll(() => seen.revoked).toBe(`Bearer ${TOKEN}`);
  expect(await page.evaluate(() => localStorage.getItem('chesslab.lichess'))).toBeNull();
  expect(page.url()).not.toContain(TOKEN);
});

test('a forged state is rejected without a token request', async ({ page }) => {
  const seen = await mockLichess(page);
  await page.addInitScript(() => {
    if (location.search.includes('code=')) {
      sessionStorage.setItem(
        'chesslab.lichess.pkce',
        JSON.stringify({ verifier: 'v'.repeat(64), state: 'expected', redirectUri: `${location.origin}/` }),
      );
    }
  });
  await page.goto('/?code=abc&state=forged');
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.getByTestId('account-chip')).toHaveText('Log in');
  await page.getByTestId('account-chip').click();
  await expect(page.getByTestId('lichess-account').getByRole('alert')).toContainText('did not match');
  expect(seen.tokenBody).toBeUndefined();
  expect(new URL(page.url()).search).toBe('');
});

test('Log in navigates to lichess.org/oauth with PKCE parameters and scopes', async ({ page, baseURL }) => {
  await page.route('https://lichess.org/oauth*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>stub' }),
  );
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await expect(page.getByTestId('account-chip')).toHaveText('Log in');
  await page.getByTestId('account-chip').click();
  const btn = page.getByTestId('lichess-account').getByRole('button', { name: 'Log in with lichess' });
  await expect(btn).toHaveAttribute('title', /board:play, challenge:read, challenge:write/);
  // sessionStorage is per origin: read the pending login before leaving the page.
  const nav = page.waitForURL(/^https:\/\/lichess\.org\/oauth\?/);
  await btn.click();
  await nav;
  const url = new URL(page.url());
  const p = url.searchParams;
  expect(p.get('response_type')).toBe('code');
  expect(p.get('client_id')).toBe('chesslab.c.referee.at');
  expect(p.get('redirect_uri')).toBe(`${baseURL}/`);
  expect(p.get('code_challenge_method')).toBe('S256');
  expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(p.get('scope')).toBe('board:play challenge:read challenge:write');
  expect(p.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);

  // Back on ChessLab: the pending state matches the one sent to lichess.
  await page.goto('/');
  const pending = await page.evaluate(() => sessionStorage.getItem('chesslab.lichess.pkce'));
  expect(JSON.parse(pending ?? '{}')).toMatchObject({ state: p.get('state'), redirectUri: `${baseURL}/` });
});
