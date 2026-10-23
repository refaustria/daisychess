import { expect, test, type Page } from '@playwright/test';

const CORS = { 'access-control-allow-origin': '*' };

const LI_GAME = {
  id: 'abc12345',
  speed: 'blitz',
  createdAt: 1700000000000,
  status: 'mate',
  winner: 'white',
  players: {
    white: { user: { name: 'Alice', id: 'alice' }, rating: 1800 },
    black: { user: { name: 'Bob', id: 'bob' }, rating: 1750 },
  },
  opening: { eco: 'C20', name: "King's Pawn Game" },
  clock: { initial: 180, increment: 2, totalTime: 260 },
};
const LI_GAME_2 = { ...LI_GAME, id: 'def67890', winner: 'black', players: { white: LI_GAME.players.black, black: LI_GAME.players.white } };
const LI_PGN =
  '[Event "rated blitz game"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 1-0\n';

const cc = (n: number, white: string, black: string) => ({
  url: `https://www.chess.com/game/live/${n}`,
  pgn: `[Event "Live Chess"]\n[White "${white}"]\n[Black "${black}"]\n[Result "0-1"]\n\n1. d4 d5 2. c4 e6 3. Nc3 Nf6 4. Bg5 0-1\n`,
  end_time: 1700000000 + n,
  time_class: 'rapid',
  time_control: '600',
  eco: 'https://www.chess.com/openings/Queens-Gambit-Declined',
  white: { username: white, rating: 1500, result: 'resigned' },
  black: { username: black, rating: 1600, result: 'win' },
});

async function mockApis(page: Page) {
  await page.route('https://lichess.org/api/games/user/**', (route) => {
    const url = route.request().url();
    if (url.includes('/ghost')) return route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{"error":"Not found"}' });
    return route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/x-ndjson',
      body: `${JSON.stringify(LI_GAME)}\n${JSON.stringify(LI_GAME_2)}\n`,
    });
  });
  await page.route('https://lichess.org/game/export/**', (route) =>
    route.fulfill({ status: 200, headers: CORS, contentType: 'application/x-chess-pgn', body: LI_PGN }),
  );
  await page.route('https://api.chess.com/pub/player/*/games/archives', (route) =>
    route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ archives: ['https://api.chess.com/pub/player/carol/games/2023/11'] }),
    }),
  );
  await page.route('https://api.chess.com/pub/player/carol/games/2023/11', (route) =>
    route.fulfill({
      status: 200,
      headers: CORS,
      contentType: 'application/json',
      body: JSON.stringify({ games: [cc(1, 'Carol', 'Dave'), cc(2, 'Erin', 'Carol')] }),
    }),
  );
}

test.beforeEach(async ({ page }) => {
  await mockApis(page);
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Import' }).click();
});

test('lichess: fetch, pick a game, moves load', async ({ page }) => {
  const group = page.getByRole('radiogroup', { name: 'Site' });
  await expect(group.getByRole('radio', { name: 'lichess' })).toBeChecked();
  await page.getByLabel('Username').fill('Alice');
  await page.getByLabel('Username').press('Enter');
  const rows = page.getByRole('list', { name: 'Recent games' }).getByRole('button');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Alice (1800)');
  await expect(rows.first()).toContainText('Bob (1750)');
  await expect(rows.first()).toContainText('1-0 · 2023-11-14 · 3+2');
  await rows.first().click();
  // Picking a game starts the automatic review on the Review tab.
  await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-status', /running|done/);
  await page.getByRole('tab', { name: 'Moves' }).click();
  await expect(page.getByTestId('movelist').getByRole('button')).toHaveCount(6);
  await expect(page.getByTestId('movelist')).toContainText('Nf3');
  // The username never ends up in our own URL.
  expect(page.url()).not.toContain('Alice');
});

test('chess.com: fetch, pick a game, moves load', async ({ page }) => {
  await page.getByRole('radio', { name: 'chess.com' }).check();
  await page.getByLabel('Username').fill('Carol');
  await page.getByRole('button', { name: 'Fetch games' }).click();
  const rows = page.getByRole('list', { name: 'Recent games' }).getByRole('button');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Erin (1500)');
  await rows.first().click();
  await page.getByRole('tab', { name: 'Moves' }).click();
  await expect(page.getByTestId('movelist').getByRole('button')).toHaveCount(7);
  await expect(page.getByTestId('movelist')).toContainText('Bg5');
});

test('shows a not-found message for an unknown user', async ({ page }) => {
  await page.getByLabel('Username').fill('ghost');
  await page.getByRole('button', { name: 'Fetch games' }).click();
  await expect(page.getByRole('alert')).toHaveText('User "ghost" not found on lichess');
});

test('rejects an invalid username without a request', async ({ page }) => {
  await page.getByLabel('Username').fill('a b');
  await page.getByRole('button', { name: 'Fetch games' }).click();
  await expect(page.getByRole('alert')).toContainText('valid username');
});

test('remembers the username across reloads', async ({ page }) => {
  await page.getByLabel('Username').fill('Alice');
  await page.getByRole('button', { name: 'Fetch games' }).click();
  await expect(page.getByRole('list', { name: 'Recent games' })).toBeVisible();
  await page.reload();
  await page.getByRole('tab', { name: 'Import' }).click();
  await expect(page.getByLabel('Username')).toHaveValue('Alice');
});

test.describe('live', () => {
  test.skip(!process.env.ONLINE_IMPORT_LIVE, 'set ONLINE_IMPORT_LIVE=1 to hit the real lichess API');
  test('real lichess account', async ({ page }) => {
    await page.unrouteAll();
    await page.getByLabel('Username').fill('DrNykterstein');
    await page.getByRole('button', { name: 'Fetch games' }).click();
    const rows = page.getByRole('list', { name: 'Recent games' }).getByRole('button');
    await expect(rows.first()).toBeVisible({ timeout: 20_000 });
    await rows.first().click();
    await expect(page.getByTestId('movelist').getByRole('button').first()).toBeVisible();
  });
});
