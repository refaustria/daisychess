import { describe, expect, it, vi } from 'vitest';
import type { BestMove } from '@daisychess/engine-core';
import { runSmoke, SMOKE_MARKER, type SmokeEngine } from './smoke';

function fakeEngine(best: BestMove | null, opts: { loadError?: Error; hang?: boolean } = {}) {
  const dispose = vi.fn(async () => undefined);
  const engine: SmokeEngine = {
    load: () =>
      opts.loadError
        ? Promise.reject(opts.loadError)
        : opts.hang
          ? new Promise<void>(() => undefined)
          : Promise.resolve(),
    analyze: () => ({
      async *[Symbol.asyncIterator]() {
        yield { depth: 1 };
      },
      bestMove: Promise.resolve(best),
    }),
    dispose,
  };
  return { engine, dispose };
}

function parse(line: string) {
  expect(line.startsWith(`${SMOKE_MARKER} `)).toBe(true);
  return JSON.parse(line.slice(SMOKE_MARKER.length + 1)) as Record<string, unknown>;
}

describe('runSmoke', () => {
  it('logs one marker line with the context flags and the bestmove, then disposes', async () => {
    const { engine, dispose } = fakeEngine({ move: 'e2e4' });
    const lines: string[] = [];
    const r = await runSmoke({ createEngine: async () => engine, log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    const logged = parse(lines[0] ?? '');
    expect(logged).toMatchObject({
      engine: 'wasm:lite-single',
      bestmove: 'e2e4',
      platform: 'web',
      crossOriginIsolated: false,
    });
    expect(logged.error).toBeUndefined();
    expect(typeof logged.isSecureContext).toBe('boolean');
    expect(r.bestmove).toBe('e2e4');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports a load failure instead of throwing', async () => {
    const { engine, dispose } = fakeEngine(null, { loadError: new Error('wasm blocked') });
    const lines: string[] = [];
    const r = await runSmoke({ createEngine: async () => engine, log: (l) => lines.push(l) });
    expect(r.bestmove).toBeNull();
    expect(parse(lines[0] ?? '').error).toBe('wasm blocked');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports a missing bestmove', async () => {
    const { engine } = fakeEngine(null);
    const r = await runSmoke({ createEngine: async () => engine, log: () => undefined });
    expect(r.error).toBe('engine returned no bestmove');
  });

  it('times out a hanging engine and still logs', async () => {
    const { engine, dispose } = fakeEngine(null, { hang: true });
    const lines: string[] = [];
    const r = await runSmoke({
      createEngine: async () => engine,
      log: (l) => lines.push(l),
      timeoutMs: 20,
    });
    expect(r.error).toMatch(/timed out/);
    expect(lines).toHaveLength(1);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
