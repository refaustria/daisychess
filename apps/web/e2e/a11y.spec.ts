import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

/** Fails on serious/critical violations; moderate/minor ones are only logged. */
async function checkA11y(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const minor = violations.filter((v) => v.impact !== 'serious' && v.impact !== 'critical');
  if (minor.length) {
    test.info().annotations.push({
      type: `axe ${label}`,
      description: minor.map((v) => `${v.id} (${v.impact})`).join(', '),
    });
  }
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(' ')),
    })),
    label,
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
});

test('start page', async ({ page }) => {
  await checkA11y(page, 'start');
});

test('engine on with 3 lines', async ({ page }) => {
  await page.getByRole('switch', { name: 'Engine' }).check();
  await expect(page.getByTestId('engine-status')).toContainText(/depth \d+/, { timeout: 30_000 });
  await page.getByLabel('Lines').selectOption('3');
  await expect(page.locator('[data-multipv="3"]')).toBeVisible({ timeout: 30_000 });
  await checkA11y(page, 'engine');
});

test('import, review (idle), settings tabs', async ({ page }) => {
  await page.getByRole('tab', { name: 'Import' }).click();
  await checkA11y(page, 'import');
  await page.getByLabel('PGN text').fill(SCHOLAR);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await page.getByRole('tab', { name: 'Review' }).click();
  await checkA11y(page, 'review');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await checkA11y(page, 'settings');
});

test('finished review with badges, light and dark', async ({ page }) => {
  test.setTimeout(90_000);
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(SCHOLAR);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await page.getByRole('tab', { name: 'Review' }).click();
  await page.getByRole('radio', { name: /Fast/ }).click();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('accuracy-white')).toBeVisible({ timeout: 30_000 });
  await checkA11y(page, 'review done');
  await page.getByRole('tab', { name: 'Moves' }).click();
  await checkA11y(page, 'moves with badges');
  await page.getByRole('button', { name: /dark theme/ }).click();
  await checkA11y(page, 'moves with badges dark');
  await page.getByRole('tab', { name: 'Review' }).click();
  await checkA11y(page, 'review done dark');
});

test('dark theme', async ({ page }) => {
  await page.getByRole('button', { name: /dark theme/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await checkA11y(page, 'dark start');
  await page.getByRole('switch', { name: 'Engine' }).check();
  await expect(page.getByTestId('engine-status')).toContainText(/depth \d+/, { timeout: 30_000 });
  await checkA11y(page, 'dark engine');
  await page.getByRole('tab', { name: 'Settings' }).click();
  await checkA11y(page, 'dark settings');
});

test('tabs follow the WAI-ARIA pattern', async ({ page }) => {
  const moves = page.getByRole('tab', { name: 'Moves' });
  await moves.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Play' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Play' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Settings' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(moves).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toBeVisible();
});

test('reduced motion disables the eval bar transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const d = await page
    .locator('[data-testid="eval-bar"] *')
    .evaluateAll((els) => els.map((e) => getComputedStyle(e).transitionDuration));
  for (const x of d) expect(x.split(',').every((s) => parseFloat(s) < 0.001)).toBe(true);
});
