/**
 * Every way the browser engine can fail to start (or stop answering) ends the review visibly:
 * status `error` with a message that says why and what the server could do, or a server run with
 * a notice (browser → server fallback). Never `running` forever, never silently `idle`, never
 * stored as a finished review.
 */
import {
  DEFAULT_LIMITS,
  type AnalyzeOptions,
  type BestMove,
  type EngineInfo,
} from '@daisychess/engine-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetWasmHealth, wasmHealth } from '../engine/wasmHealth';
import { browserEnginePool } from '../engine/wasmPool';
import { setWasmSupportForTests } from '../engine/wasmSupport';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { FakeReviewEngine } from './fakeEngine';
import { clearReviewCache, configureReviewCache, gameKey, getStoredReview } from './reviewCache';
import {
  BROWSER_UNAVAILABLE_NOTICE,
  REVIEW_PRESETS,
  SERVER_SETTING_HINT,
  serverTokenHint,
  browserFailureMessage,
  disposeReviewEngine,
  gameToBatch,
  setReviewEngineFactory,
  setReviewStallTimeout,
  useReviewStore,
  type ReviewStatus,
} from './reviewStore';
import { remoteError } from './serverReviewEngine';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';
const NO_SIMD = { wasm: true, simd: false, threads: true, error: 'wasm-simd is not enabled' };

class FakeRemoteClient extends FakeReviewEngine {
  engineName = 'Stockfish 19';
  limits = { ...DEFAULT_LIMITS, maxThreads: 8 };
}

/** An engine that loads but whose searches never produce anything (not even after `stop`). */
class SilentEngine extends FakeReviewEngine {
  override analyze(
    fen: string,
    opts: AnalyzeOptions,
  ): AsyncIterable<EngineInfo> & { bestMove: Promise<BestMove | null> } {
    this.analysed.push(fen);
    this.calls.push(opts);
    return {
      bestMove: new Promise<BestMove | null>(() => undefined),
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<EngineInfo>>(() => undefined),
        return: async () => ({ done: true, value: undefined }),
      }),
    };
  }
}

let browser: FakeReviewEngine;
let remote: FakeRemoteClient;
let browserCreated: number;
let serverCreated: number;

const key = (): string => {
  const g = gameToBatch(useGameStore.getState());
  return gameKey(
    g.startFen,
    g.moves.map((m) => m.uci),
  );
};

function statuses(): { list: ReviewStatus[]; stop(): void } {
  const list: ReviewStatus[] = [];
  const stop = useReviewStore.subscribe((s) => list.push(s.status));
  return { list, stop };
}

/** Browser engine factory + server client factory (`null`: no server configured). */
function engines(withServer: boolean): void {
  setReviewEngineFactory(
    () => {
      browserCreated++;
      return browser;
    },
    withServer
      ? () => {
          serverCreated++;
          return remote;
        }
      : null,
  );
}

beforeEach(async () => {
  configureReviewCache(null);
  await clearReviewCache();
  resetWasmHealth();
  browser = new FakeReviewEngine();
  remote = new FakeRemoteClient();
  browserCreated = 0;
  serverCreated = 0;
  engines(true);
  useReviewStore.getState().reset();
  useGameStore.getState().loadPgn(SCHOLAR);
  useAnalysisStore.getState().setEnabled(true);
  useSettingsStore.getState().set({ reviewEngine: 'auto' });
});

afterEach(async () => {
  useReviewStore.getState().reset();
  await disposeReviewEngine();
  setWasmSupportForTests(null);
  setReviewStallTimeout();
  resetWasmHealth();
  useSettingsStore.getState().set({ reviewEngine: 'auto' });
  useAnalysisStore.getState().setEnabled(false);
});

