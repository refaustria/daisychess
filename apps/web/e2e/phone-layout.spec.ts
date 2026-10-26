import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// M29-6: phone portrait layout. Action bar under the board, bottom tab bar, "⋯" options menu; the
// tab panel is the only scrolling region. Screenshots for review go to E2E_PHONE_SHOTS.
const SHOTS = process.env.E2E_PHONE_SHOTS ?? 'test-results/screenshots/phone';
const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

const SIZES = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
];

async function squareCentre(page: Page, sq: string) {
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error('cg-board has no box');
  const s = box.width / 8;
  const col = sq.charCodeAt(0) - 97;
  const row = 7 - (Number(sq[1]) - 1);
  return { x: box.x + (col + 0.5) * s, y: box.y + (row + 0.5) * s };
}

async function drag(page: Page, from: string, to: string) {
  const a = await squareCentre(page, from);
  const b = await squareCentre(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}

async function checkA11y(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    blocking.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) })),
    label,
  ).toEqual([]);
}

/**
 * Board, action bar and tab bar inside the viewport, no page scroll in either direction, the
 * action bar right under the board, at least ~120 px of panel visible between bar and tab bar.
 */
async function expectPhoneLayout(page: Page) {
  const vp = page.viewportSize()!;
  const board = (await page.getByTestId('board').boundingBox())!;
  const bar = (await page.getByTestId('action-bar').boundingBox())!;
  const tabs = (await page.getByTestId('bottom-tabs').boundingBox())!;
  const panel = (await page.getByTestId('phone-panel').boundingBox())!;
  expect(board.y).toBeGreaterThanOrEqual(0);
  expect(board.x + board.width).toBeLessThanOrEqual(vp.width);
  expect(bar.y).toBeGreaterThan(board.y + board.height);
  expect(bar.y + bar.height).toBeLessThanOrEqual(tabs.y);
  expect(tabs.y + tabs.height).toBeLessThanOrEqual(vp.height + 0.5);
  expect(panel.y).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
  expect(panel.y + panel.height).toBeLessThanOrEqual(tabs.y + 0.5);
  expect(panel.height).toBeGreaterThanOrEqual(115);
  const scroll = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    h: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(scroll.w).toBeLessThanOrEqual(0);
  expect(scroll.h).toBeLessThanOrEqual(1);
}

function bar(page: Page) {
  return page.getByTestId('action-bar');
}

