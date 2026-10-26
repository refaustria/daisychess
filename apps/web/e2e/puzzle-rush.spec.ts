import { expect, test } from '@playwright/test';

test('puzzles: rush runs offline from the starter, counts down and ends on request', async ({
  page,
}) => {
  test.setTimeout(60_000);
  // No puzzle server; any shard request during a run would be a bug.
  await page.route('**/puzzles/v1/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Puzzles' }).click();
  await page.getByRole('button', { name: 'Rush' }).click();
  await expect(page.getByTestId('rush-best')).toContainText('3 min 0 · 5 min 0');

  await page.getByRole('button', { name: '3 minutes' }).click();
  await expect(page.getByTestId('rush-status')).toContainText('your move', { timeout: 15_000 });
  await expect(page.getByTestId('rush-timer')).toHaveText(/^2:\d\d$/);
  await expect(page.getByTestId('rush-score')).toContainText('Score 0');

  // The running puzzle is locked into rush mode.
  await expect(page.getByRole('button', { name: 'Puzzles', exact: true })).toBeDisabled();

  await page.getByRole('button', { name: 'End run' }).click();
  await expect(page.getByTestId('rush-result')).toContainText('Final score 0');
  await expect(page.getByRole('button', { name: '5 minutes' })).toBeVisible();
});
