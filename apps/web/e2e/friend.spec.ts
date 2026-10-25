import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * Play a friend via link (M16, ADR-013) against the real engine server: the host creates a link
 * in the Friend tab, the guest opens it in a second browser context, both play, resign ends the
 * game. The server is started by this spec on its own port with an access token the pages do
 * not know: rooms must work without it (restricted welcome).
 */
const PORT = 8584;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = `${REPO}apps/server/dist/index.js`;
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';

let server: ChildProcess | null = null;

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null)
      throw new Error(`engine server exited with code ${server?.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`engine server did not become healthy: ${String(last)}`);
}

async function stopServer(): Promise<void> {
  const proc = server;
  server = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill('SIGTERM');
  const timer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(timer);
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

async function openPage(browser: Browser): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    ({ url }) => {
      localStorage.setItem(
        'daisychess.analysis',
        JSON.stringify({ enabled: false, settings: { depth: 12, multipv: 1, remoteUrl: url } }),
      );
    },
    { url: WS_URL },
  );
  return { page, errors };
}

test.describe('play a friend via link', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    if (!existsSync(SERVER_ENTRY) || !existsSync(`${REPO}packages/engine-core/dist/index.js`)) {
      execSync(
        'pnpm --filter @daisychess/engine-core build && pnpm --filter @daisychess/server build',
        { cwd: REPO, stdio: 'inherit' },
      );
    }
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        REVIEW_STORE: 'off', // no review store file for these specs (ADR-017)
        ALLOWED_ORIGINS: 'http://localhost:4180',
        // The pages send no token: rooms work on the restricted welcome (ADR-013).
        ACCESS_TOKEN: 'e2e-room-secret-token',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForHealth(15_000);
  });

  test.afterAll(async () => {
    await stopServer();
  });

  test('host creates a link, guest joins, both play, clocks run, resign ends it', async ({
    browser,
  }) => {
    const host = await openPage(browser);
    const guest = await openPage(browser);
    const h = host.page;
    const g = guest.page;

    // --- host: Friend tab → nickname, 3+2, white → Create link -------------------------------
    await h.goto('/');
    await expect(h.locator('cg-board')).toBeVisible();
    await h.getByRole('tab', { name: 'Friend' }).click();
    await h.getByTestId('friend-nick').fill('Alice');
    await h.getByRole('combobox', { name: 'Time control' }).selectOption({ label: '3+2 · Blitz' });
    await h.getByRole('radio', { name: 'White' }).check({ force: true });
    await h.getByRole('button', { name: 'Create link' }).click();
    const linkBox = h.getByTestId('friend-link');
    await expect(linkBox).toHaveValue(/\/#\/room\/[A-Za-z0-9_-]{16,64}$/, { timeout: 15_000 });
    const link = await linkBox.inputValue();
    await expect(h.getByTestId('friend-waiting')).toContainText('Waiting for your friend…');
    await expect(h.getByTestId('status')).toHaveText('Waiting for your friend');
    await expect(h.getByTestId('player-bar-bottom')).toContainText('Alice');
    await expect(h).toHaveURL(/#\/room\//);

    // --- guest: opens the link, picks a nickname, joins ----------------------------------------
    await g.goto(link.replace(/^https?:\/\/[^/]+/, ''));
    await expect(g.getByTestId('friend-join')).toBeVisible();
    await expect(g.getByRole('tab', { name: 'Friend' })).toHaveAttribute('aria-selected', 'true');
    await g.getByTestId('friend-nick').fill('Bob');
    await g.getByRole('button', { name: 'Join' }).click();
    await expect(g.getByTestId('friend-game')).toBeVisible({ timeout: 15_000 });
    await expect(g.getByTestId('friend-opponent')).toHaveText('Alice');
    await expect(h.getByTestId('friend-opponent')).toHaveText('Bob');
    await expect(h.getByTestId('status')).toHaveText('Your move');
    await expect(g.getByTestId('status')).toHaveText('Alice to move');
    // Board orientation: the guest has black at the bottom.
    await expect(g.getByTestId('player-bar-bottom')).toHaveAttribute('data-side', 'black');
    await expect(g.getByTestId('player-bar-bottom')).toContainText('Bob');
    // Engines are locked for the players.
    await expect(h.getByRole('switch', { name: 'Engine' })).toBeDisabled();

    // --- moves ----------------------------------------------------------------------------------
    await drag(h, 'e2', 'e4', 'white');
    await expect(g.getByTestId('status')).toHaveText('Your move', { timeout: 10_000 });
    await drag(g, 'e7', 'e5', 'black');
    await expect(h.getByTestId('status')).toHaveText('Your move', { timeout: 10_000 });
    // From the third ply on the clocks run: white's clock ticks on both boards.
    await drag(h, 'g1', 'f3', 'white');
    await expect(g.getByTestId('status')).toHaveText('Your move', { timeout: 10_000 });
    const hostClock = h.getByTestId('friend-clock-white');
    const guestClock = g.getByTestId('friend-clock-black');
    await expect(hostClock).toBeVisible();
    await expect(guestClock).toBeVisible();
    await expect(g.getByTestId('friend-clock-black')).toHaveAttribute('data-state', 'running');
    const before = await guestClock.textContent();
    await expect(guestClock).not.toHaveText(before ?? '', { timeout: 5_000 });
    await expect(h.getByTestId('friend-clock-white')).toHaveText(/^3:0\d$|^2:5\d$/);
    await drag(g, 'b8', 'c6', 'black');
    await expect(h.getByTestId('status')).toHaveText('Your move', { timeout: 10_000 });

    await h.screenshot({ path: `${SHOTS}/friend-host.png` });
    await g.screenshot({ path: `${SHOTS}/friend-guest.png` });

    // --- reload re-attaches the guest with the stored token -------------------------------------
    await g.reload();
    await expect(g.getByTestId('friend-game')).toBeVisible({ timeout: 15_000 });
    await expect(g.getByTestId('friend-opponent')).toHaveText('Alice');
    await expect(g.getByTestId('status')).toHaveText('Alice to move');

    // --- resign ends the game -------------------------------------------------------------------
    await g.getByRole('button', { name: 'Resign' }).click();
    await g.getByRole('button', { name: 'Yes, resign' }).click();
    await expect(g.getByTestId('friend-result-text')).toHaveText('You lost — resignation', {
      timeout: 10_000,
    });
    await expect(h.getByTestId('friend-result-text')).toHaveText('You won — resignation', {
      timeout: 10_000,
    });
    await expect(h.getByTestId('status')).toHaveText('You won — resignation');
    await expect(h.getByRole('switch', { name: 'Engine' })).toBeEnabled();

    expect(host.errors).toEqual([]);
    expect(guest.errors).toEqual([]);
    await h.context().close();
    await g.context().close();
  });
});
