import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MATE_IN_1 = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
const SANE_OPENING_MOVES = ['e2e4', 'd2d4', 'g1f3', 'c2c4', 'e2e3', 'b1c3', 'g2g3', 'c2c3', 'd2d3'];

interface Score {
  cp?: number;
  mate?: number;
}
interface Info {
  depth: number;
  score: Score;
  pv: string[];
  nps?: number;
  time?: number;
}
interface RunResult {
  isolated: boolean;
  capabilities: { threads: boolean; build: string; threadCount: number };
  loadMs: number;
  runs: { infos: Info[]; ms: number; bestMove: { move: string } | null }[];
}

/** Loads a WasmEngineClient in the page through the `window.__daisychess` hook and runs searches. */
async function runEngine(
  page: Page,
  options: { crossOriginIsolated?: boolean; build?: 'lite' | 'lite-single' | 'full' },
  searches: { fen: string; depth: number }[],
): Promise<RunResult> {
  return page.evaluate(
    async ({ options, searches }) => {
      // Page-side types: the hook is declared in src/engine/devHook.ts.
      type Handle = AsyncIterable<Info> & { bestMove: Promise<{ move: string } | null> };
      type Client = {
        load(): Promise<void>;
        analyze(fen: string, o: { depth: number }): Handle;
        capabilities(): RunResult['capabilities'];
        dispose(): Promise<void>;
      };
      const hook = (
        window as unknown as { __daisychess: { createWasmEngine(o: object): Promise<Client> } }
      ).__daisychess;
      const engine = await hook.createWasmEngine(options);
      const t0 = performance.now();
      await engine.load();
      const loadMs = performance.now() - t0;
      const runs: RunResult['runs'] = [];
      for (const s of searches) {
        const infos: Info[] = [];
        const t = performance.now();
        const handle = engine.analyze(s.fen, { depth: s.depth });
        for await (const info of handle) infos.push(info);
        runs.push({ infos, ms: performance.now() - t, bestMove: await handle.bestMove });
      }
      const capabilities = engine.capabilities();
      await engine.dispose();
      return { isolated: crossOriginIsolated, capabilities, loadMs, runs };
    },
    { options, searches },
  );
}