describe('browserFailureMessage', () => {
  const err = new Error('wasm-simd is not enabled');
  it('says what failed and what the server could do', () => {
    const base = { atLoad: true, pref: 'auto' as const, serverConfigured: true };
    expect(browserFailureMessage(err, { ...base, serverConfigured: false })).toBe(
      'the browser engine could not start (wasm-simd is not enabled).',
    );
    expect(
      browserFailureMessage(err, { ...base, serverError: remoteError('token', 'unauthorized') }),
    ).toBe(`the browser engine could not start (wasm-simd is not enabled). ${serverTokenHint()}`);
    expect(browserFailureMessage(err, { ...base, serverError: remoteError('x', 'closed') })).toBe(
      'the browser engine could not start (wasm-simd is not enabled); the server is unavailable too (not reachable).',
    );
    expect(browserFailureMessage(err, { ...base, pref: 'browser' })).toBe(
      `the browser engine could not start (wasm-simd is not enabled). ${SERVER_SETTING_HINT}`,
    );
    expect(browserFailureMessage(new Error('boom.'), { ...base, atLoad: false })).toBe(
      'the browser engine failed (boom).',
    );
  });
});

describe('reviewStore: browser engine load failures', () => {
  it('load() rejects (browser preference, no server) → error, analysis restored, nothing stored', async () => {
    engines(false);
    useSettingsStore.getState().set({ reviewEngine: 'browser' });
    browser.load = () => Promise.reject(new Error('Engine did not answer'));
    const { list, stop } = statuses();
    expect(await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast })).toBeUndefined();
    stop();
    expect(list).toEqual(['running', 'error']);
    expect(useReviewStore.getState()).toMatchObject({
      status: 'error',
      error: 'the browser engine could not start (Engine did not answer).',
    });
    expect(useAnalysisStore.getState().enabled).toBe(true);
    expect(await getStoredReview(key())).toBeUndefined();
    // Not recorded: the next start runs again (and succeeds on a fresh engine).
    browser = new FakeReviewEngine();
    expect(await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast })).toBeDefined();
    expect(useReviewStore.getState().status).toBe('done');
    expect(browser.analysed.length).toBeGreaterThan(0);
    expect(browserCreated).toBe(2);
  });

  it('load() throws synchronously → error (no unhandled rejection)', async () => {
    engines(false);
    browser.load = () => {
      throw new Error('worker blocked');
    };
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(useReviewStore.getState()).toMatchObject({
      status: 'error',
      error: 'the browser engine could not start (worker blocked).',
    });
  });

  it('the engine factory throws synchronously → error', async () => {
    setReviewEngineFactory(() => {
      throw new Error('cannot create worker');
    });
    await useReviewStore.getState().start({ movetime: 10 });
    expect(useReviewStore.getState()).toMatchObject({
      status: 'error',
      error: 'the browser engine could not start (cannot create worker).',
    });
  });

  it('a search that never answers fails after the stall timeout instead of running forever', async () => {
    engines(false);
    browser = new SilentEngine();
    setReviewStallTimeout(30);
    const { list, stop } = statuses();
    expect(await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast })).toBeUndefined();
    stop();
    expect(list.at(-1)).toBe('error');
    expect(useReviewStore.getState().error).toBe(
      'the browser engine failed (the engine stopped responding (no output for 30 ms)).',
    );
    expect(browser.stopCalls).toBeGreaterThan(0);
    // The stalled engine is not handed to the next user.
    expect(browser.disposed).toBe(true);
    expect(await getStoredReview(key())).toBeUndefined();
  });

  it('auto: no token (server refuses) + browser load fails → error with the token hint', async () => {
    remote.load = () => Promise.reject(remoteError('Engine server: access token', 'unauthorized'));
    browser.load = () => Promise.reject(new Error('wasm-simd is not enabled'));
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(useReviewStore.getState()).toMatchObject({
      status: 'error',
      error: `the browser engine could not start (wasm-simd is not enabled). ${serverTokenHint()}`,
    });
    // The server was asked once, not twice.
    expect(serverCreated).toBe(1);
  });

  it('server preference: server down and browser load fails → both reasons', async () => {
    useSettingsStore.getState().set({ reviewEngine: 'server' });
    remote.load = () => Promise.reject(remoteError('Cannot connect', 'closed'));
    browser.load = () => Promise.reject(new Error('Out of memory'));
    await useReviewStore.getState().start({ movetime: 10 });
    expect(useReviewStore.getState()).toMatchObject({
      status: 'error',
      error:
        'the browser engine could not start (Out of memory); the server is unavailable too (not reachable).',
    });
  });

  it('browser preference: never asks the server, hints at the setting', async () => {
    useSettingsStore.getState().set({ reviewEngine: 'browser' });
    browser.load = () => Promise.reject(new Error('wasm-simd is not enabled'));
    await useReviewStore.getState().start({ movetime: 10 });
    expect(useReviewStore.getState().error).toBe(
      `the browser engine could not start (wasm-simd is not enabled). ${SERVER_SETTING_HINT}`,
    );
    expect(serverCreated).toBe(0);
  });

  it('auto: server on cooldown, browser load fails → tries the server once and reviews there', async () => {
    let serverDown = true;
    remote.load = async () => {
      if (serverDown) throw remoteError('Cannot connect', 'closed');
    };
    await useReviewStore.getState().start({ movetime: 10 });
    expect(useReviewStore.getState().runsOn).toEqual({ kind: 'browser' });
    // The server is back, but on cooldown; the browser engine now fails to load (not disabled).
    serverDown = false;
    await browserEnginePool.dispose();
    browser.load = () => Promise.reject(new Error('Engine did not answer'));
    const summary = await useReviewStore.getState().start({ depth: 3 });
    expect(summary?.moves).toHaveLength(7);
    expect(useReviewStore.getState()).toMatchObject({
      status: 'done',
      runsOn: { kind: 'server', name: 'Stockfish 19' },
      engineNotice: BROWSER_UNAVAILABLE_NOTICE,
    });
  });

  it('server drops mid-run and the browser engine cannot start → error with both reasons', async () => {
    const fen = useGameStore.getState().moves[3]!.fen;
    remote.fail.set(fen, remoteError('Connection to engine server closed', 'closed'));
    browser.load = () => Promise.reject(new Error('wasm-simd is not enabled'));
    await useReviewStore.getState().start({ movetime: 10 });
    expect(useReviewStore.getState()).toMatchObject({
      status: 'error',
      error:
        'the browser engine could not start (wasm-simd is not enabled); the server is unavailable too (connection lost).',
    });
  });

  it('cancel before anything ran (cache lookup) → cancelled, not silently idle', async () => {
    const p = useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    useReviewStore.getState().cancel();
    expect(await p).toBeUndefined();
    expect(useReviewStore.getState().status).toBe('cancelled');
    expect(browserCreated).toBe(0);
  });
});

