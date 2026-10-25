import { expect, test } from '@playwright/test';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

async function loadPgn(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(SCHOLAR);
  await page.getByRole('button', { name: 'Load PGN' }).click();
}

test('a reviewed game is shown from the review cache after a reload, without running again', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();

  // First load: the automatic fast review runs and is stored.
  await loadPgn(page);
  const panel = page.getByTestId('review-panel');
  await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  await expect(panel.getByTestId('review-engine')).toHaveText(/^Reviewed /);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByTestId('review-cache-count')).toHaveText('1 stored review');

  await page.reload();
  await expect(page.locator('cg-board')).toBeVisible();
  // Record whether a progress bar or a running review ever shows up after the load.
  await page.evaluate(() => {
    const w = window as unknown as { __sawRun: boolean };
    w.__sawRun = false;
    new MutationObserver(() => {
      if (
        document.querySelector('[role="progressbar"][aria-label="Review progress"]') ||
        document.querySelector('[data-testid="review-panel"][data-status="running"]')
      ) {
        w.__sawRun = true;
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-status'],
    });
  });

  const t0 = Date.now();
  await loadPgn(page);
  await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 5_000 });
  const ms = Date.now() - t0;
  console.log(`cached review shown after ${ms} ms`);
  await expect(panel.getByTestId('review-engine')).toHaveText(
    /^Loaded from cache \(reviewed \d{1,2} [A-Z][a-z]{2}, fast, (browser|server)\)$/,
  );
  await expect(panel.getByTestId('accuracy-white')).toHaveText(/\d+%/);
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __sawRun: boolean }).__sawRun)).toBe(
    false,
  );
  // Fast is stored: Fast cannot be started again, Deep can.
  const startBtn = panel.getByRole('button', { name: 'Start' });
  await expect(startBtn).toBeEnabled();
  await panel.getByRole('radio', { name: /Fast/ }).click();
  await expect(startBtn).toBeDisabled();
  await expect(panel.getByTestId('review-already')).toHaveText('Already reviewed (fast)');
});
