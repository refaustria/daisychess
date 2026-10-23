import type { EngineDescriptor as ServerEngine } from '@chesslab/engine-core';
import { describe, expect, it } from 'vitest';
import {
  browserEngines,
  canEnable,
  defaultWasmKey,
  describeEngine,
  listEngines,
  NOT_ISOLATED_REASON,
  parseEngineKey,
  probeServer,
  serverEngines,
  shortEngineName,
  type ProbeClient,
} from './registry';

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
    expect(parseEngineKey('remote:stockfish')).toEqual({
      backend: 'remote',
      engineId: 'stockfish',
    });
    for (const bad of ['wasm:full', 'remote:', 'remote:../x', 'remote:a b', 'x', 3, null]) {
      expect(parseEngineKey(bad)).toBeNull();
    }
  });
});

describe('browser engines', () => {
  it('offers the multi-threaded build only on cross-origin isolated pages', () => {
    const [lite, single] = browserEngines(PLAIN);
    expect(lite).toMatchObject({ key: 'wasm:lite', available: false, reason: NOT_ISOLATED_REASON });
    expect(single).toMatchObject({ key: 'wasm:lite-single', available: true, badge: 'browser' });
    expect(single!.reason).toBeUndefined();

    const iso = browserEngines(ISOLATED);
    expect(iso.every((d) => d.available)).toBe(true);
    expect(iso[0]!.name).toMatch(/^Stockfish \d+ \(browser, 4 threads\)$/);
    expect(iso[1]!.name).toMatch(/^Stockfish \d+ \(browser, 1 thread\)$/);
    expect(iso[1]!.badge).toBe('browser 1T');
    expect(browserEngines({ crossOriginIsolated: true, hardwareConcurrency: 2 })[0]!.name).toMatch(
      /1 thread\)$/,
    );
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
