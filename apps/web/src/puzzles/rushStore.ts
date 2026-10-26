import { rushPlan, type Puzzle } from '@daisychess/puzzles';
import { create } from 'zustand';
import { humanGameLockReason, lockText } from '../live/lock';
import { getPuzzlesState, recordRush, updatePuzzlesState, type RushDuration } from './puzzlesState';
import { usePuzzleStore, type PuzzleResult } from './puzzleStore';

/*
 * Puzzle rush (ADR-023 §8): 3 or 5 minutes, three strikes, unrated. The run is a precomputed
 * `rushPlan` over the puzzles available offline (cached shards + starter), so nothing is fetched
 * during a run. Each puzzle is played by the solver store (`start(puzzle, { rated: false })`);
 * a solved puzzle scores, a wrong move is a strike, and the next puzzle follows after a short
 * pause. The run ends on: time up, three strikes, the plan running out, "End run", or the solver
 * session ending from outside (human-game lock, the board was changed).
 */

export const RUSH_STRIKES = 3;
/** Rush puzzles of the last N seen ones are not repeated. */
export const RUSH_SEEN_WINDOW = 500;
export const SOLVED_PAUSE_MS = 350;
export const FAILED_PAUSE_MS = 600;
const TICK_MS = 100;

export type RushStatus = 'idle' | 'loading' | 'running' | 'over';

export interface RushState {
  status: RushStatus;
  duration: RushDuration;
  remainingMs: number;
  score: number;
  strikes: number;
  /** 1-based number of the current puzzle in the run. */
  puzzleNo: number;
  /** The finished run beat the stored best for its duration. */
  newBest: boolean;
  /** Why a run did not start or how it ended. */
  message?: string;
}

export interface RushActions {
  start(duration: RushDuration): Promise<void>;
  /** Ends a running run now (the score counts). */
  end(): void;
}

export type RushStore = RushState & RushActions;

export interface RushPort {
  /** Puzzles available without the network. */
  pool(): Promise<Puzzle[]>;
  /** Ids to avoid (most recent last). */
  seen(): string[];
  /** Stores the score; returns whether it is a new best. */
  record(duration: RushDuration, score: number): boolean;
}

export const appRushPort = (): RushPort => ({
  pool: () => import('./source').then((m) => m.localPuzzles()),
  seen: () => getPuzzlesState().seen.slice(-RUSH_SEEN_WINDOW),
  record: (duration, score) => {
    const key = duration === 3 ? 'best3' : 'best5';
    const before = getPuzzlesState().rush[key];
    updatePuzzlesState((s) => recordRush(s, duration, score));
    return score > before;
  },
});

let port: RushPort = appRushPort();
let gen = 0;
let plan: Puzzle[] = [];
let index = 0;
let deadline = 0;
let tick: ReturnType<typeof setInterval> | null = null;
let advance: ReturnType<typeof setTimeout> | null = null;
let unwatch: (() => void) | null = null;
/** The rush itself stops the solver session (its watcher must not end the run twice). */
let ending = false;

const set = (partial: Partial<RushState>): void => useRushStore.setState(partial);
const get = (): RushStore => useRushStore.getState();

function clearTimers(): void {
  if (tick !== null) clearInterval(tick);
  tick = null;
  if (advance !== null) clearTimeout(advance);
  advance = null;
  unwatch?.();
  unwatch = null;
}

function finish(message: string): void {
  if (get().status !== 'running') return;
  gen++;
  clearTimers();
  const { duration, score } = get();
  let newBest = false;
  try {
    newBest = score > 0 && port.record(duration, score);
  } catch {
    // Storage failure: the score is shown but not kept.
  }
  ending = true;
  try {
    usePuzzleStore.getState().stop();
  } finally {
    ending = false;
  }
  set({ status: 'over', remainingMs: Math.max(0, deadline - Date.now()), newBest, message });
}

function showNext(): void {
  advance = null;
  if (get().status !== 'running') return;
  const puzzle = plan[index];
  if (!puzzle) {
    finish('You went through every puzzle of this run.');
    return;
  }
  index++;
  const my = gen;
  set({ puzzleNo: index });
  usePuzzleStore.getState().start(puzzle, {
    rated: false,
    onResult: (result: PuzzleResult) => {
      if (my !== gen || get().status !== 'running') return;
      if (result === 'solved') {
        set({ score: get().score + 1 });
      } else {
        const strikes = get().strikes + 1;
        set({ strikes });
        if (strikes >= RUSH_STRIKES) {
          finish('Three strikes.');
          return;
        }
      }
      advance = setTimeout(showNext, result === 'solved' ? SOLVED_PAUSE_MS : FAILED_PAUSE_MS);
    },
  });
  if (get().status === 'running' && usePuzzleStore.getState().status !== 'running') {
    finish(usePuzzleStore.getState().message ?? 'The run ended.');
  }
}

export const useRushStore = create<RushStore>()(() => ({
  status: 'idle',
  duration: 3,
  remainingMs: 0,
  score: 0,
  strikes: 0,
  puzzleNo: 0,
  newBest: false,
  start: async (duration) => {
    const st = get().status;
    if (st === 'loading' || st === 'running') return;
    const lock = humanGameLockReason();
    if (lock) {
      set({ status: 'idle', message: `Rush is paused: ${lockText(lock) ?? 'a game runs'}.` });
      return;
    }
    const my = ++gen;
    set({
      status: 'loading',
      duration,
      message: undefined,
      score: 0,
      strikes: 0,
      puzzleNo: 0,
      newBest: false,
      remainingMs: duration * 60_000,
    });
    let pool: Puzzle[] = [];
    try {
      pool = await port.pool();
    } catch {
      // Treated like an empty pool.
    }
    if (my !== gen) return;
    plan = rushPlan(pool, port.seen());
    if (plan.length === 0) {
      set({
        status: 'idle',
        message:
          'No puzzles are available offline yet. Solve a few puzzles first or keep puzzles for offline use in Settings.',
      });
      return;
    }
    index = 0;
    deadline = Date.now() + duration * 60_000;
    set({ status: 'running' });
    unwatch = usePuzzleStore.subscribe((s) => {
      if (ending || get().status !== 'running') return;
      if (s.status === 'idle' || s.status === 'empty') finish(s.message ?? 'The run ended.');
    });
    tick = setInterval(() => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        set({ remainingMs: 0 });
        finish('Time is up.');
      } else {
        set({ remainingMs: remaining });
      }
    }, TICK_MS);
    showNext();
  },
  end: () => finish('Run ended.'),
}));

/** Test seam: ends any run and installs `next` (the app's port by default). */
export function resetRushStore(next: RushPort = appRushPort()): void {
  gen++;
  clearTimers();
  port = next;
  plan = [];
  index = 0;
  useRushStore.setState({
    status: 'idle',
    duration: 3,
    remainingMs: 0,
    score: 0,
    strikes: 0,
    puzzleNo: 0,
    newBest: false,
    message: undefined,
  });
}
