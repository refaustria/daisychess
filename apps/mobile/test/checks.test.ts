import { describe, expect, it } from 'vitest';
import { checkDist } from '../scripts/check-dist.mjs';
import { checkSmokeResult, findSmokeResult } from '../scripts/check-smoke-log.mjs';

const CSP = "default-src 'self'; script-src 'self'";
const meta = `<meta http-equiv="Content-Security-Policy" content="${CSP.replace(/'/g, '&#39;')}">`;
const html = (head: string) =>
  `<!doctype html><html><head>${head}<script type="module" src="/assets/index-x.js"></script></head></html>`;
const ENGINE = [
  'assets/engine/stockfish-19.0.1/stockfish-19-lite-single.js',
  'assets/engine/stockfish-19.0.1/stockfish-19-lite-single.wasm',
];
const ok = {
  files: ['index.html', ...ENGINE],
  indexHtml: html(meta),
  expectedCsp: CSP,
  totalBytes: 3e6,
};

describe('checkDist', () => {
  it('accepts a lite-single build with the CSP meta first', () => {
    expect(checkDist(ok)).toEqual([]);
  });

  it('rejects the multi-threaded builds and the memory shim', () => {
    const files = [
      ...ok.files,
      'assets/engine/stockfish-19.0.1/stockfish-19-lite.js',
      'assets/engine/stockfish-19.0.1/stockfish-19.wasm',
      'assets/engine/stockfish-19.0.1/stockfish-memory-shim.js',
    ];
    expect(checkDist({ ...ok, files })).toHaveLength(3);
  });

  it('requires both lite-single files', () => {
    expect(checkDist({ ...ok, files: ['index.html', ENGINE[0] ?? ''] })).toEqual([
      'missing lite-single .wasm',
    ]);
  });

  it('requires exactly one matching CSP meta before the scripts', () => {
    expect(checkDist({ ...ok, indexHtml: html('') })[0]).toMatch(/exactly one CSP meta/);
    expect(checkDist({ ...ok, expectedCsp: "default-src 'none'" })[0]).toMatch(/differs/);
    const late = `<!doctype html><html><head><script>x</script>${meta}</head></html>`;
    expect(checkDist({ ...ok, indexHtml: late })).toContain(
      'CSP meta must come before the first <script>',
    );
  });

  it('rejects absolute asset URLs and an oversized bundle', () => {
    const abs = html(`${meta}<link rel="icon" href="https://play.daisychess.org/favicon.svg">`);
    expect(checkDist({ ...ok, indexHtml: abs })[0]).toMatch(/absolute asset URL/);
    const proto = html(`${meta}<script src="//cdn.example/x.js"></script>`);
    expect(checkDist({ ...ok, indexHtml: proto })[0]).toMatch(/absolute asset URL/);
    expect(checkDist({ ...ok, totalBytes: 50e6 })[0]).toMatch(/budget/);
  });
});

const good = {
  platform: 'android',
  origin: 'https://app.daisychess.org',
  isSecureContext: true,
  crossOriginIsolated: false,
  engine: 'wasm:lite-single',
  bestmove: 'e2e4',
  ms: 4000,
};

describe('findSmokeResult', () => {
  it('reads the JSON after the marker from logcat and iOS stdout lines, last one wins', () => {
    const log = [
      '10-26 10:00:00.000  123  123 I Capacitor/Console: File: https://app.daisychess.org/assets/x.js - Line 1 - Msg: hello',
      `10-26 10:00:01.000  123  123 I Capacitor/Console: File: x - Line 1 - Msg: DAISYCHESS_SMOKE ${JSON.stringify({ ...good, bestmove: null })}`,
      `⚡️  [log] - DAISYCHESS_SMOKE ${JSON.stringify(good)}`,
    ].join('\n');
    expect(findSmokeResult(log)).toEqual(good);
  });

  it('ignores truncated lines and returns null without a marker', () => {
    expect(findSmokeResult('DAISYCHESS_SMOKE {"platform":"ios"')).toBeNull();
    expect(findSmokeResult('nothing here\n')).toBeNull();
  });
});

describe('checkSmokeResult', () => {
  it('accepts the expected native context', () => {
    expect(checkSmokeResult(good, 'android')).toEqual([]);
    expect(checkSmokeResult({ ...good, platform: 'ios', bestmove: 'e7e8q' }, 'ios')).toEqual([]);
  });

  it('flags each wrong field', () => {
    expect(checkSmokeResult(null, 'ios')).toEqual(['no DAISYCHESS_SMOKE line in the log']);
    expect(
      checkSmokeResult(
        {
          ...good,
          isSecureContext: false,
          crossOriginIsolated: true,
          bestmove: '(none)',
          error: 'timed out',
        },
        'ios',
      ),
    ).toEqual([
      'platform android, expected ios',
      'isSecureContext is not true',
      'crossOriginIsolated is not false',
      'no bestmove ((none))',
      'error: timed out',
    ]);
  });
});
