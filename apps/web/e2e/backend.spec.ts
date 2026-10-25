import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Browser/Server backend switch of the analysis panel against the real engine server.
 * The server is started by this spec on its own port (8582) and killed mid-test to exercise
 * the connection-lost path.
 */
const PORT = 8582;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = `${REPO}apps/server/dist/index.js`;
const SHOTS = process.env.E2E_SHOTS_DIR ?? 'test-results/screenshots';
const LABEL = /^[+-]?\d+\.\d+$|^-?M\d+$/;

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

async function stopServer(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  const proc = server;
  server = null;
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
  proc.kill(signal);
  const timer = setTimeout(() => proc.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(timer);
}

test.describe('engine backend switch (server mode)', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    if (!existsSync(SERVER_ENTRY) || !existsSync(`${REPO}packages/engine-core/dist/index.js`)) {
      execSync(
        'pnpm --filter @daisychess/engine-core build && pnpm --filter @daisychess/server build',
        {
          cwd: REPO,
          stdio: 'inherit',
        },
      );
    }
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        MAX_SESSIONS: '2',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForHealth(15_000);
  });

  test.afterAll(async () => {
    await stopServer('SIGKILL');
  });

  test('Server backend analyses, survives a server kill with a clear message and falls back to the browser', async ({
    page,
  }) => {
    // Persisted settings are the only way to point the app at the test server.
    await page.addInitScript(
      ({ url }) => {
        const key = 'daisychess.analysis';
        if (!localStorage.getItem(key)) {
          localStorage.setItem(
            key,
            JSON.stringify({ enabled: false, settings: { depth: 12, multipv: 2, remoteUrl: url } }),
          );
        }
      },
      { url: WS_URL },
    );
    await page.goto('/');
    await expect(page.locator('cg-board')).toBeVisible();

    const label = page.getByTestId('eval-label');
    const status = page.getByTestId('engine-status');

    await page.getByRole('switch', { name: 'Engine' }).check();
    await expect(label).toHaveText(LABEL, { timeout: 30_000 });
    await expect(page.getByTestId('backend-badge')).toHaveText('Browser');

    // Switch to the server engine with the engine picker (M5-1 replaced the Browser|Server
    // radio): enable the server engine once the probe lists it, then disable the browser one.
    await page.getByRole('button', { name: /^Engines/ }).click();
    const picker = page.getByTestId('engine-picker');
    const serverBox = picker.getByRole('checkbox', { name: /Stockfish 19 \(server\)/ });
    await serverBox.check({ timeout: 15_000 });
    await picker.getByRole('checkbox', { name: /\(browser/, checked: true }).uncheck();
    await expect(serverBox).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(status).toContainText('server', { timeout: 20_000 });
    await expect(page.getByTestId('backend-badge')).toHaveText('Server');
    await expect(label).toHaveText(LABEL, { timeout: 20_000 });
    await expect(page.getByTestId('analysis-line').first()).toBeVisible();
    // Server limits are applied to the selects (MultiPV 2 requested).
    await expect(page.getByLabel('Lines')).toHaveValue('2');
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/backend-server.png`, fullPage: true });

    // Kill the server: reconnects fail (1 s + 2 s + 4 s) and the status settles on "Connection lost".
    await stopServer('SIGKILL');
    await expect(status).toHaveText('Connection lost', { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Use browser engine' })).toBeVisible({
      timeout: 15_000,
    });

    await page.getByRole('button', { name: 'Use browser engine' }).click();
    await expect(page.getByTestId('backend-badge')).toHaveText('Browser');
    await expect(status).not.toContainText('server');
    await expect(label).toHaveText(LABEL, { timeout: 30_000 });
    await expect(page.getByTestId('analysis-line').first()).toBeVisible();
  });
});

/**
 * Server access token (ADR-010): a server started with `ACCESS_TOKEN` refuses the handshake
 * without the token; once it is entered in Settings the server engine analyses.
 */
test.describe('server access token', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);
  const TOKEN_PORT = 8584;
  const TOKEN_URL = `ws://127.0.0.1:${TOKEN_PORT}/ws`;
  const TOKEN = 'e2e-secret-token';
  let tokenServer: ChildProcess | null = null;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    if (!existsSync(SERVER_ENTRY) || !existsSync(`${REPO}packages/engine-core/dist/index.js`)) {
      execSync(
        'pnpm --filter @daisychess/engine-core build && pnpm --filter @daisychess/server build',
        { cwd: REPO, stdio: 'inherit' },
      );
    }
    tokenServer = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO,
      env: {
        ...process.env,
        PORT: String(TOKEN_PORT),
        HOST: '127.0.0.1',
        MAX_SESSIONS: '2',
        LOG_LEVEL: 'warn',
        ACCESS_TOKEN: TOKEN,
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (tokenServer.exitCode !== null) throw new Error('token server exited');
      const ok = await fetch(`http://127.0.0.1:${TOKEN_PORT}/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error('token server did not become healthy');
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test.afterAll(async () => {
    const proc = tokenServer;
    tokenServer = null;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.kill('SIGKILL');
    await exited;
  });

  test('without the token the server engine reports it; after saving it in Settings it analyses', async ({
    page,
  }) => {
    await page.addInitScript(
      ({ url }) => {
        const key = 'daisychess.analysis';
        if (!localStorage.getItem(key)) {
          localStorage.setItem(
            key,
            JSON.stringify({
              enabled: true,
              enabledEngines: ['remote:stockfish'],
              settings: { depth: 12, multipv: 1, remoteUrl: url },
            }),
          );
        }
      },
      { url: TOKEN_URL },
    );
    await page.goto('/');
    await expect(page.locator('cg-board')).toBeVisible();
    const status = page.getByTestId('engine-status');
    await expect(status).toContainText('Access token required or wrong', { timeout: 20_000 });
    await expect(status).toContainText('see Settings');
    await expect(page.getByTestId('auth-hint').first()).toContainText('Settings tab');

    // The picker's server probe fails the same way.
    await page.getByRole('button', { name: /^Engines/ }).click();
    await expect(page.getByTestId('engine-picker')).toContainText(
      'Server unavailable: Access token required or wrong',
      { timeout: 15_000 },
    );
    await page.keyboard.press('Escape');

    // A wrong token is still refused.
    await page.getByRole('tab', { name: 'Settings' }).click();
    const field = page.getByLabel('Server access token');
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill('wrong');
    await page.getByRole('button', { name: 'Save token' }).click();
    await expect(status).toContainText('Access token required or wrong', { timeout: 20_000 });

    await field.fill(TOKEN);
    await page.getByRole('button', { name: 'Save token' }).click();
    await expect(status).toContainText('server', { timeout: 20_000 });
    await expect(status).not.toContainText('Access token');
    await expect(page.getByTestId('eval-label')).toHaveText(LABEL, { timeout: 20_000 });
    expect(
      await page.evaluate(() => JSON.parse(localStorage.getItem('daisychess.settings') ?? '{}')),
    ).toMatchObject({ serverToken: TOKEN });
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/backend-token.png`, fullPage: true });
  });
});
