// @vitest-environment jsdom
import type { Puzzle } from '@daisychess/puzzles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAnalysisPause } from '../engine/analysisPause';
import { usePlayStore } from '../play/playStore';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { INTRO_DELAY_MS, resetPuzzleStore, usePuzzleStore, type PuzzlePort } from './puzzleStore';
import {
  FAILED_PAUSE_MS,
  resetRushStore,
  SOLVED_PAUSE_MS,
  useRushStore,
  type RushPort,
} from './rushStore';

const make = (id: string, rating: number): Puzzle => ({
  id,
  fen: '6k1/5ppp/8/4n3/8/8/8/RR4K1 b - - 0 1',
  moves: ['e5c4', 'a1a8'],
  rating,
  rd: 80,
  themes: ['mateIn1'],
  openings: [],
  source: 'lichess',
});

const puzzlePort: PuzzlePort = {
  nextPuzzle: () => Promise.resolve(null),
  load: () => ({
    rating: { rating: 1500, rd: 350, vol: 0.09, n: 0 },
    difficulty: 'normal',
    filter: {},
  }),
  settle: () => ({ rating: 1500, rd: 350, vol: 0.09, n: 0 }),
  saveDifficulty: () => undefined,
  saveFilter: () => undefined,
  markSeen: () => undefined,
};

let recorded: [number, number][];
let best: number;
let pool: Puzzle[];
let pools: number;

const rushPort = (): RushPort => ({
  pool: () => {
    pools++;
    return Promise.resolve(pool);
  },
  seen: () => [],
  record: (d, score) => {
    recorded.push([d, score]);
    const isNew = score > best;
    best = Math.max(best, score);
    return isNew;
  },
});

const originalSetEnabled = useAnalysisStore.getState().setEnabled;

async function startRun(d: 3 | 5 = 3) {
  await vi.waitFor(() => undefined);
  await useRushStore.getState().start(d);
  vi.advanceTimersByTime(INTRO_DELAY_MS);
}

const solve = () => {
  expect(useGameStore.getState().makeMove('a1', 'a8')).toBe(true);
};
const blunder = () => {
  expect(useGameStore.getState().makeMove('a1', 'a2')).toBe(true);
};

beforeEach(() => {
  vi.useFakeTimers();
  resetAnalysisPause();
  useAnalysisStore.setState({
    enabled: false,
    setEnabled: (enabled: boolean) => useAnalysisStore.setState({ enabled }),
  });
  useGameStore.getState().reset();
  usePlayStore.setState({ mode: 'idle' });
  recorded = [];
  best = 0;
  pools = 0;
  pool = Array.from({ length: 10 }, (_, i) => make(`p${i}`, 800 + i * 100));
  resetPuzzleStore(puzzlePort);
  resetRushStore(rushPort());
});

afterEach(() => {
  resetRushStore();
  resetPuzzleStore();
  useAnalysisStore.setState({ setEnabled: originalSetEnabled });
  usePlayStore.setState({ mode: 'idle' });
  vi.useRealTimers();
});

describe('rushStore', () => {
  it('runs puzzles in rising order, scores solved ones and runs the countdown', async () => {
    await startRun();
    const s = useRushStore.getState();
    expect(s.status).toBe('running');
    expect(s.remainingMs).toBeLessThanOrEqual(180_000);
    expect(usePuzzleStore.getState().rated).toBe(false);
    const first = usePuzzleStore.getState().solver?.puzzle.id;
    expect(first).toMatch(/^p[0-4]$/); // random among the 5 nearest to 800
    solve();
    expect(useRushStore.getState().score).toBe(1);
    vi.advanceTimersByTime(SOLVED_PAUSE_MS);
    expect(usePuzzleStore.getState().solver?.puzzle.id).not.toBe(first);
    vi.advanceTimersByTime(10_000);
    expect(useRushStore.getState().remainingMs).toBeLessThan(171_000);
    expect(useRushStore.getState().puzzleNo).toBe(2);
  });

  it('three strikes end the run and record the score', async () => {
    await startRun();
    solve();
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(i === 0 ? SOLVED_PAUSE_MS : FAILED_PAUSE_MS);
      vi.advanceTimersByTime(INTRO_DELAY_MS);
      blunder();
    }
    const s = useRushStore.getState();
    expect(s.status).toBe('over');
    expect(s.strikes).toBe(3);
    expect(s.score).toBe(1);
    expect(s.newBest).toBe(true);
    expect(recorded).toEqual([[3, 1]]);
    expect(usePuzzleStore.getState().status).toBe('idle');
  });

  it('ends when the time is up', async () => {
    await startRun(3);
    vi.advanceTimersByTime(180_000);
    const s = useRushStore.getState();
    expect(s.status).toBe('over');
    expect(s.remainingMs).toBe(0);
    expect(s.message).toBe('Time is up.');
    expect(recorded).toEqual([]); // score 0 is not recorded as a best
  });

  it('"end" keeps the score; a zero score is not recorded', async () => {
    await startRun();
    solve();
    useRushStore.getState().end();
    expect(useRushStore.getState().status).toBe('over');
    expect(recorded).toEqual([[3, 1]]);
    vi.advanceTimersByTime(60_000);
    expect(useRushStore.getState().status).toBe('over');
  });

  it('ends when the solver session ends from outside (human game lock)', async () => {
    await startRun();
    solve();
    usePlayStore.setState({ mode: 'playing' });
    expect(useRushStore.getState().status).toBe('over');
    expect(usePuzzleStore.getState().status).toBe('idle');
  });

  it('refuses to start during a human game', async () => {
    usePlayStore.setState({ mode: 'playing' });
    await useRushStore.getState().start(3);
    expect(useRushStore.getState().status).toBe('idle');
    expect(useRushStore.getState().message).toContain('Rush is paused');
  });

  it('says so when no puzzle is available offline, and never touches the network port', async () => {
    pool = [];
    await useRushStore.getState().start(5);
    expect(useRushStore.getState().status).toBe('idle');
    expect(useRushStore.getState().message).toContain('No puzzles are available offline');
    expect(pools).toBe(1);
  });

  it('ends when the plan runs out', async () => {
    pool = [make('only', 900)];
    await startRun();
    solve();
    vi.advanceTimersByTime(SOLVED_PAUSE_MS);
    expect(useRushStore.getState().status).toBe('over');
    expect(useRushStore.getState().message).toContain('every puzzle');
  });
});
