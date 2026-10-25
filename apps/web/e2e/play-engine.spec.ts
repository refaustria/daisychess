import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const AFTER_REPLY = / w \S+ \S+ \d+ 2$/;

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

/** Fails on serious/critical axe violations. */
async function checkA11y(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    blocking.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) })),
    label,
  ).toEqual([]);
}

async function importFen(page: Page, fen: string) {
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('Position to import').fill(fen);
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(page.getByLabel('FEN')).toHaveValue(fen);
}

async function halfMoves(page: Page) {
  await page.getByRole('tab', { name: 'Moves' }).click();
  const n = await page.getByTestId('movelist').locator('button[aria-label]').count();
  await page.getByRole('tab', { name: 'Play' }).click();
  return n;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
});

test('promotion dialog: White by mouse picks a rook, Black by keyboard picks a knight', async ({
  page,
}) => {
  await importFen(page, '7k/P7/8/8/8/8/8/K7 w - - 0 1');
  await drag(page, 'a7', 'a8');
  const dialog = page.getByRole('dialog', { name: 'Choose promotion piece' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('piece.queen.white')).toHaveCount(1);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/promotion.png`, fullPage: true });
  await dialog.getByRole('button', { name: /rook/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('FEN')).toHaveValue(/^R6k\/8\/8\/8\/8\/8\/8\/K7 b/);
  await page.getByRole('tab', { name: 'Moves' }).click();
  await expect(page.getByTestId('movelist')).toContainText('a8=R');

  await importFen(page, '7k/8/8/8/8/8/p7/7K b - - 0 1');
  await drag(page, 'a2', 'a1');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('piece.knight.black')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('FEN')).toHaveValue('7k/8/8/8/8/8/p7/7K b - - 0 1');
  await expect(page.locator('cg-board piece.pawn.black')).toHaveCount(1);
  await drag(page, 'a2', 'a1');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('n');
  await expect(page.getByLabel('FEN')).toHaveValue(/^7k\/8\/8\/8\/8\/8\/8\/n6K w/);
});

test('play vs engine: reply, take back, resign, rematch; analysis paused and restored', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const engineSwitch = page.getByRole('switch', { name: 'Engine' });
  await engineSwitch.check();

  await page.getByRole('tab', { name: 'Play' }).click();
  await checkA11y(page, 'play setup');
  await page.getByRole('radio', { name: 'White' }).check();
  await page.getByLabel('Strength').selectOption({ label: '1350 Elo' });
  await page.getByLabel('Thinking time').selectOption({ label: '0.1 s per move' });
  await page.getByRole('button', { name: 'Start' }).click();

  const status = page.getByTestId('play-status');
  await expect(status).toHaveText('Your move');
  await expect(engineSwitch).not.toBeChecked();
  await expect(engineSwitch).toBeDisabled();
  await expect(page.getByTestId('board')).toHaveClass(/orientation-white/);

  // The engine's pieces cannot be moved.
  await drag(page, 'e7', 'e5');
  await expect(page.getByLabel('FEN')).toHaveValue(
    /^rnbqkbnr\/pppppppp\/8\/8\/8\/8\/PPPPPPPP\/RNBQKBNR w/,
  );

  await drag(page, 'e2', 'e4');
  // White's move and the engine's reply: White to move in move 2.
  await expect(page.getByLabel('FEN')).toHaveValue(AFTER_REPLY, { timeout: 10_000 });
  await expect(status).toHaveText('Your move');
  expect(await halfMoves(page)).toBe(2);
  await expect(page.locator('square.last-move')).toHaveCount(2);
  await checkA11y(page, 'play running');
  await page.screenshot({ path: `${SHOTS}/play-engine.png`, fullPage: true });

  await page.getByRole('button', { name: 'Take back' }).click();
  expect(await halfMoves(page)).toBe(0);
  await expect(status).toHaveText('Your move');

  await page.getByRole('button', { name: 'Resign' }).click();
  await expect(page.getByTestId('play-result')).toHaveText('0-1');
  await expect(page.getByText('You lost')).toBeVisible();
  await expect(engineSwitch).toBeChecked();
  await checkA11y(page, 'play finished');

  await page.getByRole('button', { name: 'Rematch' }).click();
  await expect(status).toHaveText('Your move');
  await expect(engineSwitch).not.toBeChecked();
  await drag(page, 'd2', 'd4');
  await expect(page.getByLabel('FEN')).toHaveValue(AFTER_REPLY, { timeout: 10_000 });
  await expect(status).toHaveText('Your move');
  expect(await halfMoves(page)).toBe(2);
  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  await expect(engineSwitch).toBeChecked();
  await expect(engineSwitch).toBeEnabled();
  expect(errors).toEqual([]);
});

test('play as Black: the engine opens, board is flipped', async ({ page }) => {
  await page.getByRole('tab', { name: 'Play' }).click();
  await page.getByRole('radio', { name: 'Black' }).check();
  await page.getByLabel('Thinking time').selectOption({ label: '0.1 s per move' });
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('board')).toHaveClass(/orientation-black/);
  await expect(page.getByTestId('play-status')).toHaveText('Your move', { timeout: 10_000 });
  await expect(page.getByLabel('FEN')).toHaveValue(/ b /);
});

test('premove (single) against the engine: played right after the engine replies', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.getByRole('tab', { name: 'Play' }).click();
  await page.getByRole('radio', { name: 'White' }).check();
  await page.getByLabel('Thinking time').selectOption({ label: '3 s per move' });
  await page.getByLabel('Time control').selectOption('none');
  await page.getByRole('button', { name: 'Start' }).click();
  const status = page.getByTestId('play-status');
  await expect(status).toHaveText('Your move');
  await drag(page, 'e2', 'e4');
  await expect(status).toHaveText('Engine thinking…');
  // Drag while the engine thinks: a premove (default setting `single`).
  await drag(page, 'g1', 'f3');
  await expect(page.getByTestId('board')).toHaveAttribute('data-premoves', 'g1f3');
  // The engine's reply, then the premove at once: Black to move in move 2, knight on f3.
  await expect(page.getByLabel('FEN')).toHaveValue(/\/5N2\/PPPP1PPP\/RNBQKB1R b /, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('board')).not.toHaveAttribute('data-premoves', /./);
  expect(await halfMoves(page)).toBe(3);
  await page.getByRole('button', { name: 'Stop' }).click();
});

test('clocks: both render, yours runs on your move, resign; a 15-second game is lost on time', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('tab', { name: 'Play' }).click();
  await page.getByRole('radio', { name: 'White' }).check();
  await page.getByLabel('Thinking time').selectOption({ label: '0.1 s per move' });
  const tc = page.getByLabel('Time control');
  await tc.selectOption({ label: '1+0 · Bullet' });
  await page.getByRole('button', { name: 'Start' }).click();

  const mine = page.getByTestId('play-clock-you');
  const engine = page.getByTestId('play-clock-engine');
  await expect(mine).toBeVisible();
  await expect(engine).toHaveText('1:00');
  await expect(engine).toHaveAttribute('aria-label', 'Black clock 1:00');
  // Your clock runs while it is your move.
  await expect(mine).toHaveAttribute('data-state', 'running');
  await expect(mine).toHaveText(/^0:5\d$/, { timeout: 5_000 });
  await drag(page, 'e2', 'e4');
  await expect(page.getByLabel('FEN')).toHaveValue(AFTER_REPLY, { timeout: 10_000 });
  await expect(mine).toHaveAttribute('data-state', 'running');
  await expect(engine).toHaveAttribute('data-state', 'idle');
  await expect(engine).toHaveText(/^(1:00|0:59)$/); // 0.1 s of thinking
  await checkA11y(page, 'play with clocks');
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/play-clock.png`, fullPage: true });
  await page.getByRole('button', { name: 'Resign' }).click();
  await expect(page.getByTestId('play-result')).toHaveText('0-1');
  const stopped = await mine.textContent();
  await page.waitForTimeout(1_100);
  await expect(mine).toHaveText(stopped ?? ''); // paused when finished

  // Custom 0.25+0 (15 s): do not move, lose on time.
  await page.getByRole('button', { name: 'New setup' }).click();
  await tc.selectOption('custom');
  await page.getByLabel('Minutes').fill('0.25');
  await page.getByLabel('Increment (s)').fill('0');
  await expect(page.getByText('0.25+0 · UltraBullet')).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(mine).toHaveText(/^0:1[0-5]$/);
  await expect(mine).toHaveClass(/clockLow/, { timeout: 15_000 }); // below 1.5 s
  await expect(page.getByTestId('play-verdict')).toHaveText('You lost on time', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('play-result')).toHaveText('0-1');
  await expect(mine).toHaveText('0:00.0');
  await expect(mine).toHaveAttribute('data-state', 'flagged');

  // The setup (incl. the custom clock) is remembered.
  await page.reload();
  await page.getByRole('tab', { name: 'Play' }).click();
  await expect(page.getByLabel('Time control')).toHaveValue('custom');
  await expect(page.getByLabel('Minutes')).toHaveValue('0.25');
  expect(errors).toEqual([]);
});

