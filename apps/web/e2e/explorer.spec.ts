import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Position explorer (M12-2). With a pasted token here; the lichess login token is covered in
 * lichess-auth.spec.ts. The live variant hits the real lichess explorer and needs EXPLORER_LIVE=1 and a token in
 * LICHESS_TOKEN (lichess requires authentication for the explorer since Nov 2025).
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Accept,Authorization',
};

const START_RESULT = {
  white: 1000,
  draws: 1200,
  black: 800,
  opening: null,
  moves: [
    { uci: 'e2e4', san: 'e4', averageRating: 2400, white: 500, draws: 500, black: 400, game: null, opening: null },
    { uci: 'd2d4', san: 'd4', averageRating: 2410, white: 400, draws: 600, black: 300, game: null, opening: null },
  ],
  topGames: [
    {
      uci: 'e2e4',
      id: 'mAsTer01',
      winner: 'white',
      white: { name: 'Carlsen, M.', rating: 2882 },
      black: { name: 'Caruana, F.', rating: 2820 },
      year: 2019,
      month: '2019-06',
    },
  ],
};
const E4_RESULT = {
  white: 500,
  draws: 500,
  black: 400,
  opening: { eco: 'B00', name: "King's Pawn" },
  moves: [{ uci: 'e7e5', san: 'e5', averageRating: 2400, white: 200, draws: 200, black: 100, game: null, opening: null }],
  topGames: [],
};
const PGN = '[Event "Test"]\n[White "Carlsen, M."]\n[Black "Caruana, F."]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n';

async function mockExplorer(page: Page, opts: { anonymous401?: boolean } = {}) {
  const seen: { url: string; auth?: string }[] = [];
  await page.route('https://explorer.lichess.org/**', (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const auth = req.headers().authorization;
    seen.push({ url: req.url(), ...(auth ? { auth } : {}) });
    if (opts.anonymous401 && !auth) {
      return route.fulfill({ status: 401, headers: CORS, contentType: 'text/html', body: '<html>401</html>' });
    }
    if (req.url().includes('/masters/pgn/')) {
      return route.fulfill({ status: 200, headers: CORS, contentType: 'application/x-chess-pgn', body: PGN });
    }
    const body = req.url().includes('play=e2e4') ? E4_RESULT : START_RESULT;
    return route.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return seen;
}

async function openExplorer(page: Page, token?: string) {
  if (token !== undefined) {
    await page.addInitScript((t) => {
      localStorage.setItem('chesslab.explorer', JSON.stringify({ db: 'masters', token: t }));
    }, token);
  }
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Explorer' }).click();
}

test.describe('mocked', () => {
  test.skip(!!process.env.EXPLORER_LIVE, 'live run');

  test('stats with the token as a header, play a move from the table', async ({ page }) => {
    const seen = await mockExplorer(page);
    await openExplorer(page, 'lip_e2e');
    await expect(page.getByText('3,000 games')).toBeVisible();
    await expect(page.getByRole('img', { name: /Results: White 33%/ })).toBeVisible();
    expect(seen[0]?.auth).toBe('Bearer lip_e2e');
    expect(seen.every((r) => !r.url.includes('lip_e2e'))).toBe(true);

    await page.getByRole('button', { name: 'Play e4' }).click();
    await expect(page.getByTestId('explorer-opening')).toHaveText("B00 King's Pawn");
    await expect(page.getByText('1,400 games')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play e5' })).toBeVisible();
  });

  test('load a master game from the list', async ({ page }) => {
    await mockExplorer(page);
    await openExplorer(page, 'lip_e2e');
    await page.getByRole('button', { name: 'Load Carlsen, M. – Caruana, F.' }).click();
    await expect(page.getByText('Loaded: Carlsen, M. – Caruana, F.')).toBeVisible();
    await page.getByRole('tab', { name: 'Moves' }).click();
    await expect(page.getByText('Nc6')).toBeVisible();
  });

  test('no token → token required, saving one fetches', async ({ page }) => {
    await mockExplorer(page, { anonymous401: true });
    await openExplorer(page);
    await expect(page.getByRole('alert')).toContainText('requires authentication');
    await expect(page.getByRole('alert').getByRole('button', { name: 'Log in with lichess' })).toBeVisible();
    await page.getByLabel('or paste a token').fill('lip_new');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('3,000 games')).toBeVisible();
  });

  test('429 → rate limited message', async ({ page }) => {
    await page.route('https://explorer.lichess.org/**', (route) =>
      route.fulfill({ status: 429, headers: { ...CORS, 'retry-after': '30' }, body: '' }),
    );
    await openExplorer(page, 'lip_e2e');
    await expect(page.getByRole('alert')).toContainText('Rate limited by lichess');
  });
});

test.describe('live', () => {
  test.skip(!process.env.EXPLORER_LIVE || !process.env.LICHESS_TOKEN, 'set EXPLORER_LIVE=1 and LICHESS_TOKEN');

  test('real masters explorer for the start position', async ({ page }) => {
    await openExplorer(page, process.env.LICHESS_TOKEN ?? '');
    await expect(page.getByText(/[\d,]+ games/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Play e4' })).toBeVisible();
  });
});
