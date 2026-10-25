import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

/**
 * RemoteEngineClient against the real engine server (apps/server, native Stockfish).
 * The server is started by this spec on its own port (the shared playwright.config is untouched);
 * the page on the preview origin connects cross-origin (COEP does not apply to WebSockets).
 */
const PORT = 8581;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_ENTRY = `${REPO}apps/server/dist/index.js`;

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATE_IN_1 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const BLACK_TO_MOVE_QUEEN_DOWN = '4k3/8/8/8/8/8/4Q3/4K3 b - - 0 1';
const SANE_OPENING_MOVES = ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'e2e3', 'b1c3', 'g2g3', 'c2c3', 'd2d3'];

interface Score {
  cp?: number;
  mate?: number;
}
interface Info {
  depth: number;
  score: Score;
  pv: string[];
}
interface SearchResult {
  infos: Info[];
  bestMove: { move: string } | null;
}

let server: ChildProcess | null = null;

async function waitForHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`engine server exited with code ${server?.exitCode}`);
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

/**
 * Creates a RemoteEngineClient in the page and runs `script` against it (`engine`, `collect` in scope).
 * The whole thing is sent as one expression string: Playwright evaluates it over the DevTools
 * protocol, which the page's CSP does not govern, whereas `new Function` inside the page would
 * need 'unsafe-eval' (the preview server enforces the production CSP, docs/SECURITY.md).
 * Page-side API: src/engine/devHook.ts (`window.__daisychess.createRemoteEngine`).
 */
function inPage<T>(page: Page, script: string): Promise<T> {
  const expression = `(async () => {
    const engine = await window.__daisychess.createRemoteEngine({ url: ${JSON.stringify(WS_URL)} });
    await engine.load();
    const collect = async (h) => {
      const infos = [];
      for await (const i of h) infos.push(i);
      return { infos, bestMove: await h.bestMove };
    };
    try {
      return await (async () => { ${script} })();
    } finally {
      await engine.dispose();
    }
  })()`;
  return page.evaluate(expression) as Promise<T>;
}

test.describe('remote engine (server mode)', () => {
  // One worker, one server for the whole file.
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60_000);

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    if (!existsSync(SERVER_ENTRY) || !existsSync(`${REPO}packages/engine-core/dist/index.js`)) {
      execSync('pnpm --filter @daisychess/engine-core build && pnpm --filter @daisychess/server build', {
        cwd: REPO,
        stdio: 'inherit',
      });
    }
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: REPO,
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MAX_SESSIONS: '2', LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    await waitForHealth(15_000);
  });

  test.afterAll(async () => {
    await stopServer();
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('handshake exposes engine metadata', async ({ page }) => {
    const meta = await inPage<{ name: string; caps: { threads: boolean; build: string; threadCount: number }; status: string }>(
      page,
      `return { name: engine.engineName, caps: engine.capabilities(), status: engine.status };`,
    );
    expect(meta.status).toBe('ready');
    expect(meta.name).toMatch(/Stockfish/);
    expect(meta.caps.threads).toBe(true);
    expect(meta.caps.build).toMatch(/Stockfish.*@/);
    expect(meta.caps.threadCount).toBeGreaterThanOrEqual(1);
  });

  test('analyzes the start position to depth 12', async ({ page }) => {
    const res = await inPage<SearchResult>(page, `return collect(engine.analyze(${JSON.stringify(START)}, { depth: 12 }));`);
    const last = res.infos.at(-1)!;
    expect(last.depth).toBeGreaterThanOrEqual(12);
    expect(SANE_OPENING_MOVES).toContain(res.bestMove?.move);
    expect(last.score.cp).toBeGreaterThan(-100);
    expect(last.score.cp).toBeLessThan(100);
  });

  test('finds mate in 1 and reports White-POV scores with Black to move', async ({ page }) => {
    const [mate, black] = await inPage<SearchResult[]>(
      page,
      `const a = await collect(engine.analyze(${JSON.stringify(MATE_IN_1)}, { depth: 5 }));
       const b = await collect(engine.analyze(${JSON.stringify(BLACK_TO_MOVE_QUEEN_DOWN)}, { depth: 12 }));
       return [a, b];`,
    );
    expect(mate!.bestMove?.move).toBe('a1a8');
    expect(mate!.infos.at(-1)!.score).toEqual({ mate: 1 });
    const score = black!.infos.at(-1)!.score;
    // Black to move and a queen down: the engine says "losing" for Black, i.e. winning for White.
    expect((score.cp ?? 0) > 500 || (score.mate ?? 0) > 0).toBe(true);
  });

  test('a new analyze replaces a running search', async ({ page }) => {
    const res = await inPage<{ first: SearchResult; second: SearchResult }>(
      page,
      `const first = engine.analyze(${JSON.stringify(START)}, {});
       const firstInfos = [];
       const it = first[Symbol.asyncIterator]();
       // Wait until the infinite search is really running on the server.
       for (;;) {
         const r = await it.next();
         if (r.done) throw new Error('infinite search ended early');
         firstInfos.push(r.value);
         if (r.value.depth >= 8) break;
       }
       const second = engine.analyze(${JSON.stringify(MATE_IN_1)}, { depth: 5 });
       for (;;) {
         const r = await it.next();
         if (r.done) break;
         firstInfos.push(r.value);
       }
       const firstBest = await first.bestMove;
       return { first: { infos: firstInfos, bestMove: firstBest }, second: await collect(second) };`,
    );
    // Old iterator ended; it only ever saw start-position lines (cp scores, opening moves).
    expect(res.first.infos.length).toBeGreaterThan(0);
    for (const i of res.first.infos) expect(i.score.mate).toBeUndefined();
    // New search only sees the new position.
    expect(res.second.bestMove?.move).toBe('a1a8');
    expect(res.second.infos.length).toBeGreaterThan(0);
    for (const i of res.second.infos) expect(i.pv[0]).not.toBe('e2e4');
    expect(res.second.infos.at(-1)!.score).toEqual({ mate: 1 });
  });
});
