import { expect, test } from '@playwright/test';

// M32-11: the Endgames select of the puzzle filters serves a rook-endgame puzzle from the bundled
// starter, offline (no puzzle server, no tablebase).
test('puzzles: Endgames select, Rook endgames, a starter puzzle offline', async ({ page }) => {
  test.setTimeout(60_000);
  await page.route('**/puzzles/v1/**', (route) => route.fulfill({ status: 404, body: '' }));
  const asked: string[] = [];
  await page.route('https://tablebase.lichess.ovh/**', (route) => {
    asked.push(route.request().url());
    return route.abort();
  });
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Puzzles' }).click();

  await page.getByText('Filters', { exact: true }).click();
  await page.getByLabel('Endgames', { exact: true }).selectOption('rookEndgame');
  await expect(page.getByTestId('puzzle-filter-active')).toContainText('Rook endgames');

  await page.getByRole('button', { name: 'Start puzzles' }).click();
  await expect(page.getByTestId('puzzle-status')).toContainText('Your turn', { timeout: 15_000 });
  // A rook ending: few pieces on the board.
  const pieces = await page.locator('cg-board piece').count();
  expect(pieces).toBeLessThanOrEqual(14);
  expect(asked).toEqual([]);
});
