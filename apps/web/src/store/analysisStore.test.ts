// @vitest-environment jsdom
import type { EngineInfo } from '@chesslab/engine-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisEngine } from '../engine/AnalysisController';
import {
  classifyPosition,
  DEFAULT_SETTINGS,
  mergeLine,
  sanitizeSettings,
  startAnalysisController,
  STORAGE_KEY,
  useAnalysisStore,
  type AnalysisLine,
} from './analysisStore';
import { START_FEN, useGameStore } from './gameStore';

const info = (multipv: number, depth: number, cp = 10): EngineInfo => ({
  multipv,
  depth,
  score: { cp },
  pv: ['e2e4', 'e7e5'],
  nps: 1000,
});

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
    expect(sanitizeSettings({ depth: Number.NaN })).toEqual(DEFAULT_SETTINGS);
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

/** Minimal engine whose searches are driven by the test. */
class ScriptedEngine implements AnalysisEngine {
  engineName = 'Stockfish Test';
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
  async dispose() {}
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

describe('analysis store + controller', () => {
  let stop: () => void = () => undefined;
  let engine: ScriptedEngine;
  const storage = new Map<string, string>();

  beforeEach(() => {
    vi.useFakeTimers();
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    });
    useGameStore.getState().reset();
    useAnalysisStore.setState({
      enabled: false,
      settings: { ...DEFAULT_SETTINGS },
      status: 'idle',
      lines: [],
    });
    engine = new ScriptedEngine();
    stop = startAnalysisController({ createEngine: () => engine, debounceMs: 80 });
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
      settings: DEFAULT_SETTINGS,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAnalysisStore.getState()).toMatchObject({
      status: 'analysing',
      engineName: 'Stockfish Test',
      capabilities: { threadCount: 1 },
    });
    engine.searches[0]!.emit(info(1, 3, 25));
    engine.searches[0]!.emit(info(1, 4, 30));
    await vi.advanceTimersByTimeAsync(0);
    expect(useAnalysisStore.getState().lines).toEqual([
      { multipv: 1, depth: 4, score: { cp: 30 }, pv: ['e2e4', 'e7e5'], nps: 1000 },
    ]);

    useGameStore.getState().makeMove('e2', 'e4');
    const fenAfter = useGameStore.getState().moves[0]!.fen;
    expect(useAnalysisStore.getState().fen).toBe(fenAfter);
    expect(useAnalysisStore.getState().lines).toEqual([]);
    engine.searches[0]!.emit(info(1, 5, 99)); // stale
    await vi.advanceTimersByTimeAsync(80);
    expect(useAnalysisStore.getState().lines).toEqual([]);
    expect(engine.searches.at(-1)!.fen).toBe(fenAfter);
  });

  it('marks terminal positions and does not search them', async () => {
    useAnalysisStore.getState().setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    useGameStore.getState().loadFen('R5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 1 1');
    await vi.advanceTimersByTimeAsync(100);
    expect(useAnalysisStore.getState()).toMatchObject({
      terminal: 'checkmate',
      lines: [],
      status: 'ready',
    });
    expect(engine.searches).toHaveLength(1);
  });

  it('persists settings and applies MultiPV', async () => {
    useAnalysisStore.getState().setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    useAnalysisStore.getState().setSettings({ multipv: 3, depth: 50 });
    expect(useAnalysisStore.getState().settings).toEqual({ depth: 40, multipv: 3 });
    expect(JSON.parse(storage.get(STORAGE_KEY)!).settings).toEqual({ depth: 40, multipv: 3 });
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.options).toEqual([{ MultiPV: 3 }]);
    engine.searches.at(-1)!.emit(info(3, 2));
    engine.searches.at(-1)!.emit(info(1, 2));
    await vi.advanceTimersByTimeAsync(0);
    expect(useAnalysisStore.getState().lines.map((l) => l.multipv)).toEqual([1, 3]);
  });
});
