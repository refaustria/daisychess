import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
// A lichess 3+2 blitz export with clocks=true; White blunders the queen with 8 s left (18. Qg5??).
const PGN = readFileSync(new URL('./fixtures/lichess-blitz-clocks.pgn', import.meta.url), 'utf8');

test('clock times of an imported game: bar clocks per ply, time used and time trouble in the review', async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The guided tour would move the board by itself.
  await page.addInitScript(() =>
    localStorage.setItem('daisychess.settings', JSON.stringify({ reviewTour: false })),
  );
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(PGN);
  await page.getByRole('button', { name: 'Load PGN' }).click();

  // Loaded games start at ply 0: both clocks show the initial time, static.
  const white = page.getByTestId('pgn-clock-white');
  const black = page.getByTestId('pgn-clock-black');
  await expect(white).toHaveText('3:00');
  await expect(black).toHaveText('3:00');
  await expect(white).toHaveAttribute('data-state', 'idle');

  // Stepping through the moves updates the bars.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect(white).toHaveText('2:59');
  await expect(black).toHaveText('3:00');
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  // Ply 24 (12... Rxe6): White 1:01, Black 2:10.
  await expect(white).toHaveText('1:01');
  await expect(black).toHaveText('2:10');
  await page.keyboard.press('End');
  await expect(white).toHaveText('0:07.0');
  await expect(black).toHaveText('1:51');

  const panel = page.getByTestId('review-panel');
  await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 60_000 });
  await expect(panel.getByTestId('time-graph')).toBeVisible();
  await expect(panel.getByTestId('time-summary')).toContainText('Average per move');

  // The late blunder: in White's "Moves to improve" with the time-trouble badge.
  const whiteHighlights = panel.getByRole('region', { name: 'White highlights' });
  const blunder = whiteHighlights.getByRole('button', { name: /18\. Qg5/ });
  await expect(blunder).toContainText('time trouble');
  await blunder.click();
  const card = panel.getByTestId('move-card');
  await expect(card.getByTestId('move-card-played')).toHaveText(/^18\. Qg5\?\?/);
  await expect(card.getByTestId('move-card-time')).toHaveText(
    'Used 0:06 (50% of remaining) · 0:08 left',
  );
  await expect(card.getByTestId('time-trouble-badge')).toBeVisible();
  await expect(white).toHaveText('0:08.0');
  await expect(black).toHaveText('1:55');

  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/review-clocks.png`, fullPage: true });
  await panel.getByTestId('time-summary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/review-clocks-graph.png`, fullPage: true });
});
