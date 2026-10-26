// @vitest-environment node
// Mobile build mode (ADR-022): CSP meta policy and the engine files emitted per build.
import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { metaCsp, PRODUCTION_CSP } from '../csp.config.mjs';
import { stockfishEngines } from '../vite-plugin-stockfish';
import { cspMetaTag, MOBILE_DEFAULT_SERVER_URL, MOBILE_OUT_DIR } from '../vite.config';

const directives = (policy: string) => policy.split('; ').map((d) => d.split(' ')[0]);

describe('metaCsp', () => {
  it('is the production policy minus the header-only directives', () => {
    const meta = metaCsp();
    expect(directives(meta)).not.toContain('frame-ancestors');
    expect(
      PRODUCTION_CSP.split('; ')
        .filter((d) => !d.startsWith('frame-ancestors'))
        .join('; '),
    ).toBe(meta);
    expect(meta).toContain("'wasm-unsafe-eval'");
    expect(meta).toContain('wss://play.daisychess.org');
  });

  it('drops report-uri and sandbox and tolerates stray separators', () => {
    expect(metaCsp("default-src 'self';; report-uri /x; sandbox;  img-src data: ")).toBe(
      "default-src 'self'; img-src data:",
    );
  });
});

describe('cspMetaTag', () => {
  it('prepends the meta policy to <head> in builds only', () => {
    const plugin = cspMetaTag();
    expect(plugin.apply).toBe('build');
    const hook = plugin.transformIndexHtml as { order: string; handler: () => unknown };
    expect(hook.order).toBe('post');
    expect(hook.handler()).toEqual([
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: metaCsp() },
        injectTo: 'head-prepend',
      },
    ]);
  });

  it('mobile constants', () => {
    expect(MOBILE_OUT_DIR).toBe('dist-mobile');
    expect(MOBILE_DEFAULT_SERVER_URL).toBe('wss://play.daisychess.org/ws');
  });
});

function emitted(plugin: Plugin): string[] {
  const names: string[] = [];
  const ctx = { emitFile: (f: { fileName: string }) => names.push(f.fileName) };
  (plugin.generateBundle as unknown as (this: typeof ctx) => void).call(ctx);
  return names.map((n) => n.split('/').pop() ?? n).sort();
}

describe('stockfishEngines builds option', () => {
  it('emits every build and the memory shim by default (web build unchanged)', () => {
    expect(emitted(stockfishEngines())).toEqual([
      'stockfish-19-lite-single.js',
      'stockfish-19-lite-single.wasm',
      'stockfish-19-lite.js',
      'stockfish-19-lite.wasm',
      'stockfish-19.js',
      'stockfish-19.wasm',
      'stockfish-memory-shim.js',
    ]);
  });

  it('emits only lite-single (no shim) for the mobile build, with the full manifest', () => {
    const plugin = stockfishEngines({ builds: ['lite-single'] });
    expect(emitted(plugin)).toEqual([
      'stockfish-19-lite-single.js',
      'stockfish-19-lite-single.wasm',
    ]);
    const cfg = (plugin.config as () => { define: Record<string, string> })();
    const manifest = JSON.parse(cfg.define.__STOCKFISH_ENGINE__ ?? '{}') as {
      builds: Record<string, string>;
    };
    expect(Object.keys(manifest.builds).sort()).toEqual(['full', 'lite', 'lite-single']);
  });
});
