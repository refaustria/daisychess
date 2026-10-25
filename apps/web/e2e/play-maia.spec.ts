import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * Play vs Maia (M23-2, ADR-019) against the real engine server with the real Lc0 + Maia nets.
 * Runs only when `engines/lc0/lc0` (`pnpm build-lc0`) and the Maia weights
 * (`pnpm fetch-engines`) exist; otherwise skipped. The server is started by this spec on its own
 * port (8591) with `ACCESS_TOKEN`, so the Maia levels are disabled until the token is saved in
 * Settings.
 */
const PORT = 8591;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = 'e2e-maia-secret-token';
const E2E_PORT = Number(process.env.E2E_PORT ?? 4180);
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = `${REPO}apps/server/dist/index.js`;
const LC0 = `${REPO}engines/lc0/lc0`;
const WEIGHTS = `${REPO}engines/maia/maia-1500.pb.gz`;
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';

function maiaAvailable(): boolean {
  try {
    accessSync(LC0, constants.X_OK);
    accessSync(WEIGHTS, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

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

/** Stops the server this spec started (by its handle, never by name). */
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

async function squareCentre(page: Page, sq: string) {
  const box = await page.locator('cg-board').boundingBox();
  if (!box) throw new Error('cg-board has no box');
  const s = box.width / 8;
  return {
    x: box.x + (sq.charCodeAt(0) - 97 + 0.5) * s,
    y: box.y + (7 - (Number(sq[1]) - 1) + 0.5) * s,
  };
}

async function click(page: Page, sq: string) {
  const p = await squareCentre(page, sq);
  await page.mouse.click(p.x, p.y);
}

test.describe('play vs Maia (server, real Lc0)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!maiaAvailable(), 'Lc0/Maia not installed (pnpm build-lc0 && pnpm fetch-engines)');
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
        ALLOWED_ORIGINS: `http://localhost:${E2E_PORT}`,
        ACCESS_TOKEN: TOKEN,
        REVIEW_STORE: 'off',
        MAIA: 'on',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForHealth(15_000);
  });

  test.afterAll(async () => {
    await stopServer();
  });

  test('token in Settings, Maia 1500, 1.e4: a legal reply within 5 s, bar "Maia 1500"', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(
      ({ url }) => {
        if (!localStorage.getItem('daisychess.analysis')) {
          localStorage.setItem(
            'daisychess.analysis',
            JSON.stringify({ enabled: false, settings: { depth: 12, multipv: 1, remoteUrl: url } }),
          );
        }
      },
      { url: WS_URL },
    );
    await page.goto('/');
    await expect(page.locator('cg-board')).toBeVisible();

    // Without the token the Maia levels are disabled with the reason.
    await page.getByRole('tab', { name: 'Play' }).click();
    await expect(page.getByTestId('maia-unavailable')).toHaveText(
      'Human-like (Maia): No server access token on this device — enter it in Settings',
      { timeout: 15_000 },
    );
    const strength = page.getByLabel('Strength');
    await expect(strength.locator('option[value="maia-1500"]')).toHaveAttribute('disabled', '');

    // Token saved in Settings: the levels become available.
    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByLabel('Server access token').fill(TOKEN);
    await page.getByRole('button', { name: 'Save token' }).click();
    await page.getByRole('tab', { name: 'Play' }).click();
    await expect(strength.locator('option[value="maia-1500"]')).not.toHaveAttribute(
      'disabled',
      /.*/,
      {
        timeout: 15_000,
      },
    );
    await expect(page.getByTestId('maia-unavailable')).toHaveCount(0);
    await strength.selectOption('maia-1500');
    await expect(page.getByRole('checkbox', { name: 'Vary moves' })).toBeChecked();
    await page.getByRole('radio', { name: 'White' }).check();
    await page.getByRole('button', { name: 'Start' }).click();

    await expect(page.getByTestId('play-status')).toHaveText('Your move');
    await expect(page.getByTestId('player-bar-top')).toContainText('Maia 1500');
    await expect(page.getByTestId('player-bar-top')).toContainText('human-like');

    // 1. e4: Maia answers with a legal Black move within 5 s.
    await click(page, 'e2');
    await expect(page.locator('cg-board square.selected')).toHaveCount(1);
    await click(page, 'e4');
    const fen = page.getByLabel('FEN');
    await expect(fen).toHaveValue(/ w \S+ \S+ \d+ 2$/, { timeout: 5_000 });
    const value = await fen.inputValue();
    expect(value.split(' ')[0]).toMatch(/4P3/); // White's e4 pawn is still there
    await expect(page.getByTestId('play-status')).toHaveText('Your move');
    await expect(page.getByTestId('player-bar-top')).toHaveAttribute(
      'aria-label',
      /^Black: Maia 1500 · human-like/,
    );
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/play-maia.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
});
