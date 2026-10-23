// @vitest-environment jsdom
import type { EngineDescriptor as ServerEngine, EngineInfo } from '@chesslab/engine-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisEngine } from '../engine/AnalysisController';
import type { ProbeClient } from '../engine/registry';
import {
  classifyPosition,
  DEFAULT_SETTINGS,
  mergeLine,
  migratePersisted,
  newInstance,
  PROBE_ERROR_TTL_MS,
  PROBE_TTL_MS,
  sanitizeEngineKeys,
  sanitizeSettings,
  selectPrimary,
  startAnalysisController,
  STORAGE_KEY,
  useAnalysisStore,
  type AnalysisLine,
  type EngineInstanceState,
  type EngineSpec,
} from './analysisStore';
import { START_FEN, useGameStore } from './gameStore';

const info = (multipv: number, depth: number, cp = 10): EngineInfo => ({
  multipv,
  depth,
  score: { cp },
  pv: ['e2e4', 'e7e5'],
  nps: 1000,
});

const ISOLATED = { crossOriginIsolated: true, hardwareConcurrency: 8 };
const PLAIN = { crossOriginIsolated: false, hardwareConcurrency: 8 };
const SINGLE = 'wasm:lite-single';
const REMOTE = 'remote:stockfish';

describe('mergeLine', () => {
  it('inserts lines sorted by multipv and replaces them in place', () => {
    let lines: AnalysisLine[] = [];
    lines = mergeLine(lines, info(2, 5, -3), 3);
    lines = mergeLine(lines, info(1, 5, 12), 3);
    lines = mergeLine(lines, info(3, 5, -40), 3);
    expect(lines.map((l) => l.multipv)).toEqual([1, 2, 3]);
    const before = lines;
    lines = mergeLine(lines, info(2, 6, 7), 3);
    expect(lines).not.toBe(before);
    expect(lines.map((l) => [l.multipv, l.depth])).toEqual([
      [1, 5],
      [2, 6],
      [3, 5],
    ]);
    expect(lines[1]).toEqual({
      multipv: 2,
      depth: 6,
      score: { cp: 7 },
      pv: ['e2e4', 'e7e5'],
      nps: 1000,
    });
    expect(before[1]!.depth).toBe(5);
  });

  it('ignores infos beyond the MultiPV setting', () => {
    const lines = mergeLine([], info(2, 5), 1);
    expect(lines).toEqual([]);
  });
});

describe('sanitizeSettings', () => {
  it('clamps depth and multipv, keeps base values for missing fields', () => {
    expect(sanitizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ depth: 99, multipv: 9 })).toEqual({ depth: 40, multipv: 5 });
    expect(sanitizeSettings({ depth: -3, multipv: 0 })).toEqual({ depth: 0, multipv: 1 });
    expect(sanitizeSettings({ multipv: 3 }, { depth: 12, multipv: 1 })).toEqual({
      depth: 12,
      multipv: 3,
    });
    expect(sanitizeSettings({ threads: 2 })).toEqual({ ...DEFAULT_SETTINGS, threads: 2 });
    expect(sanitizeSettings({ threads: undefined }, { depth: 1, multipv: 1, threads: 4 })).toEqual({
      depth: 1,
      multipv: 1,
    });
    expect(sanitizeSettings({ remoteUrl: 'ws://127.0.0.1:1/ws' }).remoteUrl).toBe(
      'ws://127.0.0.1:1/ws',
    );
    expect(sanitizeSettings({ remoteUrl: 'http://evil' }).remoteUrl).toBeUndefined();
    expect(sanitizeSettings({ depth: Number.NaN })).toEqual(DEFAULT_SETTINGS);
    // The legacy `backend` field is dropped (it lives in `enabledEngines` now).
    expect(sanitizeSettings({ backend: 'remote' } as never)).toEqual(DEFAULT_SETTINGS);
  });
});