test.describe('WASM engine', () => {
  test.setTimeout(90_000);

  test('multi-threaded engine analyzes the start position and finds mate in 1', async ({
    page,
  }) => {
    const failed: string[] = [];
    page.on('requestfailed', (r) => failed.push(r.url()));
    await page.goto('/');
    const res = await runEngine(page, {}, [
      { fen: START, depth: 10 },
      { fen: MATE_IN_1, depth: 5 },
    ]);

    // Preview serves COOP/COEP, so SharedArrayBuffer and the threaded build are available.
    expect(res.isolated).toBe(true);
    expect(res.capabilities.threads).toBe(true);
    expect(res.capabilities.build).toMatch(/^stockfish-\d+\.\d+\.\d+-lite$/);

    const [start, mate] = res.runs;
    const last = start!.infos.at(-1)!;
    expect(last.depth).toBeGreaterThanOrEqual(10);
    expect(SANE_OPENING_MOVES).toContain(last.pv[0]);
    expect(last.score.cp).toBeGreaterThan(-100);
    expect(last.score.cp).toBeLessThan(100);

    expect(mate!.bestMove?.move).toBe('a1a8');
    expect(mate!.infos.at(-1)!.score).toEqual({ mate: 1 });
    expect(failed).toEqual([]);

    console.log(
      `[engine] ${res.capabilities.build} threads=${res.capabilities.threadCount} load=${res.loadMs.toFixed(0)}ms ` +
        `depth10=${start!.ms.toFixed(0)}ms nps=${last.nps ?? '?'} (engine time ${last.time ?? '?'}ms)`,
    );
  });

  test('full-strength build (opt-in, ~99 MB) loads and analyses the start position', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const failed: string[] = [];
    const wasmBytes: number[] = [];
    page.on('requestfailed', (r) => failed.push(r.url()));
    page.on('response', (r) => {
      if (r.url().endsWith('.wasm')) wasmBytes.push(Number(r.headers()['content-length'] ?? 0));
    });
    await page.goto('/');
    const t0 = Date.now();
    const res = await runEngine(page, { build: 'full' }, [{ fen: START, depth: 10 }]);
    const totalMs = Date.now() - t0;
    expect(res.isolated).toBe(true);
    expect(res.capabilities.threads).toBe(true);
    expect(res.capabilities.build).toMatch(/^stockfish-\d+\.\d+\.\d+-full$/);
    // Allow 60 s for the download, compilation and the depth-10 search.
    expect(totalMs).toBeLessThan(60_000);
    const last = res.runs[0]!.infos.at(-1)!;
    expect(last.depth).toBeGreaterThanOrEqual(10);
    expect(SANE_OPENING_MOVES).toContain(res.runs[0]!.bestMove?.move);
    expect(last.score.cp).toBeGreaterThan(-100);
    expect(last.score.cp).toBeLessThan(100);
    expect(failed).toEqual([]);
    console.log(
      `[engine] ${res.capabilities.build} threads=${res.capabilities.threadCount} wasm=${(Math.max(0, ...wasmBytes) / 1e6).toFixed(1)}MB ` +
        `load=${res.loadMs.toFixed(0)}ms depth10=${res.runs[0]!.ms.toFixed(0)}ms nps=${last.nps ?? '?'}`,
    );
  });

  test('falls back to the single-threaded build and reports White-POV scores', async ({ page }) => {
    await page.goto('/');
    // White is a queen up, Black to move: the engine reports a large negative score for Black,
    // which the client must flip to a large positive White-POV score.
    const blackToMove = '4k3/8/8/8/8/8/4Q3/4K3 b - - 0 1';
    const res = await runEngine(page, { crossOriginIsolated: false }, [
      { fen: START, depth: 8 },
      { fen: blackToMove, depth: 8 },
    ]);
    expect(res.capabilities).toMatchObject({ threads: false, threadCount: 1 });
    expect(res.capabilities.build).toMatch(/-lite-single$/);
    expect(res.runs[0]!.infos.at(-1)!.depth).toBeGreaterThanOrEqual(8);
    const score = res.runs[1]!.infos.at(-1)!.score;
    // From White's perspective: winning (large positive cp or positive mate).
    expect((score.cp ?? 0) > 500 || (score.mate ?? 0) > 0).toBe(true);
    console.log(
      `[engine] ${res.capabilities.build} depth8=${res.runs[0]!.ms.toFixed(0)}ms nps=${res.runs[0]!.infos.at(-1)!.nps ?? '?'}`,
    );
  });

  test('engine files are served same-origin with isolation headers', async ({ request }) => {
    const index = await request.get('/');
    expect(index.headers()['cross-origin-opener-policy']).toBe('same-origin');
    expect(index.headers()['cross-origin-embedder-policy']).toBe('require-corp');
    const html = await index.text();
    expect(html).not.toMatch(/https?:\/\/(?!localhost)[^"']+\.(js|wasm)/);

    // pnpm e2e builds before serving, so dist/ holds the emitted engine directory.
    const engineRoot = fileURLToPath(new URL('../dist/assets/engine', import.meta.url));
    const [dir] = readdirSync(engineRoot);
    expect(dir).toMatch(/^stockfish-\d+\.\d+\.\d+$/);
    for (const file of readdirSync(join(engineRoot, dir!))) {
      const res = await request.get(`/assets/engine/${dir}/${file}`);
      expect(res.status(), file).toBe(200);
      expect(res.headers()['content-type']).toMatch(
        file.endsWith('.wasm') ? /application\/wasm/ : /javascript/,
      );
      expect(res.headers()['cross-origin-embedder-policy']).toBe('require-corp');
    }
  });
});
