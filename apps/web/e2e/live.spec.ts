import { mkdirSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Live lichess game through the Board API, with every lichess request mocked by `page.route()`:
 * logged in via the stored auth (`daisychess.lichess`), quick pairing → `gameStart` on the event
 * stream → game stream (`gameFull` + the opponent's move) → the user's reply goes to the move
 * endpoint → a final `gameState` (mate) → finished, auto review. Also checks the fair-play lock.
 */

const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const GAME = 'game1234';
const FAIR_PLAY = 'Disabled during a live game (lichess fair play)';

const ndjson = (...objs: unknown[]) => objs.map((o) => `${JSON.stringify(o)}\n`).join('');

const state = (moves: string, extra: Record<string, unknown> = {}) => ({
  type: 'gameState',
  moves,
  wtime: 598_000,
  btime: 596_000,
  winc: 0,
  binc: 0,
  status: 'started',
  ...extra,
});

const full = (st: Record<string, unknown>) => ({
  type: 'gameFull',
  id: GAME,
  rated: true,
  variant: { key: 'standard', name: 'Standard' },
  speed: 'rapid',
  perf: { name: 'Rapid' },
  clock: { initial: 600_000, increment: 0 },
  white: { id: 'opp', name: 'Opp', rating: 1600 },
  black: { id: 'me', name: 'Me', rating: 1500 },
  initialFen: 'startpos',
  state: st,
});

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function squareCentre(page: Page, sq: string, orientation: 'white' | 'black') {
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error('cg-board has no box');
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]) - 1;
  const col = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 7 - rank : rank;
  const s = box.width / 8;
  return { x: box.x + (col + 0.5) * s, y: box.y + (row + 0.5) * s };
}

async function drag(page: Page, from: string, to: string, orientation: 'white' | 'black') {
  const a = await squareCentre(page, from, orientation);
  const b = await squareCentre(page, to, orientation);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
}

interface LichessMock {
  seekBody(): string;
  moves: string[];
  /** Resolves with the n-th (1-based) move the client sent. */
  move(n: number): Promise<string>;
  authHeaders: (string | undefined)[];
  unexpected: string[];
}

/**
 * Mocks lichess.org: the event stream announces game `GAME` (user = `color`) once the seek is
 * posted; `gameStream(call)` answers the n-th game stream request (1-based) with NDJSON (each
 * answer closes the stream, so the client reconnects and gets the next one).
 */
