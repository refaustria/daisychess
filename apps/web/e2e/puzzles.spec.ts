import { expect, test } from '@playwright/test';

// Stage 1 beyond solving (puzzle-solve.spec.ts) and rush (puzzle-rush.spec.ts): filters, the daily
// puzzle, the offline fallback and the link from the openings trainer. With /puzzles/v1/** blocked
// the data layer must fall back to the bundled starter set.
test.beforeEach(async ({ page }) => {
  await page.route('**/puzzles/v1/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
});

test('puzzles: offline fallback shows the starter, a theme filter applies to the next puzzle', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.getByRole('tab', { name: 'Puzzles' }).click();
  await page.getByText('Filters', { exact: true }).click();
  await expect(page.getByText('Counts are for the puzzles bundled with the app.')).toBeVisible();
  await expect(page.getByTestId('puzzle-offline-status')).toContainText('once the puzzle list');

  await page.getByLabel('Theme', { exact: true }).selectOption('mateIn2');
  await expect(page.getByTestId('puzzle-filter-active')).toContainText('Mate in 2');
  await page.getByRole('button', { name: 'Start puzzles' }).click();
  await expect(page.getByTestId('puzzle-status')).toContainText('Your turn', { timeout: 15_000 });

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await expect(page.getByTestId('puzzle-filter-active')).toHaveCount(0);
});

test('puzzles: daily puzzle starts from the bundled pool and records the day', async ({ page }) => {
  test.setTimeout(60_000);
  await page.getByRole('tab', { name: 'Puzzles' }).click();
  const daily = page.getByTestId('puzzle-daily');
  await expect(daily.getByTestId('puzzle-daily-streak')).toHaveText('Streak 0 days');
  await expect(daily.getByRole('list', { name: 'Last 30 days' }).locator('li')).toHaveCount(30);

  await daily.getByRole('button', { name: 'Solve today’s puzzle' }).click();
  await expect(page.getByTestId('puzzle-status')).toContainText('Your turn', { timeout: 15_000 });
  // Giving up counts as a miss for the day (first result only).
  await page.getByRole('button', { name: 'Show solution' }).click();
  await expect(page.getByTestId('puzzle-daily-result')).toHaveText('Missed today', {
    timeout: 15_000,
  });
  await expect(daily.getByRole('button', { name: 'Play again' })).toBeVisible();
});

test('puzzles: "Puzzles from this opening" in the openings trainer filters the Puzzles tab', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.getByRole('tab', { name: 'Openings' }).click();
  await page.getByRole('searchbox').fill('Sicilian Defense');
  await page
    .getByRole('button', { name: /Sicilian Defense/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Puzzles from this opening' }).click();
  await expect(page.getByRole('tab', { name: 'Puzzles', selected: true })).toBeVisible();
  await expect(page.getByTestId('puzzle-filter-active')).toContainText('Sicilian');
});
