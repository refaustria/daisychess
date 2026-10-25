import { expect, test } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

test('loading a game reviews it automatically with move commentary and arrows', async ({
  page,
}) => {
  test.setTimeout(90_000);
  // The guided tour (M20-2) has its own spec; here the card must stay at the start position.
  await page.addInitScript(() =>
    localStorage.setItem('daisychess.settings', JSON.stringify({ reviewTour: false })),
  );
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(SCHOLAR);
  await page.getByRole('button', { name: 'Load PGN' }).click();

  // The Review tab opens by itself and the fast review finishes.
  await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute('aria-selected', 'true');
  const panel = page.getByTestId('review-panel');
  await expect(panel.getByTestId('auto-notice')).toContainText('Auto review (fast)');
  await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 30_000 });
  await expect(panel.getByTestId('accuracy-white')).toHaveText(/\d+%/);
  await expect(panel.getByTestId('accuracy-black')).toHaveText(/\d+%/);
  expect(await panel.locator('[data-point]').count()).toBeGreaterThanOrEqual(7);

  // Loaded games start at ply 0; jump through the mistakes to 3... Nf6.
  const card = panel.getByTestId('move-card');
  await expect(card).toHaveAttribute('aria-label', 'Current move');
  await expect(card).toContainText('Start position');
  const next = card.getByRole('button', { name: 'Next mistake' });
  const played = card.getByTestId('move-card-played');
  for (let i = 0; i < 6; i++) {
    await next.click();
    await expect(played).toBeVisible();
    if ((await played.textContent())?.includes('Nf6')) break;
  }
  await expect(card.getByTestId('move-card-played')).toHaveText('3... Nf6??');
  await expect(card).toContainText('Blunder');
  await expect(card.getByTestId('move-card-better')).toContainText('Better:');
  await expect(card.getByTestId('move-card-text')).toContainText('The engine prefers');
  await expect(page.getByLabel('FEN')).toHaveValue(/^r1bqkb1r\/pppp1ppp\/2n2n2\/4p2Q\//);

  // Played move and best move arrows for the displayed ply.
  expect(await page.locator('.cg-shapes g').count()).toBeGreaterThanOrEqual(1);

  // Highlights per side, clickable.
  await expect(panel.getByRole('region', { name: 'Black highlights' })).toContainText(
    'Moves to improve',
  );
  await panel.getByRole('region', { name: 'White highlights' }).getByRole('button').first().click();
  await expect(card.getByTestId('move-card-played')).toHaveText(/^\d+\. /);
  await panel
    .getByRole('region', { name: 'Black highlights' })
    .getByRole('button', { name: /Nf6/ })
    .click();
  await expect(card.getByTestId('move-card-played')).toHaveText('3... Nf6??');

  await card.scrollIntoViewIfNeeded();
  // Let chessground finish the move animation so the arrows are drawn on settled pieces.
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/review-commentary.png`, fullPage: true });

  // The best line previews on the board.
  await card.getByRole('button', { name: /Preview best line/ }).click();
  await expect(page.getByTestId('preview-banner')).toBeVisible();
  await page.getByTestId('preview-banner').click();

  const download = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export annotated PGN' }).click();
  expect((await download).suggestedFilename()).toBe('daisychess-review.pgn');

  // A manual Deep run replaces the auto review.
  await panel.getByRole('button', { name: 'Run Deep' }).click();
  await expect(panel).toHaveAttribute('data-status', /running|done/);
  await expect(panel.getByTestId('auto-notice')).toHaveCount(0);
});

test('auto review off in Settings: loading does not start a review', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Settings' }).click();
  const toggle = page.getByLabel('Analyse games automatically after loading');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();

  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(SCHOLAR);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await expect(page.getByRole('tab', { name: 'Moves' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Review' }).click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-status', 'idle');

  // The choice persists.
  await page.reload();
  await page.getByRole('tab', { name: 'Settings' }).click();
  await expect(page.getByLabel('Analyse games automatically after loading')).not.toBeChecked();
});
