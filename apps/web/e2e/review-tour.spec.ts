import { expect, test } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const PGN = '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5 5. Nxf7 Qxg2 6. Rf1 Qxe4+ 7. Be2 Nf3#';

test('a finished review guides through the game, pauses on a blunder and stops on navigation', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(PGN);
  await page.getByRole('button', { name: 'Load PGN' }).click();

  const panel = page.getByTestId('review-panel');
  await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  const bar = page.getByTestId('review-tour');
  await expect(bar).toBeVisible();
  await expect(bar).toContainText(/Tour: \d+ of \d+ highlights?/);

  // The tour moves the board and pauses on a highlight with its text.
  const text = page.getByTestId('review-tour-text');
  await expect(text).toContainText(/Blunder|Mistake/, { timeout: 30_000 });
  await expect(page.getByLabel('FEN')).not.toHaveValue(/^rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP/);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/review-tour.png`, fullPage: true });

  // Any navigation stops the tour.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('ArrowLeft');
  await expect(bar).toHaveAttribute('data-status', 'stopped');
  await expect(text).toHaveText('Tour stopped.');
  await expect(bar.getByRole('button', { name: 'Replay tour' })).toBeVisible();

  await bar.getByRole('button', { name: 'Replay tour' }).click();
  await expect(bar).toHaveAttribute('data-status', /playing|paused/);
});