async function mockLichess(
  page: Page,
  color: 'white' | 'black',
  gameStream: (call: number, mock: LichessMock) => Promise<string>,
  storage: Record<string, unknown> = {},
): Promise<LichessMock> {
  const seekPosted = deferred();
  const waiters: { n: number; resolve(uci: string): void }[] = [];
  let seekBody = '';
  let eventCalls = 0;
  let gameCalls = 0;
  const mock: LichessMock = {
    seekBody: () => seekBody,
    moves: [],
    move: (n) =>
      mock.moves.length >= n ? Promise.resolve(mock.moves[n - 1]!) : new Promise((resolve) => waiters.push({ n, resolve })),
    authHeaders: [],
    unexpected: [],
  };

  await page.addInitScript((items: Record<string, unknown>) => {
    localStorage.setItem(
      'daisychess.lichess',
      JSON.stringify({ token: 'e2e-token', username: 'Me', scopes: ['board:play', 'challenge:read', 'challenge:write'] }),
    );
    for (const [k, v] of Object.entries(items)) localStorage.setItem(k, JSON.stringify(v));
  }, storage);

  await page.route('https://lichess.org/**', async (route: Route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    mock.authHeaders.push(req.headers()['authorization']);
    if (path === '/api/stream/event') {
      eventCalls++;
      if (eventCalls === 1) {
        // The game starts once the seek is posted (lichess pairs and announces it here).
        await seekPosted.promise;
        await route.fulfill({
          status: 200,
          contentType: 'application/x-ndjson',
          body: ndjson({
            type: 'gameStart',
            game: { gameId: GAME, fullId: `${GAME}abcd`, color, opponent: { id: 'opp', username: 'Opp', rating: 1600 }, rated: true, speed: 'rapid', source: 'lobby', isMyTurn: color === 'white' },
          }),
        });
      } else {
        // Reconnects: a keep-alive, then the stream closes (backoff in the client).
        await new Promise((r) => setTimeout(r, 1500));
        await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '\n' }).catch(() => undefined);
      }
      return;
    }
    if (path === '/api/account') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"username":"Me","perfs":{"blitz":{"games":42,"rating":1500},"rapid":{"games":5,"rating":1450,"prov":true}}}',
      });
      return;
    }
    if (path === '/api/account/playing') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"nowPlaying":[]}' });
      return;
    }
    if (path === '/api/board/seek') {
      seekBody = req.postData() ?? '';
      seekPosted.resolve();
      // Kept open while pending; lichess closes it after pairing.
      await new Promise((r) => setTimeout(r, 500));
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '\n' }).catch(() => undefined);
      return;
    }
    if (path === `/api/board/game/stream/${GAME}`) {
      const body = await gameStream(++gameCalls, mock);
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body }).catch(() => undefined);
      return;
    }
    const move = /^\/api\/board\/game\/(\w+)\/move\/(\w+)$/.exec(path);
    if (move && req.method() === 'POST' && move[1] === GAME) {
      mock.moves.push(move[2]!);
      for (const w of waiters.filter((x) => x.n <= mock.moves.length)) w.resolve(mock.moves[w.n - 1]!);
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    mock.unexpected.push(`${req.method()} ${path}`);
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' });
  });
  return mock;
}

async function startSeek(page: Page) {
  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  await page.getByRole('tab', { name: 'Live' }).click();
  await expect(page.getByTestId('live-rating-blitz')).toContainText('1500');
  await expect(page.getByTestId('live-rating-rapid')).toContainText('1450?');
  await page.getByRole('radio', { name: '10+0' }).check();
  await page.getByRole('button', { name: 'Find an opponent' }).click();
  await expect(page.getByTestId('live-opponent')).toHaveText('Opp (1600)');
}

