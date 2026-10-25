import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Screenshots go to the git-ignored test-results dir unless E2E_SHOTS_DIR overrides it.
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w';

const fen = (page: Page) => page.getByLabel('FEN');

/** Centre of a square in page coordinates (orientation white by default). */
async function squareCentre(page: Page, sq: string, orientation: 'white' | 'black' = 'white') {
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error('cg-board has no box');
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]) - 1;
  const col = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 7 - rank : rank;
  const s = box.width / 8;
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

async function click(page: Page, sq: string) {
  const p = await squareCentre(page, sq);
  await page.mouse.click(p.x, p.y);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
});

test('loads without console errors, square board, 32 pieces', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.reload();
  await expect(page).toHaveTitle('DaisyChess');
  await expect(page.locator('piece:not(.ghost)')).toHaveCount(32);
  const board = (await page.locator('cg-board').boundingBox())!;
  expect(board.width).toBeGreaterThan(300);
  expect(Math.abs(board.width - board.height)).toBeLessThan(2);
  const wrap = (await page.locator('cg-container').boundingBox())!;
  expect(Math.abs(wrap.width - board.width)).toBeLessThan(2);
  expect(Math.abs(wrap.height - board.height)).toBeLessThan(2);
  expect(errors).toEqual([]);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/board-start.png`, fullPage: true });
});

test('square colours: a1 dark, h1 light (pixel sampling)', async ({ page }) => {
  const png = (await page.locator('cg-board').screenshot()).toString('base64');
  const lum = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const s = img.width / 8;
    // Sample near a square corner so pieces (centred) do not interfere.
    const at = (col: number, row: number) => {
      const [r, g, b] = ctx.getImageData(
        Math.round(col * s + 4),
        Math.round(row * s + 4),
        1,
        1,
      ).data;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    return { a1: at(0, 7), h1: at(7, 7), a8: at(0, 0) };
  }, png);
  expect(lum.a1).toBeLessThan(lum.h1);
  expect(lum.a8).toBeGreaterThan(lum.a1);
});

test('drag e2-e4, click-click e7-e5, illegal drag ignored', async ({ page }) => {
  await drag(page, 'e2', 'e4');
  await expect(page.getByTestId('status')).toHaveText(/Black to move/);
  await expect(fen(page)).toHaveValue(/^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b/);
  await expect(page.locator('square.last-move')).toHaveCount(2);
  await page.screenshot({ path: `${SHOTS}/board-e4.png`, fullPage: true });

  await click(page, 'e7');
  await click(page, 'e5');
  await expect(fen(page)).toHaveValue(/^rnbqkbnr\/pppp1ppp\/8\/4p3\/4P3\/8\/PPPP1PPP\/RNBQKBNR w/);
});

test('illegal drag e2-e5 leaves FEN unchanged', async ({ page }) => {
  await drag(page, 'e2', 'e5');
  await expect(fen(page)).toHaveValue(new RegExp(`^${START}`));
});

test('flip, undo and keyboard navigation', async ({ page }) => {
  await page.getByRole('button', { name: 'Flip' }).click();
  await expect(page.getByTestId('board')).toHaveClass(/orientation-black/);
  await page.getByRole('button', { name: 'Flip' }).click();
  await expect(page.getByTestId('board')).toHaveClass(/orientation-white/);

  await drag(page, 'e2', 'e4');
  await expect(page.getByTestId('status')).toHaveText(/Black to move/);
  await click(page, 'e7');
  await click(page, 'e5');
  await expect(fen(page)).toHaveValue(/^rnbqkbnr\/pppp1ppp\/8\/4p3\/4P3\/8\/PPPP1PPP\/RNBQKBNR w/);

  await page.keyboard.press('ArrowLeft');
  await expect(fen(page)).toHaveValue(/^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b/);
  await page.keyboard.press('Home');
  await expect(fen(page)).toHaveValue(new RegExp(`^${START}`));
  await page.keyboard.press('ArrowRight');
  await expect(fen(page)).toHaveValue(/RNBQKBNR b/);
  await page.keyboard.press('End');
  await expect(fen(page)).toHaveValue(/4p3\/4P3/);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(fen(page)).toHaveValue(/^rnbqkbnr\/pppppppp\/8\/8\/4P3\/8\/PPPP1PPP\/RNBQKBNR b/);
});

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

test('PGN import: checkmate, move list, click to navigate', async ({ page }) => {
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(SCHOLAR);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  // Loading opens the automatic review; the move list is on the Moves tab.
  await page.getByRole('tab', { name: 'Moves' }).click();
  // Loaded games start at ply 0; jump to the end to see the mate.
  await page.getByRole('button', { name: 'Last move' }).click();
  await expect(page.getByTestId('status')).toHaveText('Checkmate — White wins');
  await expect(page.getByTestId('movelist').getByRole('button')).toHaveCount(7);
  await page.getByRole('button', { name: '2... Nc6' }).click();
  await expect(fen(page)).toHaveValue(
    'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3',
  );
  await page.screenshot({ path: `${SHOTS}/pgn-loaded.png`, fullPage: true });
});

test('PGN import via file upload', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'daisychess-'));
  const file = join(dir, 'game.pgn');
  writeFileSync(file, `[White "Ann"]\n[Black "Bob"]\n[Result "1-0"]\n\n${SCHOLAR} 1-0\n`);
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN file').setInputFiles(file);
  await page.getByRole('tab', { name: 'Moves' }).click();
  await expect(page.getByText('Ann – Bob')).toBeVisible();
  await expect(page.getByTestId('movelist').getByRole('button')).toHaveCount(7);
});

test('FEN import and invalid FEN error', async ({ page }) => {
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('Position to import').fill('nonsense');
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.getByText('Invalid FEN')).toBeVisible();

  const target = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
  await page.getByLabel('Position to import').fill(target);
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(fen(page)).toHaveValue(target);
  await expect(page.locator('piece:not(.ghost)')).toHaveCount(3);
});

test('theme toggle: dark persists across reload, screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => localStorage.removeItem('daisychess.theme'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();
  await expect(page.locator('cg-board')).toBeVisible();
  await drag(page, 'e2', 'e4');
  await page.screenshot({ path: `${SHOTS}/desktop-light.png`, fullPage: true });
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/desktop-dark.png`, fullPage: true });
  // Desktop layout: no page scroll, board and panel side by side.
  const noScroll = await page.evaluate(
    () => document.documentElement.scrollHeight <= window.innerHeight,
  );
  expect(noScroll).toBe(true);
});

test('mobile layout: no horizontal overflow, board visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const board = page.getByTestId('board');
  await expect(board).toBeVisible();
  const box = (await board.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(300);
  const ok = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(ok).toBe(true);
  await page.screenshot({ path: `${SHOTS}/mobile.png`, fullPage: true });
});
