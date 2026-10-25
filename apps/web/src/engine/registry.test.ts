import type { EngineDescriptor as ServerEngine } from '@daisychess/engine-core';
import { describe, expect, it } from 'vitest';
import {
  maxWasmInstances,
  maxWasmThreads,
  browserEngines,
  canEnable,
  defaultWasmKey,
  defaultThreads,
  describeEngine,
  displacedBy,
  formatDownload,
  listEngines,
  NOT_ISOLATED_REASON,
  parseEngineKey,
  probeServer,
  serverEngines,
  shortEngineName,
  type ProbeClient,
  wasmBuildUnsupportedReason,
} from './registry';
import { NO_SIMD_REASON, NO_THREADS_REASON, type WasmSupport } from './wasmSupport';

const ISOLATED = { crossOriginIsolated: true, hardwareConcurrency: 8 };
const PLAIN = { crossOriginIsolated: false, hardwareConcurrency: 8 };
const SF: ServerEngine = {
  id: 'stockfish',
  name: 'Stockfish 19',
  enabled: true,
  defaults: { threads: 4, hash: 256 },
};
const FAIRY: ServerEngine = {
  id: 'fairy-stockfish',
  name: 'Fairy-Stockfish',
  enabled: false,
  defaults: { threads: 2, hash: 128 },
};

describe('parseEngineKey', () => {
  it('parses browser builds and server engine ids', () => {
    expect(parseEngineKey('wasm:lite')).toEqual({ backend: 'wasm', build: 'lite' });
    expect(parseEngineKey('wasm:lite-single')).toEqual({ backend: 'wasm', build: 'lite-single' });
    expect(parseEngineKey('wasm:full')).toEqual({ backend: 'wasm', build: 'full' });
    expect(parseEngineKey('remote:stockfish')).toEqual({
      backend: 'remote',
      engineId: 'stockfish',
    });
    for (const bad of ['wasm:max', 'remote:', 'remote:../x', 'remote:a b', 'x', 3, null]) {
      expect(parseEngineKey(bad)).toBeNull();
    }
  });
});

describe('browser engines', () => {
  it('offers the multi-threaded build only on cross-origin isolated pages', () => {
    const [lite, single, full] = browserEngines(PLAIN);
    expect(lite).toMatchObject({ key: 'wasm:lite', available: false, reason: NOT_ISOLATED_REASON });
    expect(full).toMatchObject({ key: 'wasm:full', available: false, reason: NOT_ISOLATED_REASON });
    expect(single).toMatchObject({ key: 'wasm:lite-single', available: true, badge: 'browser' });
    expect(single!.reason).toBeUndefined();

    const iso = browserEngines(ISOLATED);
    expect(iso.every((d) => d.available)).toBe(true);
    expect(iso[0]!.name).toMatch(/^Stockfish \d+ \(browser, multi-thread, 4 threads\)$/);
    expect(iso[1]!.name).toMatch(/^Stockfish \d+ \(browser, single-thread\)$/);
    expect(iso[1]!.badge).toBe('browser 1T');
    expect(iso[2]!.name).toMatch(/^Stockfish \d+ \(browser, maximum strength, ~\d+ MB download\)$/);
    expect(iso[2]!.downloadBytes).toBeGreaterThan(50e6);
    expect(iso[2]!.badge).toBe('browser max');
  });

  it('labels stay unique on a 2-core machine', () => {
    const two = browserEngines({ crossOriginIsolated: true, hardwareConcurrency: 2 });
    expect(two[0]!.name).toMatch(/multi-thread, 1 thread\)$/);
    expect(new Set(two.map((d) => d.name)).size).toBe(two.length);
  });

  it('formats download sizes and default threads', () => {
    expect(formatDownload(99_076_105)).toBe('~99 MB');
    expect(formatDownload(10)).toBe('~1 MB');
    expect(defaultThreads({ crossOriginIsolated: true, hardwareConcurrency: 2 })).toBe(1);
    expect(defaultThreads(ISOLATED)).toBe(4);
  });

  it('defaults to the best build the page can run', () => {
    expect(defaultWasmKey(ISOLATED)).toBe('wasm:lite');
    expect(defaultWasmKey(PLAIN)).toBe('wasm:lite-single');
  });
});

