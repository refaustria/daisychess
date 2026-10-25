/// <reference types="vitest/config" />
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { applyPartials, buildSitemap } from './build/partials';
import { PAGES, pageByFile } from './site.config';
import { SITE_SECURITY_HEADERS } from './csp.config.mjs';

const root = dirname(fileURLToPath(import.meta.url));

/** Shared head/header/footer and {{TOKENS}} for every page; sitemap.xml at build time. */
function sitePages(): Plugin {
  return {
    name: 'daisychess-site-pages',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const rel = ctx.filename.slice(root.length + 1);
        const page = pageByFile(rel);
        if (!page) {
          // tools/*.html (asset rendering, dev only) have no page entry.
          if (rel.startsWith('tools/')) return html;
          throw new Error(`no page metadata for ${rel} (add it to site.config.ts)`);
        }
        return applyPartials(html, page);
      },
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: buildSitemap(PAGES) });
    },
  };
}

/** `vite preview` like nginx: unknown paths get 404.html with status 404 (not a SPA fallback). */
function preview404(): Plugin {
  return {
    name: 'daisychess-site-preview-404',
    configurePreviewServer(server) {
      const outDir = resolve(root, server.config.build.outDir);
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '/').split('?')[0] ?? '/';
        let p = decodeURIComponent(url);
        if (p.endsWith('/')) p += 'index.html';
        const file = join(outDir, p);
        const ok =
          file.startsWith(outDir) &&
          ((existsSync(file) && statSync(file).isFile()) || existsSync(join(file, 'index.html')));
        if (ok) return next();
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        for (const [k, v] of Object.entries(SITE_SECURITY_HEADERS)) res.setHeader(k, v);
        res.end(readFileSync(join(outDir, '404.html')));
      });
    },
  };
}

export default defineConfig({
  appType: 'mpa',
  plugins: [sitePages(), preview404()],
  server: { port: 5182, strictPort: true },
  preview: { headers: { ...SITE_SECURITY_HEADERS, 'Cache-Control': 'no-store' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // The modulepreload polyfill is not needed by the browsers we target and would be one more
    // script to audit; no inline scripts are emitted either way.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    // three.js is one lazy ~540 kB (135 kB gzip) chunk loaded only by the home hero; that is expected.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      input: Object.fromEntries(PAGES.map((p) => [p.key, resolve(root, p.file)])),
    },
  },
  test: {
    environment: 'node',
    exclude: ['**/node_modules/**', 'e2e/**', 'dist/**'],
  },
});
