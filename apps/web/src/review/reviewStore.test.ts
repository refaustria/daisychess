import { DEFAULT_LIMITS } from '@daisychess/engine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { FakeReviewEngine } from './fakeEngine';
import { clearReviewCache, configureReviewCache } from './reviewCache';
import {
  REVIEW_PRESETS,
  disposeReviewEngine,
  fallbackNotice,
  gameToBatch,
  serverFailureReason,
  setReviewEngineFactory,
  useReviewStore,
} from './reviewStore';
import { remoteError } from './serverReviewEngine';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

let engine: FakeReviewEngine;
let created = 0;

beforeEach(async () => {
  configureReviewCache(null);
  await clearReviewCache();
  engine = new FakeReviewEngine();
  created = 0;
  setReviewEngineFactory(() => {
    created++;
    return engine;
  });
  useReviewStore.getState().reset();
  useGameStore.getState().loadPgn(SCHOLAR);
  useAnalysisStore.getState().setEnabled(true);
});

afterEach(async () => {
  useReviewStore.getState().reset();
  await disposeReviewEngine();
  useAnalysisStore.getState().setEnabled(false);
});

describe('reviewStore', () => {
  it('converts the game store to analyzer input', () => {
    const g = gameToBatch(useGameStore.getState());
    expect(g.moves.map((m) => m.uci)).toEqual([
      'e2e4',
      'e7e5',
      'f1c4',
      'b8c6',
      'd1h5',
      'g8f6',
      'h5f7',
    ]);
    expect(g.moves[6]!.fenAfter).toBe(useGameStore.getState().moves[6]!.fen);
  });

  it('runs: idle → running → done, disables live analysis meanwhile and restores it', async () => {
    engine.delayMs = 2;
    const statuses: string[] = [];
    const enabledDuringRun: boolean[] = [];
    const unsub = useReviewStore.subscribe((s) => {
      statuses.push(s.status);
      if (s.status === 'running') enabledDuringRun.push(useAnalysisStore.getState().enabled);
    });
    expect(useReviewStore.getState().status).toBe('idle');
    const p = useReviewStore.getState().start({ movetime: 100 });
    expect(useReviewStore.getState().status).toBe('running');
    expect(useReviewStore.getState().progress).toEqual({ done: 0, total: 8 });
    expect(useAnalysisStore.getState().enabled).toBe(false);
    expect(useReviewStore.getState().start()).toBe(p); // second start while running: same run
    const summary = await p;
    unsub();

    expect(summary?.moves).toHaveLength(7);
    const s = useReviewStore.getState();
    expect(s.status).toBe('done');
    expect(s.summary).toBe(summary);
    expect(s.progress).toEqual({ done: 8, total: 8 });
    expect(s.options).toEqual({ movetime: 100 });
    expect(engine.calls[0]).toEqual({ movetime: 100, multipv: 1 });
    expect(statuses.at(-1)).toBe('done');
    expect(enabledDuringRun.every((e) => !e)).toBe(true);
    expect(useAnalysisStore.getState().enabled).toBe(true);
    expect(engine.loadCalls).toBe(1);
  });

  it('reuses the engine and the cache across runs with the same options', async () => {
    await useReviewStore.getState().start({ depth: 10 });
    const searched = engine.analysed.length;
    await useReviewStore.getState().start({ depth: 10 });
    expect(engine.analysed.length).toBe(searched);
    expect(created).toBe(1);
    expect(engine.loadCalls).toBe(1);
    await useReviewStore.getState().start({ depth: 12 }); // different budget: separate cache
    expect(engine.analysed.length).toBe(searched * 2);
  });

  it('cancel → cancelled, analysis restored; restart resumes from the cache', async () => {
    const fens = [
      useGameStore.getState().startFen,
      ...useGameStore.getState().moves.map((m) => m.fen),
    ];
    engine.hang.add(fens[3]!);
    const p = useReviewStore.getState().start();
    await expect.poll(() => useReviewStore.getState().progress.done).toBe(3);
    useReviewStore.getState().cancel();
    expect(await p).toBeUndefined();
    expect(useReviewStore.getState().status).toBe('cancelled');
    // The cancel stops the search; the pool stops the engine again when the lease is handed back.
    expect(engine.stopCalls).toBeGreaterThanOrEqual(1);
    expect(useAnalysisStore.getState().enabled).toBe(true);

    engine.hang.clear();
    engine.analysed.length = 0;
    const summary = await useReviewStore.getState().start();
    expect(summary?.moves).toHaveLength(7);
    expect(engine.analysed).toEqual(fens.slice(3, 7));
  });

  it('engine errors → error status with message', async () => {
    engine.fail.set(useGameStore.getState().moves[1]!.fen, new Error('boom'));
    expect(await useReviewStore.getState().start()).toBeUndefined();
    expect(useReviewStore.getState()).toMatchObject({ status: 'error', error: 'boom' });
    expect(useAnalysisStore.getState().enabled).toBe(true);
  });

  it('load failures → error; the next start creates a fresh engine', async () => {
    engine.load = () => Promise.reject(new Error('no wasm'));
    await useReviewStore.getState().start();
    expect(useReviewStore.getState()).toMatchObject({ status: 'error', error: 'no wasm' });
    expect(engine.disposed).toBe(true);
    engine = new FakeReviewEngine();
    expect(await useReviewStore.getState().start()).toBeDefined();
    expect(created).toBe(2);
  });

  it('does not re-enable analysis that was off before', async () => {
    useAnalysisStore.getState().setEnabled(false);
    await useReviewStore.getState().start();
    expect(useAnalysisStore.getState().enabled).toBe(false);
  });

  it('reset during a run returns to idle and a new run does not overlap the old search', async () => {
    const fens = [
      useGameStore.getState().startFen,
      ...useGameStore.getState().moves.map((m) => m.fen),
    ];
    engine.hang.add(fens[1]!);
    const first = useReviewStore.getState().start();
    await expect.poll(() => engine.active).toBe(1);
    useReviewStore.getState().reset();
    expect(useReviewStore.getState().status).toBe('idle');
    engine.hang.clear();
    const second = useReviewStore.getState().start();
    expect(await first).toBeUndefined();
    expect((await second)?.moves).toHaveLength(7);
    expect(useReviewStore.getState().status).toBe('done');
    expect(engine.maxActive).toBe(1);
    expect(useAnalysisStore.getState().enabled).toBe(true);
  });

  it('keeps move details with the best line (from the PV) next to the summary', async () => {
    const g = useGameStore.getState();
    const beforeNf6 = g.moves[4]!.fen;
    engine.scripts.set(beforeNf6, { score: { cp: 20 }, pv: ['g7g6', 'h5f3', 'g8f6'] });
    engine.scripts.set(g.moves[5]!.fen, { score: { mate: 1 }, pv: ['h5f7'] });
    const seen: number[] = [];
    const unsub = useReviewStore.subscribe((s) => seen.push(Object.keys(s.moveDetails).length));
    await useReviewStore.getState().start({ depth: 5 }, { auto: true });
    unsub();
    const s = useReviewStore.getState();
    expect(Object.keys(s.moveDetails)).toHaveLength(7);
    // Filled incrementally while running.
    expect(seen).toContain(3);
    const nf6 = s.moveDetails[6]!;
    expect(nf6.bestSan).toBe('g6');
    expect(nf6.bestLineSan).toBe('3... g6 4. Qf3 Nf6');
    expect(nf6.classification).toBe(s.summary!.moves[5]!.classification);
    expect(s.trigger).toBe('auto');
    expect(s.autoNotice).toBe(true);
    s.dismissAutoNotice();
    expect(useReviewStore.getState().autoNotice).toBe(false);
    useReviewStore.getState().reset();
    expect(useReviewStore.getState().moveDetails).toEqual({});
    await useReviewStore.getState().start({ depth: 5 });
    expect(useReviewStore.getState()).toMatchObject({ trigger: 'manual', autoNotice: false });
  });
});

