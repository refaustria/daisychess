// @vitest-environment node
// Mobile build mode (ADR-022): CSP meta policy and the engine files emitted per build.
import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import {
  buildCsp,
  metaCsp,
  mobileMetaCsp,
  MOBILE_HUB_SOURCE,
  PRODUCTION_CSP,
} from '../csp.config.mjs';
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

describe('mobileMetaCsp (M26-2 smoke server)', () => {
  const connect = (policy: string) =>
    policy.split('; ').find((d) => d.startsWith('connect-src')) ?? '';

  const store = metaCsp(buildCsp([MOBILE_HUB_SOURCE]));

  it('is metaCsp() plus wss: for store builds, whatever the smoke server variable says', () => {
    expect(mobileMetaCsp({})).toBe(store);
    expect(mobileMetaCsp({ VITE_MOBILE_SMOKE_SERVER_URL: 'ws://127.0.0.1:18580/ws' })).toBe(store);
    expect(mobileMetaCsp({ VITE_MOBILE_SMOKE: '1' })).toBe(store);
  });

  it('wss: (any self-hosted hub) is in the mobile connect-src only, not in the web policy', () => {
    expect(connect(store).split(' ')).toContain('wss:');
    expect(PRODUCTION_CSP).not.toMatch(/\swss:(;|\s|$)/);
    expect(connect(store).split(' ')).not.toContain('ws:');
  });

  it('adds only the loopback smoke server origin in a smoke build', () => {
    const p = mobileMetaCsp({
      VITE_MOBILE_SMOKE: '1',
      VITE_MOBILE_SMOKE_SERVER_URL: 'ws://127.0.0.1:18580/ws',
    });
    expect(connect(p)).toBe(`${connect(store)} ws://127.0.0.1:18580`);
    expect(p.replace(' ws://127.0.0.1:18580', '')).toBe(store);
  });

  it('refuses any other smoke server URL', () => {
    for (const url of [
      'wss://evil.example/ws',
      'ws://10.0.2.2:18580/ws',
      'ws://127.0.0.1:18580',
      'ws://*/ws',
    ]) {
      expect(
        () => mobileMetaCsp({ VITE_MOBILE_SMOKE: '1', VITE_MOBILE_SMOKE_SERVER_URL: url }),
        url,
      ).toThrow(/VITE_MOBILE_SMOKE_SERVER_URL/);
    }
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
        attrs: { 'http-equiv': 'Content-Security-Policy', content: mobileMetaCsp({}) },
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
