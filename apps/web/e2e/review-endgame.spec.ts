import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { Chess } from 'chess.js';

/**
 * M32-11: an endgame review with the tablebase overlay (ADR-025 section 4). The lichess tablebase
 * origin is mocked with `page.route`: a K+R+P vs K+R ending in which White wins until 3. Ka7?
 * throws the win away (ply 5), and a draw after it. No request goes to the real service.
 */
const START = '1K6/1P1k4/8/8/8/8/r7/4R3 w - - 0 1';
const SANS = ['Re4', 'Ra1', 'Re5', 'Rb1', 'Ka7', 'Rc1', 'Re4', 'Rb1', 'Rd4+', 'Kc7'];
/** The ply of the thrown win (1-based). */
const THROWN = 5;
const PGN =
  `[Event "Casual"]\n[White "Ann"]\n[Black "Bob"]\n[SetUp "1"]\n[FEN "${START}"]\n\n` +
  '1. Re4 Ra1 2. Re5 Rb1 3. Ka7 Rc1 4. Re4 Rb1 5. Rd4+ Kc7 *';

const key = (fen: string) => fen.split(' ').slice(0, 4).join(' ');

/** FEN (without counters) of the position before ply `i + 1`, with the move played there. */
function gamePositions(): Map<string, { index: number; uci: string }> {
  const chess = new Chess(START);
  const out = new Map<string, { index: number; uci: string }>();
  SANS.forEach((san, i) => {
    const before = chess.fen();
    const m = chess.move(san);
    out.set(key(before), { index: i + 1, uci: `${m.from}${m.to}${m.promotion ?? ''}` });
  });
  return out;
}

const move = (uci: string, san: string, category: string, dtm?: number) => ({
  uci,
  san,
  category,
  zeroing: false,
  checkmate: false,
  stalemate: false,
  ...(dtm !== undefined ? { dtm, dtz: Math.sign(dtm) * Math.ceil(Math.abs(dtm) / 2) } : {}),
});

/**
 * The mocked lichess answer for `fen`. Before the thrown ply White wins (the played move keeps
 * the win); at the thrown ply only `keeper` keeps it; afterwards every move draws.
 */
function answer(fen: string, played: Map<string, { index: number; uci: string }>) {
  const chess = new Chess(fen);
  const info = played.get(key(fen));
  const index = info?.index ?? THROWN + 1;
  const whiteToMove = chess.turn() === 'w';
  const won = index <= THROWN;
  const moves = chess.moves({ verbose: true }).map((m) => {
    const uci = `${m.from}${m.to}${m.promotion ?? ''}`;
    if (!won) return move(uci, m.san, 'draw');
    if (!whiteToMove) return move(uci, m.san, 'win', 28);
    const keeps = index === THROWN ? uci === 'e5d5' : uci === info?.uci;
    return keeps ? move(uci, m.san, 'loss', -28) : move(uci, m.san, 'draw');
  });
  const category = won ? (whiteToMove ? 'win' : 'loss') : 'draw';
  return {
    category,
    ...(won ? { dtm: whiteToMove ? 29 : -28, dtz: whiteToMove ? 15 : -14 } : {}),
    checkmate: false,
    stalemate: false,
    moves,
  };
}

async function mockTablebase(page: Page): Promise<string[]> {
  const asked: string[] = [];
  const played = gamePositions();
  await page.route('https://tablebase.lichess.ovh/**', (route) => {
    const url = new URL(route.request().url());
    const fen = (url.searchParams.get('fen') ?? '').replace(/_/g, ' ');
    asked.push(fen);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(answer(fen, played)),
    });
  });
  return asked;
}

async function loadAndReview(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Import' }).click();
  await page.getByLabel('PGN text').fill(PGN);
  await page.getByRole('button', { name: 'Load PGN' }).click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-status', 'done', {
    timeout: 90_000,
  });
}

test('endgame review: TB badge, move card line, eval bar, tablebase panel and the tour stop', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const asked = await mockTablebase(page);
  await loadAndReview(page);

  // The tour has an endgame stop with the family text and both buttons.
  const bar = page.getByTestId('review-tour');
  const stop = page.getByTestId('tour-stop');
  await expect(bar).toHaveAttribute('data-status', /playing|waiting/, { timeout: 30_000 });
  for (let i = 0; i < 8; i++) {
    await expect(bar).toHaveAttribute('data-status', 'waiting', { timeout: 30_000 });
    if ((await stop.getAttribute('data-kind')) === 'endgame') break;
    await bar.getByTestId('tour-next').click();
  }
  await expect(stop).toHaveAttribute('data-kind', 'endgame');
  await expect(page.getByTestId('tour-endgame-signature')).toBeVisible();
  await expect(stop.getByRole('button', { name: 'Endgame puzzles' })).toBeVisible();
  await expect(stop.getByRole('button', { name: 'Train this endgame' })).toBeVisible();
  const axe = await new AxeBuilder({ page }).include('[data-testid="review-tour"]').analyze();
  expect(axe.violations).toEqual([]);

  // The overlay marks the thrown win in the move list (and the tour used its verdicts).
  await page.getByRole('tab', { name: 'Moves' }).click();
  const badge = page.getByTestId('movelist').locator('[data-tb="thrown"]');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveText('TB');
  expect(asked.length).toBeGreaterThan(0);

  // The move card of the thrown move has the tablebase line.
  await page.getByRole('button', { name: '3. Ka7' }).click();
  await page.getByRole('tab', { name: 'Review' }).click();
  await expect(page.getByTestId('move-card-tb')).toContainText('throws away the win');
  await expect(page.getByTestId('move-card-tb')).toHaveAttribute('data-tb', 'thrown');

  // The position before the thrown move: exact eval bar and the ranked tablebase moves.
  await page.getByRole('tab', { name: 'Moves' }).click();
  await page.getByRole('button', { name: '2... Rb1' }).click();
  const engine = page.getByRole('switch', { name: 'Engine' });
  if (!(await engine.isChecked())) await engine.check();
  await expect(page.getByTestId('eval-bar')).toHaveAttribute('data-tablebase', 'true', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('eval-label')).toContainText(/^M15/);
  await expect(page.getByTestId('eval-caption')).toHaveText('tablebase');
  const rows = page.getByTestId('tablebase-moves').locator('tbody tr');
  await expect(page.getByTestId('tablebase-head')).toContainText('Tablebase (lichess)');
  await expect(rows.first()).toHaveAttribute('data-uci', 'e5d5');
  await expect(rows.first()).toContainText('Win');
  expect(await rows.count()).toBeGreaterThan(3);
});

test('setting off: the overlay sends no request', async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => {
    try {
      // The settings store persists under this key; merging keeps its other defaults.
      const raw = localStorage.getItem('daisychess.settings');
      const s = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      localStorage.setItem('daisychess.settings', JSON.stringify({ ...s, tablebase: 'off' }));
    } catch {
      // Storage unavailable: the test fails below on the badge or request count.
    }
  });
  const asked = await mockTablebase(page);
  await loadAndReview(page);
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('movelist').locator('[data-tb]')).toHaveCount(0);
  expect(asked).toEqual([]);
});
