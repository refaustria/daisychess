import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// M32-8: the Endgames tab (course list, lesson view, phone action bar). The K+Q vs K lesson runs
// on the bundled core tables: no request may reach the lichess tablebase.

async function noLichess(page: Page): Promise<string[]> {
  const asked: string[] = [];
  await page.route('https://tablebase.lichess.ovh/**', (route) => {
    asked.push(route.request().url());
    return route.abort();
  });
  return asked;
}

async function checkA11y(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).include('#tabpanel-main').analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    blocking.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) })),
    label,
  ).toEqual([]);
}

test('endgames: course list, K+Q vs K with typed moves, a thrown move, take back and hint', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const asked = await noLichess(page);
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Endgames' }).click();
  await expect(page.getByTestId('endgames-course')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Rook endings' })).toBeVisible();
  await checkA11y(page, 'course list');

  await page.getByTestId('lesson-kq-vs-k').click();
  const status = page.getByTestId('lesson-status');
  await expect(status).toHaveText('Your move (White).', { timeout: 15_000 });
  await expect(page.getByTestId('lesson-budget')).toContainText('tables on this device');
  await checkA11y(page, 'lesson view');

  const input = page.getByLabel('Move, e.g. Qd5');
  await input.fill('Qe4+');
  await input.press('Enter');
  await expect(status).toContainText('Qe4+? throws away the win — the position is a draw now.');
  await expect(page.getByTestId('lesson-summary')).toBeVisible();
  await checkA11y(page, 'lesson result');
  await page.getByRole('button', { name: 'Take back' }).click();
  await expect(status).toHaveText('Your move (White).');

  await page.getByRole('button', { name: 'Hint' }).click();
  await expect(page.getByTestId('lesson-hints').getByRole('listitem')).toHaveCount(1);

  // A good move gets the opponent's reply on the board.
  await input.fill('Qb5+');
  await input.press('Enter');
  await expect(status).toContainText('Your move (White).');
  await expect(page.getByTestId('lesson-budget')).toContainText('13 left');

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('endgames-course')).toBeVisible();
  await expect(page.getByTestId('lesson-kq-vs-k')).toHaveAttribute('data-mark', 'due');
  expect(asked).toEqual([]);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('the action bar shows Hint · Take back · Stop while a lesson runs', async ({ page }) => {
    test.setTimeout(60_000);
    await noLichess(page);
    await page.goto('/');
    await page.getByRole('button', { name: /^More/ }).click();
    await page
      .getByRole('dialog', { name: 'More' })
      .getByRole('button', { name: 'Endgames' })
      .click();
    const bar = page.getByTestId('action-bar');
    await expect(page.getByTestId('endgames-course')).toBeVisible();
    await expect(bar).toHaveAttribute('data-kind', 'analysis');

    await page.getByTestId('lesson-kq-vs-k').click();
    await expect(page.getByTestId('lesson-status')).toHaveText('Your move (White).', {
      timeout: 15_000,
    });
    await expect(bar).toHaveAttribute('data-kind', 'endgames');
    await expect(bar.getByRole('button', { name: 'Hint' })).toBeEnabled();
    await expect(bar.getByRole('button', { name: 'Take back' })).toBeDisabled();
    // The panel's copies are hidden on phones (one control per action).
    await expect(page.getByRole('button', { name: 'Hint' })).toHaveCount(1);
    await bar.getByRole('button', { name: 'Hint' }).click();
    await expect(page.getByTestId('lesson-hints').getByRole('listitem')).toHaveCount(1);
    await bar.getByRole('button', { name: 'Stop lesson' }).click();
    await expect(page.getByTestId('endgames-course')).toBeVisible();
    await expect(bar).toHaveAttribute('data-kind', 'analysis');
  });
});
