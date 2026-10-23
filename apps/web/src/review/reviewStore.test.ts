import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { FakeReviewEngine } from './fakeEngine';
import {
  disposeReviewEngine,
  gameToBatch,
  setReviewEngineFactory,
  useReviewStore,
} from './reviewStore';

const SCHOLAR = '1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7#';

let engine: FakeReviewEngine;
let created = 0;

beforeEach(() => {
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
    expect(engine.stopCalls).toBe(1);
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
});
