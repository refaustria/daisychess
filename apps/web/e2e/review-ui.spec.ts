import { expect, test } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

test('game review from the UI', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(SCHOLAR);
  await page.getByRole('button', { name: 'Load PGN' }).click();

  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByRole('radio', { name: /Fast/ }).click();
  await page.getByRole('button', { name: 'Start' }).click();

  const panel = page.getByTestId('review-panel');
  await expect(panel.getByTestId('accuracy-white')).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId('accuracy-white')).toHaveText(/\d+%/);
  await expect(panel.getByTestId('accuracy-black')).toHaveText(/\d+%/);

  expect(await panel.locator('[data-point]').count()).toBeGreaterThanOrEqual(7);

  const moment = panel.getByRole('button', { name: /Nf6/ });
  await expect(moment).toBeVisible();
  const before = await page.getByLabel('FEN').inputValue();
  await moment.click();
  await expect(page.getByLabel('FEN')).not.toHaveValue(before);

  await page.screenshot({ path: `${SHOTS}/review.png`, fullPage: true });

  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export annotated PGN' }).click();
  expect((await download).suggestedFilename()).toBe('chesslab-review.pgn');
});