test('live game: seek, opponent move, reply sent, mate, auto review; engine locked', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const lichess = await mockLichess(page, 'black', async (call, mock) => {
    if (call === 1) return ndjson(full(state('f2f3 e7e5')), state('f2f3 e7e5 g2g4'));
    // The reconnect gets the full state again; after the user's reply it is mate.
    const uci = await mock.move(1);
    return ndjson(full(state(`f2f3 e7e5 g2g4 ${uci}`, { status: 'mate', winner: 'black' })));
  });

  await page.goto('/');
  await expect(page.locator('cg-board')).toBeVisible();
  const engineSwitch = page.getByRole('switch', { name: 'Engine' });
  await engineSwitch.check();

  await page.getByRole('tab', { name: 'Live' }).click();
  await page.getByRole('radio', { name: '10+0' }).check();
  await page.getByRole('button', { name: 'Find an opponent' }).click();

  // Paired: the Live tab shows the opponent, both clocks and the opponent's move on the board.
  await expect(page.getByTestId('live-opponent')).toHaveText('Opp (1600)');
  expect(Object.fromEntries(new URLSearchParams(lichess.seekBody()))).toMatchObject({ rated: 'true', time: '10', increment: '0', variant: 'standard' });
  await expect(page.getByTestId('clock-black')).toHaveText(/^9:5\d$/);
  await expect(page.getByTestId('clock-white')).toHaveText('9:58');
  await expect(page.getByTestId('live-status')).toHaveText('Your move');
  await expect(page.getByTestId('board')).toHaveClass(/orientation-black/);
  await expect(page.getByLabel('FEN')).toHaveValue(/^rnbqkbnr\/pppp1ppp\/8\/4p3\/6P1\/5P2\/PPPPP2P\/RNBQKBNR b /);

  // Fair play: the engine is off and its switch disabled with the tooltip; Review cannot start.
  await expect(engineSwitch).not.toBeChecked();
  await expect(engineSwitch).toBeDisabled();
  await expect(page.locator(`label[title="${FAIR_PLAY}"]`)).toHaveCount(1);
  // Clicking the disabled switch (forced) does not turn the engine on.
  await engineSwitch.click({ force: true });
  await expect(engineSwitch).not.toBeChecked();
  await expect(page.getByTestId('engine-status')).toHaveText('Off');

  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/live-game.png`, fullPage: true });

  // The opponent's pieces do not move; the reply goes to lichess.
  await drag(page, 'g4', 'g5', 'black');
  await drag(page, 'd8', 'h4', 'black');
  expect(await lichess.move(1)).toBe('d8h4');

  // Final state: mate → finished; the auto review runs in the background.
  await expect(page.getByTestId('live-result')).toHaveText('0-1');
  await expect(page.getByTestId('live-finished')).toContainText('You won');
  await expect(page.getByTestId('live-finished')).toContainText('checkmate');
  await expect(page.getByLabel('FEN')).toHaveValue(/^rnb1kbnr\/pppp1ppp\/8\/4p3\/6Pq\/5P2\/PPPPP2P\/RNBQKBNR w /);
  await expect(engineSwitch).toBeEnabled();
  await page.getByRole('button', { name: 'Review this game' }).click();
  await expect(page.getByTestId('review-panel')).toHaveAttribute('data-status', /running|done/);
  await expect(page.getByTestId('auto-notice')).toBeVisible();

  // The token went out only as a Bearer header to lichess.org.
  expect(lichess.authHeaders.every((h) => h === 'Bearer e2e-token')).toBe(true);
  expect(lichess.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});

test('premove queue (settings: queue): two premoves while waiting, sent in order', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const premovesEntered = deferred();
  const lichess = await mockLichess(
    page,
    'white',
    async (call, mock) => {
      const me = { id: 'me', name: 'Me', rating: 1500 };
      const opp = { id: 'opp', name: 'Opp', rating: 1600 };
      const game = (moves: string, extra: Record<string, unknown> = {}) =>
        ndjson({ ...full(state(moves, extra)), white: me, black: opp });
      if (call === 1) return game('e2e4'); // the opponent's turn
      if (call === 2) {
        await premovesEntered.promise;
        return game('e2e4 e7e5'); // opponent move 1: the first premove is played
      }
      if (call === 3) {
        const first = await mock.move(1);
        return game(`e2e4 e7e5 ${first} b8c6`); // opponent move 2: the second premove
      }
      const second = await mock.move(2);
      const [first] = mock.moves;
      return game(`e2e4 e7e5 ${first} b8c6 ${second}`, { status: 'resign', winner: 'white' });
    },
    { 'daisychess.settings': { premoves: 'queue' } },
  );

  await startSeek(page);
  await expect(page.getByTestId('live-status')).toHaveText('Waiting for opponent');
  await drag(page, 'g1', 'f3', 'white');
  await drag(page, 'f1', 'c4', 'white');
  await expect(page.getByTestId('board')).toHaveAttribute('data-premoves', 'g1f3 f1c4');
  await expect(page.getByTestId('live-premoves')).toContainText('Premoves: Nf3, Bc4');
  premovesEntered.resolve();

  expect(await lichess.move(1)).toBe('g1f3');
  expect(await lichess.move(2)).toBe('f1c4');
  await expect(page.getByTestId('live-result')).toHaveText('1-0');
  expect(lichess.moves).toEqual(['g1f3', 'f1c4']);
  await expect(page.getByLabel('FEN')).toHaveValue(/^r1bqkbnr\/pppp1ppp\/2n5\/4p3\/2B1P3\/5N2\/PPPP1PPP\/RNBQK2R b /);
  expect(lichess.unexpected).toEqual([]);
  expect(errors).toEqual([]);
});
