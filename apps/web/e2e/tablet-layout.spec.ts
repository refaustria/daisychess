import { mkdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';

// iPad-like landscape viewport: both player bars must fit in the visible height (100dvh).
test.use({
  viewport: { width: 1366, height: 1024 },
  isMobile: true,
  hasTouch: true,
});

test('tablet landscape: both player bars inside the viewport, no page scroll', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByRole('switch', { name: 'Engine' }).check();
  await page.getByRole('tab', { name: 'Play' }).click();
  await page.getByLabel('Thinking time').selectOption({ label: '0.1 s per move' });
  await page.getByLabel('Time control').selectOption({ label: '3+2 · Blitz' });
  await page.getByRole('radio', { name: 'White' }).check();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('play-status')).toHaveText('Your move');

  const innerHeight = await page.evaluate(() => window.innerHeight);
  for (const id of ['player-bar-top', 'player-bar-bottom']) {
    const box = await page.getByTestId(id).boundingBox();
    if (!box) throw new Error(`${id} has no box`);
    expect(box.y, id).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, id).toBeLessThanOrEqual(innerHeight);
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/tablet-landscape.png` });
});
