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
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

export interface StockfishEngineManifest {
  version: string;
  /** Directory relative to the Vite `base`, with trailing slash. */
  dir: string;
  /** Worker script file name per build. */
  builds: { 'lite-single': string; lite: string };
}

const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
} as const;

export function stockfishEngines(): Plugin {
  const require = createRequire(import.meta.url);
  const pkgDir = dirname(require.resolve('stockfish/package.json'));
  const binDir = join(pkgDir, 'bin');
  const version = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string })
    .version;
  const major = version.split('.')[0];
  const builds = {
    'lite-single': `stockfish-${major}-lite-single.js`,
    lite: `stockfish-${major}-lite.js`,
  };
  const files = Object.values(builds).flatMap((js) => [js, js.replace(/\.js$/, '.wasm')]);
  for (const f of files) {
    if (!existsSync(join(binDir, f))) {
      throw new Error(`[stockfish-engines] missing ${f} in ${binDir} (stockfish ${version})`);
    }
  }
  const manifest: StockfishEngineManifest = {
    version,
    dir: `assets/engine/stockfish-${version}/`,
    builds,
  };
  let base = '/';

  return {
    name: 'chesslab:stockfish-engines',
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
        if (!files.includes(name)) return next();
        res.setHeader(
          'Content-Type',
          name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8',
        );
        for (const [k, v] of Object.entries(ISOLATION_HEADERS)) res.setHeader(k, v);
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(join(binDir, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const f of files) {
        this.emitFile({ type: 'asset', fileName: manifest.dir + f, source: readFileSync(join(binDir, f)) });
      }
    },
  };
}
