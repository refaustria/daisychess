import type { EngineInfo } from '@chesslab/engine-core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  engineScriptUrl,
  WasmEngineClient,
  selectBuild,
  type EngineWorker,
  type WasmBuild,
} from './WasmEngineClient';
import { flush } from './testing';
import {
  allowWasmRetry,
  degradedNotice,
  resetWasmHealth,
  wasmHealth,
  WasmEngineError,
} from './wasmHealth';

beforeEach(() => resetWasmHealth());

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

function setup(opts: {
  isolated: boolean;
  cores?: number;
  build?: WasmBuild;
  maxThreads?: number;
  /** Called for every new worker (e.g. to make it fail). */
  onWorker?: (w: FakeWorker, index: number) => void;
}) {
  const workers: FakeWorker[] = [];
  const client = new WasmEngineClient({
    crossOriginIsolated: opts.isolated,
    hardwareConcurrency: opts.cores ?? 8,
    build: opts.build,
    ...(opts.maxThreads !== undefined ? { maxThreads: opts.maxThreads } : {}),
    engineBaseUrl: 'https://example.test/engine/',
    createWorker: (url) => {
      const w = new FakeWorker(url);
      workers.push(w);
      opts.onWorker?.(w, workers.length - 1);
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
    const threads = (n: number) =>
      selectBuild({ crossOriginIsolated: true, hardwareConcurrency: n });
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
    expect(workers[0]?.url).toBe(
      `https://example.test/engine/${__STOCKFISH_ENGINE__.builds['lite-single']}`,
    );
    expect(workers[0]?.received).toEqual(['uci', 'isready']);
    expect(client.engineName).toBe('Stockfish 19 Lite');
  });

  it('loads the multi-threaded build and sets Threads when isolated', async () => {
    const { client, workers } = setup({ isolated: true, cores: 8 });
    expect(client.capabilities()).toMatchObject({ threads: true, threadCount: 4 });
    await client.load();
    expect(workers[0]?.url).toMatch(/stockfish-\d+-lite\.js$/);
    expect(workers[0]?.received).toEqual([
      'uci',
      'isready',
      'setoption name Threads value 4',
      'isready',
    ]);
  });

  it('honours a forced lite-single build on an isolated page', async () => {
    const { client, workers } = setup({ isolated: true, build: 'lite-single' });
    await client.load();
    expect(client.capabilities().threads).toBe(false);
    expect(workers[0]?.received).toEqual(['uci', 'isready']);
  });

  it('loads the full build (multi-threaded, big network) when forced on an isolated page', async () => {
    const { client, workers } = setup({ isolated: true, cores: 4, build: 'full' });
    expect(client.capabilities()).toEqual({
      threads: true,
      build: `stockfish-${__STOCKFISH_ENGINE__.version}-full`,
      threadCount: 3,
    });
    await client.load();
    expect(workers[0]?.url).toBe(`https://example.test/engine/${__STOCKFISH_ENGINE__.builds.full}`);
    expect(workers[0]?.url).toMatch(/stockfish-\d+\.js$/);
    expect(workers[0]?.received).toEqual([
      'uci',
      'isready',
      'setoption name Threads value 3',
      'isready',
    ]);
  });

  it('load() is idempotent', async () => {
    const { client, workers } = setup({ isolated: false });
    await Promise.all([client.load(), client.load()]);
    await client.load();
    expect(workers).toHaveLength(1);
  });

  it('rejects load() with a clear message when the degraded retry fails too; explicit retry allowed', async () => {
    const { client, workers } = setup({ isolated: false });
    const p = client.load();
    // Script/WASM load failure before the engine answers (the error event has an empty message).
    workers[0]!.onerror?.({ message: '', preventDefault() {} } as ErrorEvent);
    await flush();
    expect(workers).toHaveLength(2);
    workers[1]!.onerror?.({ message: '', preventDefault() {} } as ErrorEvent);
    await expect(p).rejects.toThrow(
      /Stockfish worker error: failed to load https:\/\/example\.test/,
    );
    expect(workers.every((w) => w.terminated)).toBe(true);
    expect(wasmHealth().disabled).toMatch(/failed to load/);
    // Disabled: no automatic attempt spawns a worker…
    await expect(client.load()).rejects.toThrow(/failed to load/);
    expect(workers).toHaveLength(2);
    // …until the user retries explicitly.
    allowWasmRetry();
    await client.load();
    expect(workers).toHaveLength(3);
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
    workers[0]!.onerror?.({
      message: 'RuntimeError: unreachable',
      preventDefault() {},
    } as ErrorEvent);
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

const OOM = { message: 'RangeError: Out of memory', filename: 'stockfish-19-lite.js', lineno: 12 };
const fireError = (w: FakeWorker, e: Partial<ErrorEvent> = OOM) =>
  w.onerror?.({ preventDefault() {}, ...e } as ErrorEvent);

describe('WasmEngineClient out-of-memory recovery (ADR-015)', () => {
  it('first load runs out of memory → retried once single-threaded → success, one notice', async () => {
    const { client, workers } = setup({
      isolated: true,
      cores: 8,
      onWorker: (w, i) => {
        if (i === 0) queueMicrotask(() => fireError(w));
      },
    });
    await client.load();
    expect(workers).toHaveLength(2);
    expect(workers[0]!.url).toMatch(/lite\.js$/);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[1]!.url).toMatch(/lite-single\.js$/);
    expect(workers[1]!.received).toEqual(['uci', 'isready']);
    expect(client.capabilities()).toMatchObject({ threads: false, threadCount: 1 });
    expect(wasmHealth()).toMatchObject({
      degraded: true,
      notice: degradedNotice('oom'),
      live: 1,
      created: 2,
    });
    expect(degradedNotice('oom')).toBe(
      'Browser engine restarted with 1 thread after running out of memory',
    );
  });

  it('both attempts run out of memory → disabled, no notice, later instances refuse at once', async () => {
    const { client, workers } = setup({
      isolated: true,
      onWorker: (w) => queueMicrotask(() => fireError(w)),
    });
    const err = await client.load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WasmEngineError);
    expect(err).toMatchObject({ kind: 'oom', retryable: false });
    expect((err as Error).message).toMatch(/Out of memory \(stockfish-19-lite\.js:12\)/);
    expect(workers).toHaveLength(2);
    expect(wasmHealth()).toMatchObject({ degraded: true, notice: undefined, live: 0 });
    expect(wasmHealth().disabled).toMatch(/Out of memory/);
    const other = setup({ isolated: true });
    await expect(other.client.load()).rejects.toMatchObject({ retryable: false });
    expect(other.workers).toHaveLength(0);
  });

  it('after a degradation new instances start with the single-threaded build', async () => {
    const first = setup({
      isolated: true,
      onWorker: (w, i) => {
        if (i === 0) queueMicrotask(() => fireError(w));
      },
    });
    await first.client.load();
    const second = setup({ isolated: true, build: 'full' });
    expect(second.client.capabilities()).toMatchObject({ threads: false, threadCount: 1 });
    await second.client.load();
    expect(second.workers).toHaveLength(1);
    expect(second.workers[0]!.url).toMatch(/lite-single\.js$/);
  });

  it('out of memory during a search: retryable error, a degraded instance failing again disables', async () => {
    const { client, workers } = setup({ isolated: true });
    await client.load();
    const it1 = client.analyze(START)[Symbol.asyncIterator]();
    await flush(20);
    fireError(workers[0]!);
    const err = await it1.next().catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'oom', retryable: true });
    expect(wasmHealth()).toMatchObject({ degraded: true, notice: degradedNotice('oom') });

    const again = setup({ isolated: true });
    await again.client.load();
    const it2 = again.client.analyze(START)[Symbol.asyncIterator]();
    await flush(20);
    fireError(again.workers[0]!, { message: 'RuntimeError: unreachable' });
    await expect(it2.next()).rejects.toMatchObject({ kind: 'worker', retryable: false });
    expect(wasmHealth().disabled).toMatch(/unreachable/);
  });

  it('a timeout is not a worker failure: no degradation', async () => {
    const { client, workers } = setup({ isolated: false });
    const c = new WasmEngineClient({
      crossOriginIsolated: false,
      engineBaseUrl: 'https://example.test/engine/',
      handshakeTimeoutMs: 5,
      createWorker: (url) => {
        const w = new FakeWorker(url);
        w.postMessage = () => undefined; // never answers
        workers.push(w);
        return w;
      },
    });
    await expect(c.load()).rejects.toThrow(/uciok/);
    expect(wasmHealth().degraded).toBe(false);
    await client.dispose();
  });

  it('caps Threads by maxThreads (memory budget) at load and in setOptions', async () => {
    const { client, workers } = setup({ isolated: true, cores: 8, maxThreads: 2 });
    expect(client.capabilities().threadCount).toBe(2);
    await client.load();
    await client.setOptions({ Threads: 7, Hash: 16 });
    expect(workers[0]!.received).toEqual([
      'uci',
      'isready',
      'setoption name Threads value 2',
      'isready',
      'setoption name Threads value 2',
      'setoption name Hash value 16',
      'isready',
    ]);
    expect(client.capabilities().threadCount).toBe(2);
  });

  it('counts live instances (worker groups)', async () => {
    const a = setup({ isolated: false });
    const b = setup({ isolated: false });
    await a.client.load();
    await b.client.load();
    expect(wasmHealth()).toMatchObject({ live: 2, peak: 2, created: 2 });
    await a.client.dispose();
    await b.client.dispose();
    expect(wasmHealth()).toMatchObject({ live: 0, peak: 2 });
  });
});

