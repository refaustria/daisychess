import { expect, test } from '@playwright/test';

// White (the user, "Alice") misses the mate in one Qxf7# with 4. Nf3??; the generator must turn that into a puzzle
// using the real browser engine (review first, then "Find puzzles in my games").
const PGN = `[White "Alice"]
[Black "Bob"]
[Date "2026.10.01"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Nf3 Nxh5 *`;

test('puzzles: review a game, find mistake puzzles with the browser engine, solve one', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.route('**/puzzles/v1/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.addInitScript(() => {
    localStorage.setItem('daisychess.settings', JSON.stringify({ reviewTour: false }));
    localStorage.setItem('daisychess.puzzles.names', JSON.stringify(['Alice']));
  });
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(PGN);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-status', 'done', {
    timeout: 60_000,
  });

  await page.getByRole('tab', { name: 'Puzzles' }).click();
  await page.getByRole('button', { name: 'Your mistakes' }).click();
  await expect(page.getByTestId('mistakes-stats')).toContainText('0 total');
  await page.getByRole('button', { name: 'Find puzzles in my games' }).click();
  await expect(page.getByTestId('mistakes-result')).toContainText('Search finished', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('mistakes-stats')).toContainText('1 due · 1 total');
  await expect(page.getByTestId('mistakes-list')).toContainText('Alice vs Bob');
  await expect(page.getByTestId('mistakes-list')).toContainText('you played Nf3, best Qxf7#');

  // Solve it: the only move is Qxf7#.
  await page.getByRole('button', { name: 'Train due' }).click();
  const session = page.getByTestId('mistakes-session');
  await expect(session).toContainText('your move', { timeout: 10_000 });
  await page.getByLabel('Move, e.g. Nf3').fill('Qxf7#');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(session).toContainText('finished', { timeout: 10_000 });
  await expect(page.getByTestId('mistakes-stats')).toContainText('0 due · 1 total');
});