describe('reviewStore: browser without WebAssembly SIMD', () => {
  beforeEach(() => setWasmSupportForTests(NO_SIMD));

  it('auto with a server: reviews on the server with the notice, no browser engine created', async () => {
    const summary = await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast });
    expect(summary?.moves).toHaveLength(7);
    expect(useReviewStore.getState()).toMatchObject({
      status: 'done',
      runsOn: { kind: 'server' },
    });
    expect(browserCreated).toBe(0);
    expect(serverCreated).toBe(1);
  });

  it('auto, the server refuses the missing token → the error the owner sees', async () => {
    remote.load = () => Promise.reject(remoteError('Engine server: access token', 'unauthorized'));
    const { list, stop } = statuses();
    await useReviewStore.getState().start({ ...REVIEW_PRESETS.fast }, { auto: true });
    stop();
    expect(list.at(-1)).toBe('error');
    expect(useReviewStore.getState().error).toBe(
      'the browser engine could not start (wasm-simd is not enabled). Enter the server access token in Settings to review on the server.',
    );
    expect(browserCreated).toBe(0);
    expect(wasmHealth().disabled).toBe('wasm-simd is not enabled');
    expect(await getStoredReview(key())).toBeUndefined();
  });

  it('browser preference: error at once, the server is never asked', async () => {
    useSettingsStore.getState().set({ reviewEngine: 'browser' });
    await useReviewStore.getState().start({ movetime: 10 });
    expect(useReviewStore.getState()).toMatchObject({ status: 'error' });
    expect(useReviewStore.getState().error).toMatch(
      /^the browser engine could not start \(wasm-simd is not enabled\)\./,
    );
    expect(serverCreated).toBe(0);
    expect(browserCreated).toBe(0);
  });

  it('auto, the server fails after the browser was skipped → server tried only once', async () => {
    remote.load = () => Promise.reject(remoteError('Cannot connect', 'closed'));
    await useReviewStore.getState().start({ movetime: 10 });
    expect(useReviewStore.getState().error).toBe(
      'the browser engine could not start (wasm-simd is not enabled); the server is unavailable too (not reachable).',
    );
    expect(serverCreated).toBe(1);
  });
});
