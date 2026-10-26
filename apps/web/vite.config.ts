/// <reference types="vitest/config" />
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin, type UserConfig } from 'vite';
import { buildCsp, CSP_REPORT_FILE, mobileMetaCsp } from './csp.config.mjs';
import { stockfishEngines } from './vite-plugin-stockfish';

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

const CSP_REPORT_PATH = '/__csp-report';

/** Preview-only sink for `report-uri`: one JSON line per violation, so e2e can assert none. */
function cspReportCollector(): Plugin {
  return {
    name: 'daisychess:csp-report-collector',
    configurePreviewServer(server) {
      server.middlewares.use(CSP_REPORT_PATH, (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').slice(0, 16_384);
          mkdirSync(dirname(CSP_REPORT_FILE), { recursive: true });
          appendFileSync(
            CSP_REPORT_FILE,
            `${JSON.stringify({ at: new Date().toISOString(), body })}\n`,
          );
          console.error(`[csp-violation] ${body}`);
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// `vite preview` serves the production build with the production policy (csp.config.mjs). The
// single addition is loopback WebSockets: the e2e specs start engine servers on 127.0.0.1:858x.
// The dev server gets no CSP: Vite injects inline scripts/styles for HMR and React Refresh.
const previewHeaders = {
  ...isolation,
  // 'report-sample' puts the first 40 characters of a blocked script into the report.
  'Content-Security-Policy': `${buildCsp(['ws://127.0.0.1:*', 'ws://localhost:*']).replace(
    "script-src 'self'",
    "script-src 'self' 'report-sample'",
  )}; report-uri ${CSP_REPORT_PATH}`,
};

/**
 * `vite build --mode mobile` (ADR-022): the same app for the Capacitor shell in `apps/mobile`,
 * written to `dist-mobile`. Three differences: only the `lite-single` engine is emitted, the
 * default server URL is a compile-time constant (`VITE_DEFAULT_SERVER_URL`, read by
 * `defaultServerUrl()` in the app only) and the CSP travels in a `<meta http-equiv>`, since no
 * server sends the header there.
 */
/** Build identity for About (appInfo.ts): version of the app package, git commit, target. */
export function buildInfoDefines(mobile: boolean): Record<string, string> {
  const pkgUrl = new URL(mobile ? '../mobile/package.json' : './package.json', import.meta.url);
  const version = (JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8')) as { version: string })
    .version;
  let commit = process.env.GITHUB_SHA ?? '';
  if (!commit) {
    try {
      commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      commit = '';
    }
  }
  return {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_BUILD__: JSON.stringify(process.env.GITHUB_RUN_NUMBER ?? ''),
    __APP_MOBILE__: JSON.stringify(mobile),
  };
}

export const MOBILE_MODE = 'mobile';
export const MOBILE_OUT_DIR = 'dist-mobile';
export const MOBILE_DEFAULT_SERVER_URL = 'wss://play.daisychess.org/ws';

/**
 * Injects the production CSP (minus the header-only directives) as the first element of <head>;
 * a CI smoke build may add its loopback server (`mobileMetaCsp`, M26-2).
 */
export function cspMetaTag(): Plugin {
  return {
    name: 'daisychess:csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html: string) => ({
        // `viewport-fit=cover` (edge-to-edge under the notch; the layout pads with the safe-area
        // insets, M26-4) is the mobile build only: the web page keeps the plain viewport.
        html: html.replace(
          'content="width=device-width, initial-scale=1.0"',
          'content="width=device-width, initial-scale=1.0, viewport-fit=cover"',
        ),
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: mobileMetaCsp() },
            injectTo: 'head-prepend' as const,
          },
        ],
      }),
    },
  };
}

/** The app-link association files (public/.well-known) are for the web host, not for the bundle. */
function dropWellKnown(): Plugin {
  return {
    name: 'daisychess:drop-well-known',
    apply: 'build',
    closeBundle() {
      rmSync(fileURLToPath(new URL(`${MOBILE_OUT_DIR}/.well-known`, import.meta.url)), {
        recursive: true,
        force: true,
      });
    },
  };
}

function mobileConfig(): UserConfig {
  return {
    plugins: [
      react(),
      stockfishEngines({ builds: ['lite-single'] }),
      cspMetaTag(),
      dropWellKnown(),
    ],
    define: {
      ...buildInfoDefines(true),
      // An explicit VITE_DEFAULT_SERVER_URL in the environment wins (CI points it at a runner hub).
      'import.meta.env.VITE_DEFAULT_SERVER_URL': JSON.stringify(
        process.env.VITE_DEFAULT_SERVER_URL || MOBILE_DEFAULT_SERVER_URL,
      ),
    },
    build: { outDir: MOBILE_OUT_DIR },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), stockfishEngines(), cspReportCollector()],
  define: buildInfoDefines(false),
  ...(mode === MOBILE_MODE ? mobileConfig() : {}),
  resolve: {
    alias: {
      '@daisychess/engine-core': fileURLToPath(
        new URL('../../packages/engine-core/src/index.ts', import.meta.url),
      ),
      '@daisychess/puzzles': fileURLToPath(
        new URL('../../packages/puzzles/src/index.ts', import.meta.url),
      ),
    },
  },
  server: { port: 5180, strictPort: true, headers: isolation },
  preview: { headers: previewHeaders },
  test: {
    environment: 'jsdom',
    globals: false,
    exclude: ['**/node_modules/**', 'e2e/**'],
    setupFiles: ['./src/test/setup.ts'],
  },
}));