describe('sanitizeEngineKeys / migratePersisted', () => {
  it('keeps valid unique keys in order and falls back to the default browser engine', () => {
    expect(sanitizeEngineKeys([REMOTE, SINGLE, REMOTE, 'bogus', 7], ISOLATED)).toEqual([
      REMOTE,
      SINGLE,
    ]);
    expect(sanitizeEngineKeys([], ISOLATED)).toEqual(['wasm:lite']);
    expect(sanitizeEngineKeys(undefined, PLAIN)).toEqual([SINGLE]);
    // The multi-threaded build needs isolation.
    expect(sanitizeEngineKeys(['wasm:lite', SINGLE], PLAIN)).toEqual([SINGLE]);
    // At most two server engines.
    expect(sanitizeEngineKeys(['remote:a', 'remote:b', 'remote:c'], PLAIN)).toEqual([
      'remote:a',
      'remote:b',
    ]);
    expect(sanitizeEngineKeys(['remote:../x', 'remote:'], PLAIN)).toEqual([SINGLE]);
  });

  it('migrates the single-engine format (settings.backend)', () => {
    expect(
      migratePersisted(
        {
          enabled: true,
          settings: { depth: 12, multipv: 2, backend: 'remote', remoteUrl: 'ws://h/ws' },
        },
        ISOLATED,
      ),
    ).toEqual({
      enabled: true,
      enabledEngines: [REMOTE],
      settings: { depth: 12, multipv: 2, remoteUrl: 'ws://h/ws' },
    });
    expect(migratePersisted({ enabled: false, settings: { backend: 'wasm' } }, ISOLATED)).toEqual({
      enabled: false,
      enabledEngines: ['wasm:lite'],
      settings: DEFAULT_SETTINGS,
    });
    expect(migratePersisted({ settings: { depth: 10 } }, PLAIN).enabledEngines).toEqual([SINGLE]);
    // The new format wins over a stray legacy field.
    expect(
      migratePersisted({ enabledEngines: [SINGLE, REMOTE], settings: { backend: 'remote' } }, PLAIN)
        .enabledEngines,
    ).toEqual([SINGLE, REMOTE]);
    expect(migratePersisted('garbage', PLAIN)).toEqual({
      enabled: false,
      enabledEngines: [SINGLE],
      settings: DEFAULT_SETTINGS,
    });
  });
});