test('layout: player bars with large clocks beside the board (desktop and mobile), screenshots', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.getByRole('tab', { name: 'Play' }).click();
  await page.getByRole('radio', { name: 'White' }).check();
  await page.getByLabel('Thinking time').selectOption({ label: '0.1 s per move' });
  await page.getByLabel('Time control').selectOption({ label: '3+2 · Blitz' });
  await page.getByRole('button', { name: 'Start' }).click();

  const top = page.getByTestId('player-bar-top');
  const bottom = page.getByTestId('player-bar-bottom');
  await expect(top).toHaveAttribute('aria-label', /^Black: Stockfish · \S+ Elo, 3:00$/);
  await expect(bottom).toHaveAttribute('aria-label', /^White: You, \d:\d\d$/);
  await expect(bottom.getByTestId('play-clock-you')).toHaveAttribute('data-state', 'running');
  await drag(page, 'e2', 'e4');
  await expect(page.getByLabel('FEN')).toHaveValue(AFTER_REPLY, { timeout: 10_000 });
  // The panel shows no clocks of its own.
  await expect(page.getByRole('tabpanel').getByRole('timer')).toHaveCount(0);

  // Desktop: panel right of the board, board >= 660px wide, bars above and below it, no page scroll.
  const board = (await page.getByTestId('board').boundingBox())!;
  const panel = (await page.getByRole('tabpanel').boundingBox())!;
  const topBox = (await top.boundingBox())!;
  const bottomBox = (await bottom.boundingBox())!;
  expect(board.x + board.width).toBeLessThanOrEqual(panel.x);
  expect(board.width).toBeGreaterThanOrEqual(660);
  expect(topBox.y + topBox.height).toBeLessThanOrEqual(board.y);
  expect(bottomBox.y).toBeGreaterThanOrEqual(board.y + board.height - 1);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/layout-right-1280.png` });
  await page.setViewportSize({ width: 1920, height: 1080 });
  const big = (await page.getByTestId('board').boundingBox())!;
  expect(big.width).toBeGreaterThanOrEqual(900);
  expect(
    await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);
  await page.screenshot({ path: `${SHOTS}/layout-right-1920.png` });

  await page.setViewportSize({ width: 390, height: 844 });
  const small = (await page.getByTestId('board').boundingBox())!;
  expect(small.width).toBeGreaterThanOrEqual(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByTestId('play-clock-engine')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/layout-right-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: 'Stop' }).click();
});

test('play from the current position keeps the opening line in the move list', async ({ page }) => {
  test.setTimeout(60_000);
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill('1. e4 e5 2. Nf3 Nc6');
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await page.getByRole('button', { name: 'Last move' }).click();
  await expect(page.getByLabel('FEN')).toHaveValue(/ w KQkq - 2 3$/);
  await page.getByRole('tab', { name: 'Play' }).click();
  await expect(page.getByRole('radio', { name: 'Current position' })).toBeEnabled();
  await page.getByRole('radio', { name: 'Current position' }).check();
  await page.getByRole('radio', { name: 'White' }).check();
  await page.getByLabel('Thinking time').selectOption({ label: '0.1 s per move' });
  await page.getByLabel('Time control').selectOption('none');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('play-status')).toHaveText(/Your move|Engine thinking/);
  await page.getByRole('tab', { name: 'Moves' }).click();
  const list = page.getByTestId('movelist');
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) await expect(list).toContainText(san);
  await page.getByRole('tab', { name: 'Play' }).click();
  await expect(page.getByRole('button', { name: 'Take back' })).toBeDisabled();
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/play-from-here.png`, fullPage: true });
  await page.getByRole('button', { name: 'Stop' }).click();
});