describe('memory cap through the worker shim (ADR-015)', () => {
  it('engineScriptUrl: the build itself, or the shim for a capped multi-threaded build', () => {
    const base = 'https://example.test/engine/';
    const lite = __STOCKFISH_ENGINE__.builds.lite;
    expect(engineScriptUrl(base, 'lite')).toBe(`${base}${lite}`);
    expect(engineScriptUrl(base, 'lite-single', 8192)).toBe(
      `${base}${__STOCKFISH_ENGINE__.builds['lite-single']}`,
    );
    const url = new URL(engineScriptUrl(base, 'lite', 8192));
    expect(url.pathname).toBe(`/engine/${__STOCKFISH_ENGINE__.memoryShim}`);
    expect(url.searchParams.get('engine')).toBe(lite);
    expect(url.searchParams.get('maxPages')).toBe('8192');
    // The engine reads `hash.substr(1).split(',')[0]` as its .wasm URL.
    expect(decodeURIComponent(url.hash.slice(1).split(',')[0]!)).toBe(
      `${base}${lite.replace(/\.js$/, '.wasm')}`,
    );
  });

  it('a client with maxMemoryPages starts the multi-threaded build through the shim', async () => {
    const urls: string[] = [];
    const client = new WasmEngineClient({
      crossOriginIsolated: true,
      hardwareConcurrency: 8,
      maxMemoryPages: 8192,
      engineBaseUrl: 'https://example.test/engine/',
      createWorker: (url) => {
        urls.push(url);
        return new FakeWorker(url);
      },
    });
    await client.load();
    expect(urls[0]).toContain(`${__STOCKFISH_ENGINE__.memoryShim}?engine=`);
    await client.dispose();
  });
});