describe('classifyPosition', () => {
  it('detects checkmate and stalemate', () => {
    expect(classifyPosition(START_FEN)).toBeNull();
    expect(classifyPosition('R5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1')).toBe('checkmate');
    expect(classifyPosition('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).toBe('stalemate');
    expect(classifyPosition('garbage')).toBeNull();
  });
});

describe('selectPrimary', () => {
  it('returns the first enabled engine, or a stable idle placeholder', () => {
    const a = { ...newInstance(REMOTE), status: 'analysing' as const };
    const b = newInstance(SINGLE);
    expect(
      selectPrimary({ enabledEngines: [REMOTE, SINGLE], instances: { [REMOTE]: a, [SINGLE]: b } }),
    ).toBe(a);
    const none1 = selectPrimary({ enabledEngines: [], instances: {} });
    const none2 = selectPrimary({ enabledEngines: ['x'], instances: {} });
    expect(none1).toBe(none2);
    expect(none1.status).toBe('idle');
  });
});

/** Minimal engine whose searches are driven by the test. */
class ScriptedEngine implements AnalysisEngine {
  engineName = 'Stockfish Test';
  disposedCount = 0;
  readonly searches: { fen: string; emit: (i: EngineInfo) => void; end: () => void }[] = [];
  readonly options: Record<string, unknown>[] = [];
  capabilities() {
    return { threads: false, build: 'test', threadCount: 1 };
  }
  async load() {}
  async setOptions(o: Record<string, unknown>) {
    this.options.push(o);
  }
  async stop() {
    this.searches.at(-1)?.end();
  }
  async dispose() {
    this.disposedCount++;
    this.searches.at(-1)?.end();
  }
  analyze(fen: string) {
    this.searches.at(-1)?.end();
    const queue: EngineInfo[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    const search = {
      fen,
      emit: (i: EngineInfo) => {
        queue.push(i);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    };
    this.searches.push(search);
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (ended) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    };
  }
}

type StatusCb = (status: string, error?: string) => void;

/** Remote-like fake: a scripted engine with status events and limits. */
class FakeRemote extends ScriptedEngine {
  listeners = new Set<StatusCb>();
  loadError: (Error & { code?: string }) | null = null;
  limits = {
    maxDepth: 30,
    maxMultipv: 3,
    maxThreads: 4,
    maxHash: 256,
    maxMovetimeMs: 1000,
    maxSessionsPerConnection: 1,
  };
  onStatus(cb: StatusCb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  emit(status: string, error?: string) {
    for (const cb of [...this.listeners]) cb(status, error);
  }
  override async load() {
    this.emit('connecting');
    if (this.loadError) {
      this.emit('error', this.loadError.message);
      throw this.loadError;
    }
    this.emit('ready');
  }
  override async dispose() {
    await super.dispose();
    this.emit('closed');
  }
}

/** Probe client fake: counts connections, answers with `engines` or fails with `error`. */
class FakeProbe implements ProbeClient {
  static created = 0;
  static disposed = 0;
  static engines: ServerEngine[] = [
    { id: 'stockfish', name: 'Stockfish 19', enabled: true, defaults: { threads: 4, hash: 256 } },
  ];
  static error: (Error & { code?: string }) | null = null;
  engines: ServerEngine[] = [];
  constructor() {
    FakeProbe.created++;
  }
  async load() {
    if (FakeProbe.error) throw FakeProbe.error;
    this.engines = FakeProbe.engines;
  }
  async dispose() {
    FakeProbe.disposed++;
  }
}

const storage = new Map<string, string>();

function resetStores(enabledEngines: string[] = [SINGLE]) {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  useGameStore.getState().reset();
  useAnalysisStore.setState({
    enabled: false,
    enabledEngines,
    instances: Object.fromEntries(enabledEngines.map((k) => [k, newInstance(k)])),
    settings: { ...DEFAULT_SETTINGS },
    serverProbe: { status: 'idle' },
    engineHint: undefined,
  });
  FakeProbe.created = 0;
  FakeProbe.disposed = 0;
  FakeProbe.error = null;
}

const inst = (key: string): EngineInstanceState | undefined =>
  useAnalysisStore.getState().instances[key];
const primary = () => selectPrimary(useAnalysisStore.getState());
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('analysis store + controller', () => {
  let stop: () => void = () => undefined;
  let engine: ScriptedEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
    engine = new ScriptedEngine();
    stop = startAnalysisController({
      createEngine: () => engine,
      createProbeClient: () => new FakeProbe(),
      debounceMs: 80,
    });
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('follows the game position, merges lines and resets them on a move', async () => {
    const a = useAnalysisStore.getState();
    expect(a.fen).toBe(START_FEN);
    a.setEnabled(true);
    expect(JSON.parse(storage.get(STORAGE_KEY)!)).toEqual({
      enabled: true,
      enabledEngines: [SINGLE],
      settings: DEFAULT_SETTINGS,
    });
    await settle();
    expect(primary()).toMatchObject({
      key: SINGLE,
      status: 'analysing',
      engineName: 'Stockfish Test',
      capabilities: { threadCount: 1 },
    });
    engine.searches[0]!.emit(info(1, 3, 25));
    engine.searches[0]!.emit(info(1, 4, 30));
    await settle();
    expect(primary().lines).toEqual([
      { multipv: 1, depth: 4, score: { cp: 30 }, pv: ['e2e4', 'e7e5'], nps: 1000 },
    ]);

    useGameStore.getState().makeMove('e2', 'e4');
    const fenAfter = useGameStore.getState().moves[0]!.fen;
    expect(useAnalysisStore.getState().fen).toBe(fenAfter);
    expect(primary().lines).toEqual([]);
    engine.searches[0]!.emit(info(1, 5, 99)); // stale
    await vi.advanceTimersByTimeAsync(80);
    expect(primary().lines).toEqual([]);
    expect(engine.searches.at(-1)!.fen).toBe(fenAfter);
  });

  it('marks terminal positions and does not search them', async () => {
    useAnalysisStore.getState().setEnabled(true);
    await settle();
    useGameStore.getState().loadFen('R5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1');
    await vi.advanceTimersByTimeAsync(100);
    expect(useAnalysisStore.getState().terminal).toBe('checkmate');
    expect(primary()).toMatchObject({ lines: [], status: 'ready' });
    expect(engine.searches).toHaveLength(1);
  });

  it('persists settings and applies MultiPV', async () => {
    useAnalysisStore.getState().setEnabled(true);
    await settle();
    useAnalysisStore.getState().setSettings({ multipv: 3, depth: 50 });
    expect(useAnalysisStore.getState().settings).toEqual({ depth: 40, multipv: 3 });
    expect(JSON.parse(storage.get(STORAGE_KEY)!).settings).toEqual({ depth: 40, multipv: 3 });
    await settle();
    expect(engine.options).toEqual([{ MultiPV: 3 }]);
    engine.searches.at(-1)!.emit(info(3, 2));
    engine.searches.at(-1)!.emit(info(1, 2));
    await settle();
    expect(primary().lines.map((l) => l.multipv)).toEqual([1, 3]);
  });
});

describe('multi-engine instances', () => {
  let stop: () => void = () => undefined;
  let created: { key: string; engine: ScriptedEngine }[];

  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
    created = [];
    stop = startAnalysisController({
      debounceMs: 80,
      createProbeClient: () => new FakeProbe(),
      createEngine: (spec: EngineSpec) => {
        const e = spec.backend === 'remote' ? new FakeRemote() : new ScriptedEngine();
        created.push({ key: spec.key, engine: e });
        return e;
      },
    });
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const engineOf = (key: string) => created.filter((c) => c.key === key).at(-1)!.engine;

  it('runs one controller per enabled engine on the same position, each with its own lines', async () => {
    const s = useAnalysisStore.getState();
    s.setEnabled(true);
    await settle();
    expect(s.setEngineEnabled(REMOTE, true)).toBe(true);
    await settle();
    expect(created.map((c) => c.key)).toEqual([SINGLE, REMOTE]);
    expect(useAnalysisStore.getState().enabledEngines).toEqual([SINGLE, REMOTE]);
    expect(JSON.parse(storage.get(STORAGE_KEY)!).enabledEngines).toEqual([SINGLE, REMOTE]);
    expect(inst(SINGLE)!.status).toBe('analysing');
    expect(inst(REMOTE)).toMatchObject({ status: 'analysing', backendStatus: 'ready' });

    engineOf(SINGLE)
      .searches.at(-1)!
      .emit(info(1, 10, 20));
    engineOf(REMOTE)
      .searches.at(-1)!
      .emit(info(1, 25, 31));
    await settle();
    expect(inst(SINGLE)!.lines[0]).toMatchObject({ depth: 10, score: { cp: 20 } });
    expect(inst(REMOTE)!.lines[0]).toMatchObject({ depth: 25, score: { cp: 31 } });
    expect(primary().key).toBe(SINGLE);

    // Both follow a move.
    useGameStore.getState().makeMove('e2', 'e4');
    await vi.advanceTimersByTimeAsync(80);
    const fen = useGameStore.getState().moves[0]!.fen;
    expect(engineOf(SINGLE).searches.at(-1)!.fen).toBe(fen);
    expect(engineOf(REMOTE).searches.at(-1)!.fen).toBe(fen);
    expect(inst(SINGLE)!.lines).toEqual([]);
    expect(inst(REMOTE)!.lines).toEqual([]);
  });

  it('disabling an engine disposes it, drops its state and ignores its late events', async () => {
    const s = useAnalysisStore.getState();
    s.setEnabled(true);
    s.setEngineEnabled(REMOTE, true);
    await settle();
    const remote = engineOf(REMOTE) as FakeRemote;
    const local = engineOf(SINGLE);

    expect(s.setEngineEnabled(SINGLE, false)).toBe(true);
    await settle();
    expect(local.disposedCount).toBe(1);
    expect(remote.disposedCount).toBe(0);
    expect(inst(SINGLE)).toBeUndefined();
    expect(useAnalysisStore.getState().enabledEngines).toEqual([REMOTE]);
    // The remaining engine becomes the primary one.
    expect(primary().key).toBe(REMOTE);
    local.searches.at(-1)!.emit(info(1, 30, 500)); // late info of the disposed engine
    await settle();
    expect(inst(SINGLE)).toBeUndefined();

    // Re-enabling creates a fresh engine.
    s.setEngineEnabled(SINGLE, true);
    await settle();
    expect(created.filter((c) => c.key === SINGLE)).toHaveLength(2);
    expect(inst(SINGLE)!.status).toBe('analysing');
    expect(useAnalysisStore.getState().enabledEngines).toEqual([REMOTE, SINGLE]);
  });

  it('the master switch stops and resumes all engines', async () => {
    const s = useAnalysisStore.getState();
    s.setEngineEnabled(REMOTE, true);
    await settle();
    expect(created).toHaveLength(0); // nothing loads while off
    s.setEnabled(true);
    await settle();
    expect(created.map((c) => c.key)).toEqual([SINGLE, REMOTE]);
    s.setEnabled(false);
    await settle();
    expect(inst(SINGLE)!.status).toBe('idle');
    expect(inst(REMOTE)!.status).toBe('idle');
    s.setEnabled(true);
    await settle();
    expect(inst(SINGLE)!.status).toBe('analysing');
    expect(inst(REMOTE)!.status).toBe('analysing');
    expect(created).toHaveLength(2); // engines stay loaded across the switch
  });

  it('keeps at least one engine and enforces the resource guard', async () => {
    const s = useAnalysisStore.getState();
    expect(s.setEngineEnabled(SINGLE, false)).toBe(false);
    expect(useAnalysisStore.getState().enabledEngines).toEqual([SINGLE]);
    expect(useAnalysisStore.getState().engineHint).toMatch(/At least one engine/);

    // Not cross-origin isolated (jsdom): the multi-threaded build is refused.
    expect(s.setEngineEnabled('wasm:lite', true)).toBe(false);
    expect(useAnalysisStore.getState().engineHint).toMatch(/cross-origin isolated/);

    expect(s.setEngineEnabled('remote:a', true)).toBe(true);
    expect(s.setEngineEnabled('remote:b', true)).toBe(true);
    expect(useAnalysisStore.getState().engineHint).toBeUndefined();
    expect(s.setEngineEnabled('remote:c', true)).toBe(false);
    expect(useAnalysisStore.getState().engineHint).toMatch(/At most 2 server engines/);
    expect(useAnalysisStore.getState().enabledEngines).toEqual([SINGLE, 'remote:a', 'remote:b']);

    expect(s.setEngineEnabled('nonsense', true)).toBe(false);
    s.clearEngineHint();
    expect(useAnalysisStore.getState().engineHint).toBeUndefined();
  });

  it('fallBackToBrowser replaces the server engines', async () => {
    const s = useAnalysisStore.getState();
    s.setEnabled(true);
    s.setEngineEnabled(REMOTE, true);
    s.setEngineEnabled(SINGLE, false);
    await settle();
    expect(useAnalysisStore.getState().enabledEngines).toEqual([REMOTE]);
    s.fallBackToBrowser();
    await settle();
    expect(useAnalysisStore.getState().enabledEngines).toEqual([SINGLE]);
    expect((engineOf(REMOTE) as FakeRemote).disposedCount).toBe(1);
    expect(inst(SINGLE)!.status).toBe('analysing');
  });

  it('stopping the controller disposes every engine', async () => {
    const s = useAnalysisStore.getState();
    s.setEnabled(true);
    s.setEngineEnabled(REMOTE, true);
    await settle();
    stop();
    await settle();
    expect(created.map((c) => c.engine.disposedCount)).toEqual([1, 1]);
    stop = () => undefined;
  });
});

describe('server probe', () => {
  let stop: () => void = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    resetStores();
    stop = startAnalysisController({
      createEngine: () => new ScriptedEngine(),
      createProbeClient: () => new FakeProbe(),
    });
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('caches a successful probe and re-probes after the TTL or when forced', async () => {
    const p = useAnalysisStore.getState().probeServer();
    expect(useAnalysisStore.getState().serverProbe.status).toBe('probing');
    // Concurrent calls share the running probe.
    void useAnalysisStore.getState().probeServer();
    await p;
    expect(FakeProbe.created).toBe(1);
    expect(FakeProbe.disposed).toBe(1);
    expect(useAnalysisStore.getState().serverProbe).toMatchObject({
      status: 'ok',
      engines: [{ id: 'stockfish', name: 'Stockfish 19' }],
    });
    expect(useAnalysisStore.getState().serverProbe.lastProbe).toBeTypeOf('number');

    await useAnalysisStore.getState().probeServer();
    expect(FakeProbe.created).toBe(1);
    await useAnalysisStore.getState().probeServer({ force: true });
    expect(FakeProbe.created).toBe(2);
    vi.setSystemTime(Date.now() + PROBE_TTL_MS + 1);
    await useAnalysisStore.getState().probeServer();
    expect(FakeProbe.created).toBe(3);
  });

  it('records errors and retries them after a short delay', async () => {
    FakeProbe.error = Object.assign(new Error('socket closed'), { code: 'closed' });
    await useAnalysisStore.getState().probeServer();
    expect(useAnalysisStore.getState().serverProbe).toMatchObject({
      status: 'error',
      error: 'Server unreachable',
    });
    expect(FakeProbe.disposed).toBe(1);
    await useAnalysisStore.getState().probeServer();
    expect(FakeProbe.created).toBe(1);
    FakeProbe.error = null;
    vi.setSystemTime(Date.now() + PROBE_ERROR_TTL_MS + 1);
    await useAnalysisStore.getState().probeServer();
    expect(useAnalysisStore.getState().serverProbe.status).toBe('ok');
  });

  it('a server URL change invalidates the cache and drops an outdated answer', async () => {
    await useAnalysisStore.getState().probeServer();
    useAnalysisStore.getState().setSettings({ remoteUrl: 'ws://other:1/ws' });
    expect(useAnalysisStore.getState().serverProbe).toEqual({ status: 'idle' });
    const p = useAnalysisStore.getState().probeServer();
    useAnalysisStore.getState().setSettings({ remoteUrl: 'ws://third:1/ws' });
    await p;
    expect(useAnalysisStore.getState().serverProbe).toEqual({ status: 'idle' });
  });

  it('enabling a server engine probes the server', async () => {
    useAnalysisStore.getState().setEngineEnabled(REMOTE, true);
    await settle();
    expect(FakeProbe.created).toBe(1);
    expect(useAnalysisStore.getState().serverProbe.status).toBe('ok');
  });
});

describe('server engines: status, errors and reconnect', () => {
  let stop: () => void = () => undefined;
  let remotes: FakeRemote[];
  let nextLoadError: (Error & { code?: string }) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    resetStores([REMOTE]);
    remotes = [];
    nextLoadError = null;
    stop = startAnalysisController({
      debounceMs: 80,
      createProbeClient: () => new FakeProbe(),
      createEngine: (spec) => {
        if (spec.backend !== 'remote') return new ScriptedEngine();
        const r = new FakeRemote();
        r.loadError = nextLoadError;
        remotes.push(r);
        return r;
      },
    });
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('mirrors connection status and limits; the engine id comes from the key', async () => {
    useAnalysisStore.getState().setEnabled(true);
    await settle();
    expect(primary()).toMatchObject({
      key: REMOTE,
      status: 'analysing',
      backendStatus: 'ready',
      remoteLimits: { maxDepth: 30, maxMultipv: 3 },
    });
  });

  it('maps load failures to friendly errors and does not reconnect initially', async () => {
    nextLoadError = Object.assign(new Error('Cannot connect'), { code: 'closed' });
    useAnalysisStore.getState().setEnabled(true);
    await settle();
    expect(primary()).toMatchObject({
      status: 'error',
      backendStatus: 'error',
      backendError: 'Server unreachable',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(remotes).toHaveLength(1);
  });

  it('maps no_capacity to "Server busy, try again"', async () => {
    nextLoadError = Object.assign(new Error('full'), { code: 'no_capacity' });
    useAnalysisStore.getState().setEnabled(true);
    await settle();
    expect(primary().backendError).toBe('Server busy, try again');
  });

  it('reconnects with 1 s, 2 s, 4 s backoff after losing the session, then gives up', async () => {
    useAnalysisStore.getState().setEnabled(true);
    await settle();
    expect(remotes).toHaveLength(1);

    // Connection drops; every further server attempt fails.
    nextLoadError = Object.assign(new Error('nope'), { code: 'closed' });
    remotes[0]!.emit('closed', 'Connection to engine server closed');
    expect(primary().backendStatus).toBe('closed');
    await vi.advanceTimersByTimeAsync(999);
    expect(remotes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(remotes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(remotes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(remotes).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(remotes).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(remotes).toHaveLength(4);
    expect(primary()).toMatchObject({ status: 'error', backendError: 'Connection lost' });
  });

  it('a successful reconnect resumes analysis and resets the attempt counter', async () => {
    useAnalysisStore.getState().setEnabled(true);
    await settle();
    remotes[0]!.emit('closed', 'lost');
    await vi.advanceTimersByTimeAsync(1000);
    expect(remotes).toHaveLength(2);
    expect(primary()).toMatchObject({
      status: 'analysing',
      backendStatus: 'ready',
      backendError: undefined,
    });
    // A later loss starts again at 1 s.
    remotes[1]!.emit('closed', 'lost again');
    await vi.advanceTimersByTimeAsync(1000);
    expect(remotes).toHaveLength(3);
  });

  it('does not reconnect when switched off or when the server engine was removed', async () => {
    useAnalysisStore.getState().setEnabled(true);
    await settle();
    remotes[0]!.emit('closed', 'lost');
    useAnalysisStore.getState().setEnabled(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(remotes).toHaveLength(1);

    useAnalysisStore.getState().setEnabled(true);
    await settle();
    remotes[0]!.emit('ready');
    remotes[0]!.emit('closed', 'lost');
    useAnalysisStore.getState().fallBackToBrowser();
    expect(remotes[0]!.disposedCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(remotes).toHaveLength(1);
  });

  it('a server URL change recreates the server engines', async () => {
    useAnalysisStore.getState().setEnabled(true);
    await settle();
    useAnalysisStore.getState().setSettings({ remoteUrl: 'ws://127.0.0.1:9/ws' });
    await settle();
    expect(remotes).toHaveLength(2);
    expect(remotes[0]!.disposedCount).toBe(1);
    expect(primary()).toMatchObject({ status: 'analysing', backendStatus: 'ready' });
  });
});