async function openMore(page: Page, item: string) {
  await page.getByRole('button', { name: /^More/ }).click();
  const sheet = page.getByRole('dialog', { name: 'More' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: item, exact: true }).click();
  await expect(sheet).toBeHidden();
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.beforeEach(async ({ page }) => {
  // No puzzle server: the data layer falls back to the bundled starter set.
  await page.route('**/puzzles/v1/**', (route) => route.fulfill({ status: 404, body: '' }));
});

for (const size of SIZES) {
  const tag = `${size.width}x${size.height}`;

  test.describe(`phone ${tag}`, () => {
    test.use({ viewport: size, hasTouch: true });

    test('analysis: bar navigates the game, desktop controls are gone, axe clean', async ({
      page,
    }) => {
      await page.goto('/');
      await expect(page.locator('cg-board')).toBeVisible();
      await expect(bar(page)).toHaveAttribute('data-kind', 'analysis');
      await expectPhoneLayout(page);
      // The FEN row, the Controls block and the top tab row are not shown on phones.
      await expect(page.getByLabel('FEN')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'New game' })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'Moves' })).toHaveCount(0);
      await expect(page.getByRole('tab', { name: 'Analysis' })).toHaveAttribute(
        'aria-selected',
        'true',
      );

      await drag(page, 'e2', 'e4');
      await expect(page.getByTestId('status')).toHaveText('Black to move');
      await bar(page).getByRole('button', { name: 'Previous move' }).click();
      await expect(page.getByTestId('status')).toHaveText('White to move');
      await bar(page).getByRole('button', { name: 'Next move' }).click();
      await expect(page.getByTestId('status')).toHaveText('Black to move');
      const engine = bar(page).getByRole('button', { name: 'Engine' });
      await expect(engine).toHaveAttribute('aria-pressed', 'false');
      await checkA11y(page, `analysis ${tag}`);
      if (size.width === 390) await shot(page, 'analysis-390x844-light');
    });

    test('puzzles: Start, Hint, Solution and Next in the bar without scrolling', async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await page.goto('/');
      await page.getByRole('tab', { name: 'Puzzles' }).click();
      await expect(bar(page)).toHaveAttribute('data-kind', 'puzzles');
      await bar(page).getByRole('button', { name: 'Start puzzles' }).click();
      await expect(page.getByTestId('puzzle-status')).toContainText('Your turn', {
        timeout: 15_000,
      });
      await expectPhoneLayout(page);
      // Each control exists once: the panel copies are hidden on phones.
      await expect(page.getByRole('button', { name: 'Show solution' })).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Next puzzle' })).toHaveCount(1);
      await bar(page).getByRole('button', { name: 'Hint' }).click();
      await expect(page.getByTestId('puzzle-status')).toContainText('Hint');
      await checkA11y(page, `puzzles ${tag}`);
      await bar(page).getByRole('button', { name: 'Show solution' }).click();
      await expect(page.getByTestId('puzzle-status')).toContainText('Solution shown', {
        timeout: 15_000,
      });
      await expect(bar(page).getByRole('button', { name: 'Analyse' })).toBeVisible();
      const meta = await page.getByTestId('puzzle-meta').textContent();
      await bar(page).getByRole('button', { name: 'Next puzzle' }).click();
      await expect(page.getByTestId('puzzle-status')).toContainText('Your turn', {
        timeout: 15_000,
      });
      await expect(page.getByTestId('puzzle-meta')).not.toHaveText(meta ?? '');
      await expectPhoneLayout(page);
      if (size.width === 390) {
        await shot(page, 'puzzles-390x844-light');
        await page.getByRole('button', { name: 'Switch to dark theme' }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
        await checkA11y(page, `puzzles dark ${tag}`);
        await shot(page, 'puzzles-390x844-dark');
      }
    });

    test('review: import from More, then ◀ ▶ and Next mistake in the bar', async ({ page }) => {
      test.setTimeout(90_000);
      await page.addInitScript(() =>
        localStorage.setItem('daisychess.settings', JSON.stringify({ reviewTour: false })),
      );
      await page.goto('/');
      await openMore(page, 'Import');
      await expect(page.getByRole('button', { name: 'More, Import open' })).toBeVisible();
      await page.getByLabel('PGN text').fill(SCHOLAR);
      await page.getByRole('button', { name: 'Load PGN' }).click();
      await expect(page.getByRole('tab', { name: 'Review' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      const panel = page.getByTestId('review-panel');
      await expect(panel).toHaveAttribute('data-status', 'done', { timeout: 45_000 });
      await expect(bar(page)).toHaveAttribute('data-kind', 'review');
      await expectPhoneLayout(page);
      const next = page.getByRole('button', { name: 'Next mistake' });
      await expect(next).toHaveCount(1);
      const played = panel.getByTestId('move-card-played');
      for (let i = 0; i < 6; i++) {
        await next.click();
        await expect(played).toBeVisible();
        if ((await played.textContent())?.includes('Nf6')) break;
      }
      await expect(played).toHaveText('3... Nf6??');
      await bar(page).getByRole('button', { name: 'Next move' }).click();
      await expect(played).toHaveText(/^4\. Qxf7#/);
      await bar(page).getByRole('button', { name: 'Previous move' }).click();
      await expect(played).toHaveText('3... Nf6??');
      await checkA11y(page, `review ${tag}`);
      if (size.width === 390) await shot(page, 'review-390x844-light');
    });

    test('play vs engine: Take back, Resign, Stop in the bar; result actions after', async ({
      page,
    }) => {
      test.setTimeout(60_000);
      await page.goto('/');
      await page.getByRole('tab', { name: 'Play' }).click();
      await page.getByRole('radio', { name: 'White' }).check();
      await page.getByLabel('Thinking time').selectOption({ label: '0.1 s per move' });
      await page.getByLabel('Time control').selectOption({ label: '3+2 · Blitz' });
      await page.getByRole('button', { name: 'Start' }).click();
      await expect(page.getByTestId('play-status')).toHaveText('Your move');
      await expect(bar(page)).toHaveAttribute('data-kind', 'play');
      await expectPhoneLayout(page);
      await drag(page, 'e2', 'e4');
      await expect(page.getByTestId('play-status')).toHaveText('Your move', { timeout: 15_000 });
      await expect(page.getByTestId('player-bar-top')).toBeInViewport();
      await expect(page.getByTestId('player-bar-bottom')).toBeInViewport();
      const takeBack = page.getByRole('button', { name: 'Take back' });
      await expect(takeBack).toHaveCount(1);
      await expect(takeBack).toBeEnabled();
      if (size.width === 390) await shot(page, 'play-390x844-light');
      await checkA11y(page, `play ${tag}`);
      // The game keeps its controls in the bar on the Analysis tab too.
      await page.getByRole('tab', { name: 'Analysis' }).click();
      await expect(bar(page)).toHaveAttribute('data-kind', 'play');
      await bar(page).getByRole('button', { name: 'Resign' }).click();
      // A finished game leaves the Analysis tab to the analysis controls ...
      await expect(bar(page)).toHaveAttribute('data-kind', 'analysis');
      // ... the Play tab shows the result actions in the bar.
      await page.getByRole('tab', { name: 'Play' }).click();
      await expect(page.getByTestId('play-verdict')).toHaveText('You lost');
      await expect(bar(page).getByRole('button', { name: 'Rematch' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Review this game' })).toHaveCount(1);
      await bar(page).getByRole('button', { name: 'New setup' }).click();
      await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
      await expect(bar(page)).toHaveAttribute('data-kind', 'analysis');
    });

    test('More sheet and ⋯ menu: open, choose, dismiss with Escape and a tap outside', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.goto('/');
      await expect(page.locator('cg-board')).toBeVisible();

      const more = page.getByRole('button', { name: /^More/ });
      await more.click();
      const sheet = page.getByRole('dialog', { name: 'More' });
      await expect(sheet).toBeVisible();
      await expect(more).toHaveAttribute('aria-expanded', 'true');
      for (const t of ['Live', 'Friend', 'Import', 'Explorer', 'Settings']) {
        await expect(sheet.getByRole('button', { name: t, exact: true })).toBeVisible();
      }
      await expect(sheet.getByRole('button', { name: 'Live' })).toBeFocused();
      if (size.width === 390) {
        await checkA11y(page, `more sheet ${tag}`);
        await shot(page, 'more-sheet-390x844-light');
      }
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
      await expect(more).toBeFocused();

      await openMore(page, 'Settings');
      await expect(page.getByRole('tabpanel')).toHaveAccessibleName('More, Settings open');
      await expect(page.getByRole('tab', { name: 'Analysis' })).toHaveAttribute(
        'aria-selected',
        'false',
      );
      await page.getByRole('tab', { name: 'Analysis' }).click();

      // ⋯ options menu.
      await drag(page, 'e2', 'e4');
      await expect(page.getByTestId('status')).toHaveText('Black to move');
      const options = page.getByRole('button', { name: 'Options' });
      await options.click();
      const menu = page.getByRole('dialog', { name: 'Options' });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('switch', { name: 'Engine' })).toBeVisible();
      if (size.width === 390) {
        await checkA11y(page, `options menu ${tag}`);
        await shot(page, 'options-menu-390x844-light');
      }
      await menu.getByRole('button', { name: 'Copy FEN' }).click();
      await expect(menu.getByRole('button', { name: 'FEN copied' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
        /^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b KQkq /,
      );
      await menu.getByRole('button', { name: 'Copy PGN' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('1. e4');
      await menu.getByRole('button', { name: 'Flip board' }).click();
      await expect(menu).toBeHidden();
      await expect(page.getByTestId('player-bar-bottom')).toHaveAttribute('aria-label', /^Black/);
      await options.click();
      await page.mouse.click(10, size.height - 200);
      await expect(page.getByRole('dialog', { name: 'Options' })).toBeHidden();
      await options.click();
      await page
        .getByRole('dialog', { name: 'Options' })
        .getByRole('button', { name: 'New game' })
        .click();
      await expect(page.getByTestId('status')).toHaveText('White to move');
    });
  });
}

test('desktop and phone landscape keep the regular layout', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  for (const vp of [
    { width: 1280, height: 800 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(vp);
    await expect(page.getByTestId('action-bar')).toHaveCount(0);
    await expect(page.getByTestId('bottom-tabs')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Options' })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Moves' })).toBeVisible();
    await expect(page.getByLabel('FEN')).toBeVisible();
  }
  // Rotating to portrait switches to the phone layout without a reload.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('action-bar')).toBeVisible();
  await expect(page.getByTestId('bottom-tabs')).toBeVisible();
});
