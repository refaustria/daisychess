// @vitest-environment node
// Mobile build mode (ADR-022): CSP meta policy and the engine files emitted per build.
import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCsp,
  metaCsp,
  mobileMetaCsp,
  MOBILE_APP_ORIGINS,
  MOBILE_HUB_SOURCE,
  MOBILE_PUZZLES_SOURCE,
  PRODUCTION_CSP,
} from '../csp.config.mjs';
import { checkConf, PUZZLE_LOCATIONS, REPO_FILES } from '../../../scripts/check-csp.mjs';
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

  const store = metaCsp(buildCsp([MOBILE_HUB_SOURCE, MOBILE_PUZZLES_SOURCE]));

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

  it('the puzzle host (ADR-023 §5) is in the mobile connect-src only; the web policy is unchanged', () => {
    expect(MOBILE_PUZZLES_SOURCE).toBe('https://play.daisychess.org');
    expect(connect(store).split(' ')).toContain('https://play.daisychess.org');
    expect(connect(PRODUCTION_CSP).split(' ')).not.toContain('https://play.daisychess.org');
    expect(PRODUCTION_CSP).toBe(buildCsp());
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
    const hook = plugin.transformIndexHtml as {
      order: string;
      handler: (html: string) => { html: string; tags: unknown[] };
    };
    expect(hook.order).toBe('post');
    const out = hook.handler(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    );
    expect(out.tags).toEqual([
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: mobileMetaCsp({}) },
        injectTo: 'head-prepend',
      },
    ]);
    // Edge-to-edge under the notch (M26-4): the mobile build only.
    expect(out.html).toContain('initial-scale=1.0, viewport-fit=cover');
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

describe('puzzle data CORS for the app origins (ADR-023 §5, scripts/check-csp.mjs)', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const read = (f: string) => readFileSync(join(repo, f), 'utf8');
  const commonSpec = REPO_FILES.find((f) => f.file.endsWith('daisychess-common.conf'))!;
  const playSpec = REPO_FILES.find((f) => f.file.endsWith('play.daisychess.org.conf'))!;
  const common = read(commonSpec.file);
  const play = read(playSpec.file);
  const errors = (conf: string, spec: typeof playSpec) =>
    checkConf('x', conf, spec).errors.join('\n');

  it('the repo files pass: map echoes the two app origins, both puzzle locations carry the group', () => {
    expect(MOBILE_APP_ORIGINS).toEqual([
      'https://app.daisychess.org',
      'capacitor://app.daisychess.org',
    ]);
    expect(checkConf('common', common, commonSpec).errors).toEqual([]);
    expect(checkConf('play', play, playSpec).errors).toEqual([]);
    expect(Object.keys(PUZZLE_LOCATIONS).sort()).toEqual([
      '/puzzles/v1/shards/',
      '= /puzzles/v1/index.json',
    ]);
  });

  it('fails when the map echoes another origin, drops one, or defaults to a value', () => {
    expect(
      errors(
        common.replace('"capacitor://app.daisychess.org"', '"https://evil.example"'),
        commonSpec,
      ),
    ).toMatch(/must echo exactly/);
    expect(
      errors(
        common.replace(/\n\s*"capacitor:\/\/app\.daisychess\.org" \$http_origin;/, ''),
        commonSpec,
      ),
    ).toMatch(/must echo exactly/);
    expect(errors(common.replace('default "";', 'default "*";'), commonSpec)).toMatch(
      /must echo exactly/,
    );
    expect(
      errors(common.replace(/map \$http_origin \$daisychess_app_cors \{[^}]*\}/, ''), commonSpec),
    ).toMatch(/no `map \$http_origin \$daisychess_app_cors/);
  });

  it('fails when a puzzle location loses CORS, Vary, CORP cross-origin, its cache policy or the CSP', () => {
    const shards = /(location \/puzzles\/v1\/shards\/ \{[\s\S]*?)\n\s*add_header ([\w-]+)[^\n]*/;
    const drop = (header: string) =>
      play.replace(
        new RegExp(
          `(location \\/puzzles\\/v1\\/shards\\/ \\{[\\s\\S]*?)\\n\\s*add_header ${header} [^\\n]*`,
        ),
        '$1',
      );
    expect(shards.test(play)).toBe(true);
    expect(errors(drop('Access-Control-Allow-Origin'), playSpec)).toMatch(
      /Access-Control-Allow-Origin \$daisychess_app_cors always/,
    );
    expect(errors(drop('Vary'), playSpec)).toMatch(/Vary "Origin"/);
    expect(errors(drop('Content-Security-Policy'), playSpec)).toMatch(
      /without Content-Security-Policy/,
    );
    expect(errors(drop('Strict-Transport-Security'), playSpec)).toMatch(
      /missing Strict-Transport-Security/,
    );
    expect(
      errors(
        play.replace(
          'max-age=31536000, immutable";\n        add_header Access',
          'max-age=60";\n        add_header Access',
        ),
        playSpec,
      ),
    ).toMatch(/Cache-Control must be "public, max-age=31536000, immutable"/);
    const sameOrigin = play.replace(
      /(location = \/puzzles\/v1\/index\.json \{[\s\S]*?)Cross-Origin-Resource-Policy "cross-origin"/,
      '$1Cross-Origin-Resource-Policy "same-origin"',
    );
    expect(errors(sameOrigin, playSpec)).toMatch(
      /index\.json: Cross-Origin-Resource-Policy must be "cross-origin"/,
    );
  });

  it('fails when the puzzle locations are missing or CORS leaks into another location', () => {
    const noIndex = play.replace(/location = \/puzzles\/v1\/index\.json \{[\s\S]*?\n {4}\}\n/, '');
    expect(errors(noIndex, playSpec)).toMatch(/no `location = \/puzzles\/v1\/index\.json`/);
    const leak = play.replace(
      /(location \/assets\/ \{\n)/,
      '$1        add_header Access-Control-Allow-Origin $daisychess_app_cors always;\n',
    );
    expect(errors(leak, playSpec)).toMatch(
      /Access-Control-Allow-Origin outside the puzzle locations \(\/assets\/\)/,
    );
    const corp = play.replace(
      /(location \/assets\/ \{[\s\S]*?)Cross-Origin-Resource-Policy "same-origin"/,
      '$1Cross-Origin-Resource-Policy "cross-origin"',
    );
    expect(errors(corp, playSpec)).toMatch(/other than same-origin outside the puzzle locations/);
    expect(
      errors(`map $http_origin $daisychess_app_cors {\n default "";\n}\n${play}`, playSpec),
    ).toMatch(/belong in daisychess-common.conf/);
  });

  it('checks live files that carry the puzzle locations or the map', () => {
    expect(checkConf('live', play, {}).errors).toEqual([]);
    expect(checkConf('live', common, {}).errors).toEqual([]);
    expect(
      checkConf('live', play.replace('Vary "Origin"', 'Vary "Accept"'), {}).errors.join('\n'),
    ).toMatch(/Vary "Origin"/);
  });
});