/** Fake `RemoteEngineClient` for the review: a scriptable engine plus welcome metadata. */
class FakeRemoteClient extends FakeReviewEngine {
  engineName = 'Stockfish 19';
  limits = { ...DEFAULT_LIMITS, maxThreads: 8 };
  readonly options: Record<string, string | number | boolean>[] = [];
  override async setOptions(o?: Record<string, string | number | boolean>): Promise<void> {
    if (o) this.options.push(o);
  }
}

describe('reviewStore: review engine selection (ADR-014)', () => {
  let browser: FakeReviewEngine;
  let remote: FakeRemoteClient;
  let serverCreated = 0;
  let browserCreated = 0;

  const fens = (): string[] => [
    useGameStore.getState().startFen,
    ...useGameStore.getState().moves.map((m) => m.fen),
  ];

  beforeEach(() => {
    browser = new FakeReviewEngine();
    remote = new FakeRemoteClient();
    serverCreated = 0;
    browserCreated = 0;
    setReviewEngineFactory(
      () => {
        browserCreated++;
        return browser;
      },
      () => {
        serverCreated++;
        return remote;
      },
    );
    useSettingsStore.getState().set({ reviewEngine: 'auto' });
  });

  afterEach(() => {
    useSettingsStore.getState().set({ reviewEngine: 'auto' });
  });

  it('auto: reviews on the server with its max threads and releases the session afterwards', async () => {
    const seen: (string | undefined)[] = [];
    const unsub = useReviewStore.subscribe((s) => seen.push(s.runsOn?.kind));
    const summary = await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    unsub();
    expect(summary?.moves).toHaveLength(7);
    expect(serverCreated).toBe(1);
    expect(browserCreated).toBe(0);
    expect(remote.options).toEqual([{ Threads: 8, Hash: 256 }]);
    expect(remote.calls[0]).toEqual({ movetime: 300, multipv: 1 });
    expect(remote.disposed).toBe(true);
    const s = useReviewStore.getState();
    expect(s.runsOn).toEqual({ kind: 'server', name: 'Stockfish 19', threads: 8 });
    expect(s.engineNotice).toBeUndefined();
    expect(seen).toContain('server');
  });

  it('auto: a failing handshake falls back to the browser with a notice; cooldown skips the server', async () => {
    remote.load = () => Promise.reject(remoteError('Cannot connect', 'closed'));
    const summary = await useReviewStore.getState().start();
    expect(summary?.moves).toHaveLength(7);
    expect(browser.analysed.length).toBeGreaterThan(0);
    expect(useReviewStore.getState()).toMatchObject({
      status: 'done',
      runsOn: { kind: 'browser' },
      engineNotice: 'Server unavailable (not reachable) — reviewing in the browser',
    });
    expect(remote.disposed).toBe(true);
    // Within the cooldown `auto` goes straight to the browser (no second handshake).
    useReviewStore.getState().reset();
    await useReviewStore.getState().start({ depth: 7 });
    expect(serverCreated).toBe(1);
    expect(useReviewStore.getState().engineNotice).toMatch(/not reachable/);
  });

  it('unauthorized → "Access token required or wrong"; explicit server retries every time', async () => {
    useSettingsStore.getState().set({ reviewEngine: 'server' });
    remote.load = () => Promise.reject(remoteError('Engine server: access token', 'unauthorized'));
    await useReviewStore.getState().start();
    expect(useReviewStore.getState().engineNotice).toBe(
      'Server unavailable (Access token required or wrong) — reviewing in the browser',
    );
    expect(useReviewStore.getState().status).toBe('done');
    await useReviewStore.getState().start({ depth: 5 });
    expect(serverCreated).toBe(2);
  });

  it('auto + unauthorized falls back silently (also within the cooldown)', async () => {
    remote.load = () => Promise.reject(remoteError('Engine server: access token', 'unauthorized'));
    expect((await useReviewStore.getState().start())?.moves).toHaveLength(7);
    expect(useReviewStore.getState()).toMatchObject({
      status: 'done',
      runsOn: { kind: 'browser' },
      engineNotice: undefined,
    });
    await useReviewStore.getState().start({ depth: 6 });
    expect(serverCreated).toBe(1);
    expect(useReviewStore.getState().engineNotice).toBeUndefined();
    // Explicit server shows the reason.
    useSettingsStore.getState().set({ reviewEngine: 'server' });
    await useReviewStore.getState().start({ depth: 5 });
    expect(useReviewStore.getState().engineNotice).toBe(
      'Server unavailable (Access token required or wrong) — reviewing in the browser',
    );
  });

  it('a session limit error (no_capacity) falls back as well', async () => {
    remote.fail.set(fens()[0]!, remoteError('too many sessions from your address', 'no_capacity'));
    await useReviewStore.getState().start();
    expect(useReviewStore.getState()).toMatchObject({
      status: 'done',
      runsOn: { kind: 'browser' },
      engineNotice: 'Server unavailable (too many sessions, busy) — reviewing in the browser',
    });
  });

  it('server drop mid-review: finishes in the browser, keeps the cache, searches only the rest', async () => {
    const f = fens();
    remote.fail.set(f[4]!, remoteError('Connection to engine server closed', 'closed'));
    const summary = await useReviewStore.getState().start({ depth: 10 });
    expect(summary?.moves).toHaveLength(7);
    expect(remote.analysed).toEqual(f.slice(0, 5));
    // Positions 0–3 come from the cache; the browser searches 4–6 (7 is mate, not searched).
    expect(browser.analysed).toEqual(f.slice(4, 7));
    expect(remote.disposed).toBe(true);
    expect(useReviewStore.getState()).toMatchObject({
      status: 'done',
      runsOn: { kind: 'browser' },
      engineNotice: 'Server unavailable (connection lost) — reviewing in the browser',
      progress: { done: 8, total: 8 },
    });
    // The cache survives the fallback: the same review again searches nothing.
    useSettingsStore.getState().set({ reviewEngine: 'browser' });
    browser.analysed.length = 0;
    await useReviewStore.getState().start({ depth: 10 });
    expect(browser.analysed).toEqual([]);
  });

  it('explicit browser never creates a server client', async () => {
    useSettingsStore.getState().set({ reviewEngine: 'browser' });
    await useReviewStore.getState().start();
    expect(serverCreated).toBe(0);
    expect(useReviewStore.getState()).toMatchObject({
      runsOn: { kind: 'browser' },
      engineNotice: undefined,
    });
  });

  it('no server configured: auto uses the browser silently, explicit server shows a notice', async () => {
    setReviewEngineFactory(() => browser);
    await useReviewStore.getState().start();
    expect(useReviewStore.getState().engineNotice).toBeUndefined();
    useSettingsStore.getState().set({ reviewEngine: 'server' });
    await useReviewStore.getState().start({ depth: 4 });
    expect(useReviewStore.getState().engineNotice).toMatch(/no server configured/);
  });

  it('cancel during a server run stops it without falling back and releases the session', async () => {
    remote.hang.add(fens()[2]!);
    const p = useReviewStore.getState().start();
    await expect.poll(() => remote.active).toBe(1);
    useReviewStore.getState().cancel();
    expect(await p).toBeUndefined();
    expect(useReviewStore.getState().status).toBe('cancelled');
    expect(browserCreated).toBe(0);
    expect(remote.disposed).toBe(true);
  });

  it('maps failure reasons', () => {
    expect(serverFailureReason(remoteError('x', 'timeout'))).toBe('no response');
    expect(serverFailureReason(remoteError('x', 'engine_crashed'))).toBe('engine crashed');
    expect(serverFailureReason(new Error('odd'))).toBe('odd');
    expect(fallbackNotice('r')).toBe('Server unavailable (r) — reviewing in the browser');
  });
});
