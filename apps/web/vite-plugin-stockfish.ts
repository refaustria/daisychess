/**
 * Ships the Stockfish WASM engines from the `stockfish` npm package as plain,
 * same-origin static files (see docs/DECISIONS.md, ADR "Browser engine delivery").
 *
 * The engine `.js` files are classic (non-module) Emscripten worker scripts that
 * locate their `.wasm` next to themselves and spawn pthread workers from their own
 * URL, so they must not be bundled or rewritten by Rollup. Instead:
 *   - build: the files are emitted verbatim to `assets/engine/stockfish-<version>/`
 *     (versioned directory => safe to cache as immutable, like Vite's hashed assets);
 *   - dev: the same URL path is served straight from `node_modules` with the
 *     cross-origin isolation headers.
 * The client learns the location through the `__STOCKFISH_ENGINE__` define.
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export interface StockfishEngineManifest {
  version: string;
  /** Directory relative to the Vite `base`, with trailing slash. */
  dir: string;
  /** Worker script file name per build (`full` = the multi-threaded build with the big NNUE). */
  builds: { 'lite-single': string; lite: string; full: string };
  /** Download size in bytes per build (worker script + `.wasm`), for the UI. */
  sizes: { 'lite-single': number; lite: number; full: number };
  /**
   * Worker shim that caps the shared memory's maximum of the multi-threaded builds on
   * memory-constrained devices (ADR-015; `engine-shim/stockfish-memory-shim.js`).
   */
  memoryShim: string;
}

const MEMORY_SHIM = 'stockfish-memory-shim.js';
const MEMORY_SHIM_PATH = fileURLToPath(new URL(`./engine-shim/${MEMORY_SHIM}`, import.meta.url));

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

type StockfishBuild = keyof StockfishEngineManifest['builds'];

export interface StockfishEnginesOptions {
  /**
   * Builds whose files are emitted (and served in dev); default all three. The mobile build
   * (ADR-022) ships `lite-single` only: the app's WebView is never cross-origin isolated, so the
   * multi-threaded builds could not run, and the memory shim (multi-threaded only) is left out too.
   * The manifest still names every build, so the registry code is the same in both builds.
   */
  builds?: readonly StockfishBuild[];
}

export function stockfishEngines(options: StockfishEnginesOptions = {}): Plugin {
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve('stockfish/package.json'));
  const binDir = join(pkgDir, 'bin');
  const version = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string })
    .version;
  const major = version.split('.')[0];
  const builds = {
    'lite-single': `stockfish-${major}-lite-single.js`,
    lite: `stockfish-${major}-lite.js`,
    // Opt-in (ADR-010): full-strength network embedded in a ~99 MB .wasm, loaded on demand only.
    full: `stockfish-${major}.js`,
  };
  const filesOf = (js: string) => [js, js.replace(/\.js$/, '.wasm')];
  const emitted = options.builds ?? (Object.keys(builds) as StockfishBuild[]);
  const files = emitted.map((b) => builds[b]).flatMap(filesOf);
  const withShim = emitted.some((b) => b !== 'lite-single');
  for (const f of Object.values(builds).flatMap(filesOf)) {
    if (!existsSync(join(binDir, f))) {
      throw new Error(`[stockfish-engines] missing ${f} in ${binDir} (stockfish ${version})`);
    }
  }
  const sizeOf = (js: string) => filesOf(js).reduce((n, f) => n + statSync(join(binDir, f)).size, 0);
  const manifest: StockfishEngineManifest = {
    version,
    dir: `assets/engine/stockfish-${version}/`,
    builds,
    sizes: {
      'lite-single': sizeOf(builds['lite-single']),
      lite: sizeOf(builds.lite),
      full: sizeOf(builds.full),
    },
    memoryShim: MEMORY_SHIM,
  };
  let base = '/';

  return {
    name: 'daisychess:stockfish-engines',
    config: () => ({ define: { __STOCKFISH_ENGINE__: JSON.stringify(manifest) } }),
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      const prefix = `${base}${manifest.dir}`;
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split(/[?#]/)[0];
        if (!path?.startsWith(prefix)) return next();
        const name = path.slice(prefix.length);
        if (!files.includes(name) && !(withShim && name === MEMORY_SHIM)) return next();
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        );
        for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(name === MEMORY_SHIM ? MEMORY_SHIM_PATH : join(binDir, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const f of files) {
        this.emitFile({ type: 'asset', fileName: manifest.dir + f, source: readFileSync(join(binDir, f)) });
      }
      if (!withShim) return;
      this.emitFile({
        type: 'asset',
        fileName: manifest.dir + MEMORY_SHIM,
        source: readFileSync(MEMORY_SHIM_PATH),
      });
    },
  };
}