describe('server engines', () => {
  it('lists the probed engines; disabled ones carry a reason', () => {
    const list = serverEngines({ status: 'ok', engines: [SF, FAIRY], lastProbe: 1 });
    expect(list).toEqual([
      {
        key: 'remote:stockfish',
        backend: 'remote',
        name: 'Stockfish 19 (server)',
        short: 'SF19',
        badge: 'server',
        available: true,
      },
      {
        key: 'remote:fairy-stockfish',
        backend: 'remote',
        name: 'Fairy-Stockfish (server)',
        short: 'Fairy-SF',
        badge: 'server',
        available: false,
        reason: 'Disabled on the server',
      },
    ]);
  });

  it('shows a placeholder while probing and the error after a failed probe', () => {
    expect(serverEngines({ status: 'probing' })).toMatchObject([
      { key: 'remote:stockfish', available: false, reason: 'Checking the server…' },
    ]);
    expect(serverEngines({ status: 'error', error: 'Server unreachable' })).toMatchObject([
      { available: false, reason: 'Server unavailable: Server unreachable' },
    ]);
  });

  it('keeps enabled keys visible even when the server does not offer them', () => {
    const list = serverEngines({ status: 'ok', engines: [SF] }, ['remote:lc0', 'wasm:lite']);
    expect(list.map((d) => [d.key, d.available, d.reason])).toEqual([
      ['remote:stockfish', true, undefined],
      ['remote:lc0', false, 'Not offered by the server'],
    ]);
    expect(
      serverEngines({ status: 'error', error: 'x' }, ['remote:lc0']).map((d) => d.key),
    ).toEqual(['remote:lc0']);
  });

  it('listEngines puts browser builds first; describeEngine finds any key', () => {
    const probe = { status: 'ok' as const, engines: [SF] };
    expect(listEngines(probe, [], PLAIN).map((d) => d.key)).toEqual([
      'wasm:lite',
      'wasm:lite-single',
      'wasm:full',
      'remote:stockfish',
    ]);
    expect(describeEngine('remote:stockfish', probe, PLAIN).name).toBe('Stockfish 19 (server)');
    expect(describeEngine('remote:other', { status: 'idle' }, PLAIN)).toMatchObject({
      key: 'remote:other',
      badge: 'server',
    });
  });

  it('shortEngineName', () => {
    expect(shortEngineName('Stockfish 19')).toBe('SF19');
    expect(shortEngineName('Stockfish 17.1 Lite')).toBe('SF17');
    expect(shortEngineName('Lc0 v0.31')).toBe('Lc0');
    expect(shortEngineName('')).toBe('Engine');
  });
});

describe('canEnable (resource guard)', () => {
  it('allows one instance per browser build and at most two server engines', () => {
    expect(canEnable('wasm:lite', [], ISOLATED)).toEqual({ ok: true });
    expect(canEnable('wasm:lite', [], PLAIN)).toEqual({ ok: false, reason: NOT_ISOLATED_REASON });
    expect(canEnable('wasm:lite-single', ['wasm:lite'], ISOLATED)).toEqual({ ok: true });
    expect(canEnable('wasm:lite', ['wasm:lite'], ISOLATED).ok).toBe(false);
    expect(canEnable('remote:a', ['wasm:lite'], ISOLATED)).toEqual({ ok: true });
    expect(canEnable('remote:b', ['remote:a'], ISOLATED)).toEqual({ ok: true });
    expect(canEnable('remote:c', ['remote:a', 'remote:b'], ISOLATED)).toEqual({
      ok: false,
      reason: 'At most 2 server engines can run at once',
    });
    expect(canEnable('bogus', [], ISOLATED).ok).toBe(false);
  });

  it('full build: needs isolation; lite and full displace each other', () => {
    expect(canEnable('wasm:full', [], PLAIN)).toEqual({ ok: false, reason: NOT_ISOLATED_REASON });
    expect(canEnable('wasm:full', ['wasm:lite'], ISOLATED)).toEqual({ ok: true });
    expect(displacedBy('wasm:full', ['wasm:lite', 'wasm:lite-single'])).toEqual(['wasm:lite']);
    expect(displacedBy('wasm:lite', ['remote:a', 'wasm:full'])).toEqual(['wasm:full']);
    expect(displacedBy('wasm:lite-single', ['wasm:lite', 'wasm:full'])).toEqual([]);
    expect(displacedBy('remote:a', ['wasm:full'])).toEqual([]);
  });
});

class FakeClient implements ProbeClient {
  disposed = 0;
  engines: ServerEngine[] = [];
  limits = undefined;
  constructor(private readonly fail: Error | null) {}
  async load() {
    if (this.fail) throw this.fail;
    this.engines = [SF, FAIRY];
  }
  async dispose() {
    this.disposed++;
  }
}

describe('probeServer', () => {
  it('reads the engines and always disposes the client', async () => {
    const ok = new FakeClient(null);
    await expect(probeServer(() => ok)).resolves.toEqual({ engines: [SF, FAIRY] });
    expect(ok.disposed).toBe(1);

    const bad = new FakeClient(Object.assign(new Error('closed'), { code: 'closed' }));
    await expect(probeServer(async () => bad)).rejects.toThrow('closed');
    expect(bad.disposed).toBe(1);
  });
});

