import type { EngineInfo } from '@chesslab/engine-core';
import { describe, expect, it } from 'vitest';
import { WasmEngineClient, selectBuild, type EngineWorker } from './WasmEngineClient';
import { flush } from './testing';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Fake worker speaking just enough UCI. */
class FakeWorker implements EngineWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  readonly received: string[] = [];
  terminated = false;
  constructor(readonly url: string) {}

  postMessage(message: string): void {
    this.received.push(message);
    if (message === 'uci') queueMicrotask(() => this.out('id name Stockfish 19 Lite\nuciok'));
    if (message === 'isready') queueMicrotask(() => this.out('readyok'));
  }
  terminate(): void {
    this.terminated = true;
  }
  out(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function setup(opts: { isolated: boolean; cores?: number; build?: 'lite' | 'lite-single' }) {
  const workers: FakeWorker[] = [];
  const client = new WasmEngineClient({
    crossOriginIsolated: opts.isolated,
    hardwareConcurrency: opts.cores ?? 8,
    build: opts.build,
    engineBaseUrl: 'https://example.test/engine/',
    createWorker: (url) => {
      const w = new FakeWorker(url);
      workers.push(w);
      return w;
    },
  });
  return { client, workers };
}

describe('selectBuild', () => {
  it('uses lite-single without cross-origin isolation', () => {
    expect(selectBuild({ crossOriginIsolated: false, hardwareConcurrency: 16 })).toEqual({
      build: 'lite-single',
      threads: 1,
    });
  });
  it('uses the threaded lite build with min(cores - 1, 4) threads', () => {
    const threads = (n: number) => selectBuild({ crossOriginIsolated: true, hardwareConcurrency: n });
    expect(threads(16)).toEqual({ build: 'lite', threads: 4 });
    expect(threads(5)).toEqual({ build: 'lite', threads: 4 });
    expect(threads(4)).toEqual({ build: 'lite', threads: 3 });
    expect(threads(2)).toEqual({ build: 'lite', threads: 1 });
    expect(threads(1)).toEqual({ build: 'lite', threads: 1 });
    expect(threads(Number.NaN)).toEqual({ build: 'lite', threads: 1 });
  });
});

describe('WasmEngineClient', () => {
  it('falls back to the single-threaded build when not cross-origin isolated', async () => {
    const { client, workers } = setup({ isolated: false });
    expect(client.capabilities()).toEqual({
      threads: false,
      build: `stockfish-${__STOCKFISH_ENGINE__.version}-lite-single`,
      threadCount: 1,
    });
    await client.load();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.url).toBe(`https://example.test/engine/${__STOCKFISH_ENGINE__.builds['lite-single']}`);
    expect(workers[0]?.received).toEqual(['uci', 'isready']);
    expect(client.engineName).toBe('Stockfish 19 Lite');
  });

  it('loads the multi-threaded build and sets Threads when isolated', async () => {
    const { client, workers } = setup({ isolated: true, cores: 8 });
    expect(client.capabilities()).toMatchObject({ threads: true, threadCount: 4 });
    await client.load();
    expect(workers[0]?.url).toMatch(/stockfish-\d+-lite\.js$/);
    expect(workers[0]?.received).toEqual(['uci', 'isready', 'setoption name Threads value 4', 'isready']);
  });

  it('honours a forced lite-single build on an isolated page', async () => {
    const { client, workers } = setup({ isolated: true, build: 'lite-single' });
    await client.load();
    expect(client.capabilities().threads).toBe(false);
    expect(workers[0]?.received).toEqual(['uci', 'isready']);
  });

  it('load() is idempotent', async () => {
    const { client, workers } = setup({ isolated: false });
    await Promise.all([client.load(), client.load()]);
    await client.load();
    expect(workers).toHaveLength(1);
  });

  it('rejects load() with a clear message on worker error and allows a retry', async () => {
    const { client, workers } = setup({ isolated: false });
    const p = client.load();
    // Script/WASM load failure before the engine answers (the error event has an empty message).
    workers[0]!.onerror?.({ message: '', preventDefault() {} } as ErrorEvent);
    await expect(p).rejects.toThrow(/Stockfish worker error: failed to load https:\/\/example\.test/);
    expect(workers[0]?.terminated).toBe(true);
    await client.load();
    expect(workers).toHaveLength(2);
  });

  it('analyze before load fails through the iterator', async () => {
    const { client } = setup({ isolated: false });
    const it = client.analyze(START, { depth: 1 })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(/not loaded/);
  });

  it('runs an analysis right after load() and ignores non-string messages', async () => {
    const { client, workers } = setup({ isolated: true, cores: 4 });
    void client.load();
    const handle = client.analyze(START, { depth: 1 });
    const infos: EngineInfo[] = [];
    const done = (async () => {
      for await (const i of handle) infos.push(i);
    })();
    await flush(30);
    const w = workers[0]!;
    // Threads is set before the search starts.
    expect(w.received).toEqual([
      'uci',
      'isready',
      'setoption name Threads value 3',
      'isready',
      `position fen ${START}`,
      'go depth 1',
    ]);
    w.out({ percent: 1 });
    w.out('info depth 1 score cp 22 pv e2e4');
    w.out('bestmove e2e4');
    await done;
    expect(infos).toHaveLength(1);
  });

  it('a worker error during analysis ends the iterator with an error', async () => {
    const { client, workers } = setup({ isolated: false });
    await client.load();
    const it = client.analyze(START)[Symbol.asyncIterator]();
    await flush();
    workers[0]!.onerror?.({ message: 'RuntimeError: unreachable', preventDefault() {} } as ErrorEvent);
    await expect(it.next()).rejects.toThrow('Stockfish worker error: RuntimeError: unreachable');
  });

  it('dispose during analysis terminates the worker and completes the iterator', async () => {
    const { client, workers } = setup({ isolated: false });
    await client.load();
    const it = client.analyze(START)[Symbol.asyncIterator]();
    await flush();
    const pending = it.next();
    await client.dispose();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
    expect(workers[0]?.terminated).toBe(true);
    await expect(client.load()).rejects.toThrow(/disposed/);
    await expect(client.setOptions({ Hash: 1 })).rejects.toThrow(/disposed/);
  });

  it('stop() is safe before load and after dispose', async () => {
    const { client } = setup({ isolated: false });
    await client.stop();
    await client.load();
    await client.dispose();
    await client.stop();
  });
});