describe('memory budget (ADR-015)', () => {
  const IPAD = {
    crossOriginIsolated: true,
    hardwareConcurrency: 8,
    budget: { maxInstances: 1, maxThreads: 2, constrained: true, reason: 'ios' as const },
  };
  const DESKTOP = {
    crossOriginIsolated: true,
    hardwareConcurrency: 8,
    budget: { maxInstances: 2, maxThreads: 4, constrained: false },
  };

  it('caps default threads and the offered thread range on constrained devices', () => {
    expect(defaultThreads(IPAD)).toBe(2);
    expect(maxWasmThreads(IPAD)).toBe(2);
    expect(defaultThreads(DESKTOP)).toBe(4);
    expect(maxWasmThreads(DESKTOP)).toBe(7);
    expect(maxWasmThreads(ISOLATED)).toBe(7);
    expect(browserEngines(IPAD)[0]!.name).toMatch(/multi-thread, 2 threads\)$/);
  });

  it('one browser engine on iOS: a second is refused, a replacement (lite ⇄ full) is allowed', () => {
    expect(maxWasmInstances(IPAD)).toBe(1);
    expect(maxWasmInstances(ISOLATED)).toBe(2);
    const reason = 'Memory budget: one browser engine at a time on this device';
    expect(canEnable('wasm:lite-single', ['wasm:lite'], IPAD)).toEqual({ ok: false, reason });
    expect(canEnable('wasm:lite', ['wasm:lite-single', 'remote:stockfish'], IPAD)).toEqual({
      ok: false,
      reason,
    });
    // The store passes `enabled` without the displaced key.
    expect(canEnable('wasm:full', [], IPAD)).toEqual({ ok: true });
    expect(canEnable('remote:stockfish', ['wasm:lite'], IPAD)).toEqual({ ok: true });
    expect(canEnable('wasm:lite-single', ['wasm:lite'], DESKTOP)).toEqual({ ok: true });
  });

  it('the picker marks browser engines beyond the budget unavailable with the reason', () => {
    const probe = { status: 'idle' as const };
    const byKey = (env: typeof IPAD | typeof DESKTOP) =>
      Object.fromEntries(listEngines(probe, ['wasm:lite'], env).map((d) => [d.key, d]));
    const ipad = byKey(IPAD);
    expect(ipad['wasm:lite']!.available).toBe(true);
    expect(ipad['wasm:full']!.available).toBe(true); // replaces lite
    expect(ipad['wasm:lite-single']).toMatchObject({
      available: false,
      reason: 'Memory budget: one browser engine at a time on this device',
    });
    expect(byKey(DESKTOP)['wasm:lite-single']!.available).toBe(true);
  });
});

describe('WebAssembly support (wasmSupport.ts)', () => {
  const NO_SIMD: WasmSupport = {
    wasm: true,
    simd: false,
    threads: true,
    error: 'wasm-simd is not enabled',
  };
  const NO_THREADS: WasmSupport = { wasm: true, simd: true, threads: false };

  it('without SIMD every browser build is unavailable with the reason', () => {
    for (const env of [
      { ...ISOLATED, wasm: NO_SIMD },
      { ...PLAIN, wasm: NO_SIMD },
    ]) {
      const list = browserEngines(env);
      expect(list.map((d) => d.key)).toEqual(['wasm:lite', 'wasm:lite-single', 'wasm:full']);
      for (const d of list) expect(d).toMatchObject({ available: false, reason: NO_SIMD_REASON });
      expect(canEnable('wasm:lite-single', [], env)).toEqual({ ok: false, reason: NO_SIMD_REASON });
      expect(canEnable('wasm:lite', [], env)).toEqual({ ok: false, reason: NO_SIMD_REASON });
    }
    // Server engines are not affected.
    expect(canEnable('remote:stockfish', [], { ...ISOLATED, wasm: NO_SIMD })).toEqual({ ok: true });
  });

  it('without threads only the single-threaded build is offered', () => {
    const env = { ...ISOLATED, wasm: NO_THREADS };
    const byKey = new Map(browserEngines(env).map((d) => [d.key, d]));
    expect(byKey.get('wasm:lite')).toMatchObject({ available: false, reason: NO_THREADS_REASON });
    expect(byKey.get('wasm:full')).toMatchObject({ available: false, reason: NO_THREADS_REASON });
    expect(byKey.get('wasm:lite-single')).toMatchObject({ available: true });
    expect(canEnable('wasm:full', [], env)).toEqual({ ok: false, reason: NO_THREADS_REASON });
    expect(canEnable('wasm:lite-single', [], env)).toEqual({ ok: true });
    expect(defaultWasmKey(env)).toBe('wasm:lite-single');
  });

  it('wasmBuildUnsupportedReason: absent support info means supported', () => {
    expect(wasmBuildUnsupportedReason('lite', ISOLATED)).toBeUndefined();
    expect(wasmBuildUnsupportedReason('lite', { ...ISOLATED, wasm: NO_SIMD })).toBe(NO_SIMD_REASON);
    expect(wasmBuildUnsupportedReason('lite-single', { ...ISOLATED, wasm: NO_THREADS })).toBe(
      undefined,
    );
    expect(listEngines({ status: 'idle' }, [], { ...ISOLATED, wasm: NO_SIMD })[0]).toMatchObject({
      available: false,
      reason: NO_SIMD_REASON,
    });
  });
});
