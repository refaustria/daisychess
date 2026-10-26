import {
  GLICKO_DEFAULT,
  initialSolution,
  pendingMove,
  solutionState,
  type Difficulty,
  type GlickoRating,
  type Puzzle,
  type PuzzleFilter,
  type SolverEvent,
  type SolverState,
} from '@daisychess/puzzles';
import { Chess } from 'chess.js';
import { create } from 'zustand';
import { pauseAnalysis } from '../engine/analysisPause';
import { humanGameLockReason, lockText } from '../live/lock';
import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { useRoomStore } from '../room/roomStore';
import { useGameStore, type GameState, type MoveRecord } from '../store/gameStore';
import { useUiStore } from '../store/uiStore';
import { resolveSan } from '../trainer/drill';
import {
  applyPuzzleResult,
  getPuzzlesState,
  markSeen,
  subscribePuzzlesState,
  updatePuzzlesState,
  type PuzzleRatingState,
} from './puzzlesState';
import { useDrillStore } from '../trainer/drillState';

/*
 * Puzzle solver session (ADR-023 §6): drives the game store (position, the app's moves,
 * orientation) and the board (`movableColor` via `components/Puzzles/usePuzzleBoard.ts`) around
 * the pure reducer `solutionState` of `@daisychess/puzzles`. No network here: puzzles come from
 * the {@link PuzzlePort} (M30-3's data layer by default).
 *
 * Invariant while a session runs: the game store holds `startFen = puzzle.fen` and the moves of
 * `solver.played` (plus, for a moment, the user's wrong move). Any other change of the game store
 * ends the session.
 */

export type PuzzleStatus =
  /** No session (the board is free); a finished puzzle may still be shown. */
  | 'idle'
  /** Waiting for the next puzzle. */
  | 'loading'
  /** A puzzle runs (intro, the user's turn, replies, wrong move, solution). */
  | 'running'
  /** The line is over; the position stays until "Next puzzle", "Analyse" or a board change. */
  | 'done'
  /** The data layer has no puzzle for the filter (offline). */
  | 'empty';

/** Puzzle rating kept on the device (Glicko-2) plus the number of rated puzzles. */
export interface PuzzleRating extends GlickoRating {
  n: number;
}

export type PuzzleResult = 'solved' | 'failed';

export interface StartOptions {
  /** Rated (Glicko-2 update at the first terminal event); default: lichess puzzles with a rating. */
  rated?: boolean;
  /** Called once when the result is settled (daily results, rush strikes, mistake schedule). */
  onResult?: (result: PuzzleResult, puzzle: Puzzle) => void;
}

/** Data access of the solver (M30-3's data layer by default; fakes in tests). */
export interface PuzzlePort {
  nextPuzzle(
    filter: PuzzleFilter,
    rating: number,
    difficulty: Difficulty,
  ): Promise<Puzzle | null | undefined>;
  /** Stored rating, difficulty and filter (defaults when nothing is stored). */
  load(): { rating: PuzzleRating; difficulty: Difficulty; filter: PuzzleFilter };
  /** Settles a rated puzzle (Glicko-2, stored); returns the new rating. */
  settle(puzzle: Puzzle, solved: boolean): PuzzleRating;
  saveDifficulty(difficulty: Difficulty): void;
  saveFilter(filter: PuzzleFilter): void;
  markSeen(id: string): void;
  /** Rating changes from elsewhere (Settings reset); returns the unsubscribe function. */
  subscribe?(listener: (rating: PuzzleRating) => void): () => void;
}

export interface PuzzleState {
  status: PuzzleStatus;
  /** Solver state of the current (or last) puzzle. */
  solver?: SolverState;
  rating: PuzzleRating;
  /** Rating change of the last settled rated puzzle. */
  ratingDelta?: number;
  /** The current puzzle counts for the rating. */
  rated: boolean;
  difficulty: Difficulty;
  filter: PuzzleFilter;
  /** The user's wrong move is still on the board (shown with a red arrow before the takeback). */
  wrongOnBoard: boolean;
  /** Why a session could not start or was ended; the empty-filter text. */
  message?: string;
  /** Feedback of the typed move input (illegal SAN). */
  inputError?: string;
}

export interface PuzzleActions {
  /** Fetches the next puzzle (filter, rating, difficulty) and starts it. */
  next(): Promise<void>;
  /** Starts `puzzle` (refused while a human game runs). */
  start(puzzle: Puzzle, options?: StartOptions): void;
  /** Plays a typed move (SAN, e.g. `Nf3`); false when it is not legal or not the user's turn. */
  playSan(san: string): boolean;
  hint(): void;
  retry(): void;
  showSolution(): void;
  /**
   * Ends the session and keeps the puzzle position with the solution line in the game store,
   * restores the live analysis and shows the Moves tab.
   */
  analyse(): void;
  /** Ends the session (no rating change unless already settled); the board keeps its position. */
  stop(message?: string): void;
  setDifficulty(difficulty: Difficulty): void;
  setFilter(filter: PuzzleFilter): void;
}

export type PuzzleStore = PuzzleState & PuzzleActions;

/** The opponent's first move is played after this pause. */
export const INTRO_DELAY_MS = 600;
/** The opponent's reply follows a correct move after this pause. */
export const REPLY_DELAY_MS = 300;
/** A wrong move stays on the board this long before it is taken back. */
export const WRONG_SHOW_MS = 700;
/** Pause between the moves of "Show solution". */
export const SOLUTION_STEP_MS = 600;

export const NO_MORE_TEXT = 'No more puzzles for this filter offline.';

const toRating = (r: PuzzleRatingState): PuzzleRating => ({
  rating: r.r,
  rd: r.rd,
  vol: r.vol,
  n: r.n,
});

/**
 * The app's port: `puzzlesState` (localStorage `daisychess.puzzles`) for rating, difficulty,
 * filter and the seen ring; `source.nextPuzzle` (index, shards, cache, starter) loaded lazily so
 * the data layer stays out of the main chunk.
 */
export const appPort = (): PuzzlePort => ({
  nextPuzzle: (filter, rating, difficulty) =>
    import('./source').then((m) => m.nextPuzzle(filter, rating, difficulty)),
  load: () => {
    const s = getPuzzlesState();
    return { rating: toRating(s.rating), difficulty: s.difficulty, filter: s.filter };
  },
  settle: (puzzle, solved) =>
    toRating(updatePuzzlesState((s) => applyPuzzleResult(s, puzzle, solved)).rating),
  saveDifficulty: (difficulty) => {
    updatePuzzlesState((s) => (s.difficulty === difficulty ? s : { ...s, difficulty }));
  },
  saveFilter: (filter) => {
    updatePuzzlesState((s) => ({ ...s, filter }));
  },
  markSeen: (id) => {
    updatePuzzlesState((s) => markSeen(s, id));
  },
  subscribe: (listener) => subscribePuzzlesState((s) => listener(toRating(s.rating))),
});

let port: PuzzlePort = appPort();
let unsubscribePort: (() => void) | undefined;

// ---------------------------------------------------------------------------------------------
// Session internals

/** Bumped whenever pending async work (timers, a puzzle request) becomes stale. */
let gen = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let unwatchGame: (() => void) | null = null;
let unwatchLocks: (() => void) | null = null;
let releaseAnalysis: (() => void) | null = null;
/** True while the store itself changes the game store (its own subscriber ignores that). */
let applying = false;
let options: StartOptions = {};
/** The result of the current puzzle was reported (rating/onResult) already. */
let settled = false;

const set = (partial: Partial<PuzzleState>): void => usePuzzleStore.setState(partial);
const get = (): PuzzleStore => usePuzzleStore.getState();

const isActive = (): boolean => {
  const st = get().status;
  return st === 'running' || st === 'done' || st === 'loading';
};

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function cancelPending(): void {
  gen++;
  clearTimer();
}

function schedule(ms: number, fn: () => void): void {
  clearTimer();
  const my = gen;
  timer = setTimeout(() => {
    timer = null;
    if (my !== gen) return;
    fn();
  }, ms);
}

/** Stops watchers, timers and (unless kept for the next puzzle) the analysis pause. */
function teardown(keepAnalysis = false): void {
  cancelPending();
  unwatchGame?.();
  unwatchGame = null;
  unwatchLocks?.();
  unwatchLocks = null;
  if (!keepAnalysis) {
    releaseAnalysis?.();
    releaseAnalysis = null;
  }
}

function apply(fn: () => void): void {
  applying = true;
  try {
    fn();
  } finally {
    applying = false;
  }
}

const moveUci = (m: Pick<MoveRecord, 'from' | 'to' | 'promotion'>): string =>
  `${m.from}${m.to}${m.promotion ?? ''}`;

/** Plays `uci` at the tip of the game store (jumps there first: the user may have stepped back). */
function playOnBoard(uci: string): boolean {
  let ok = false;
  apply(() => {
    const g = useGameStore.getState();
    if (g.ply !== g.moves.length) g.goTo(g.moves.length);
    ok = useGameStore
      .getState()
      .makeMove(uci.slice(0, 2), uci.slice(2, 4), uci.length > 4 ? uci[4] : undefined);
  });
  return ok;
}

/** Cuts the game store back to `n` moves (the wrong move's takeback). */
function truncateBoard(n: number): void {
  apply(() => {
    const g = useGameStore.getState();
    if (g.moves.length > n) useGameStore.setState({ moves: g.moves.slice(0, n), ply: n });
  });
}

function endWithMessage(text: string): void {
  teardown();
  set({ status: 'idle', message: text, wrongOnBoard: false });
}

/** Rating and `onResult`, once per puzzle, at the first terminal event. */
function settle(s: SolverState): void {
  if (settled || !s.result) return;
  settled = true;
  const result = s.result;
  const st = get();
  const p = s.puzzle;
  if (st.rated && p.rating !== undefined) {
    const before = st.rating;
    try {
      const rating = port.settle(p, result === 'solved');
      set({ rating, ratingDelta: Math.round(rating.rating) - Math.round(before.rating) });
    } catch {
      // Storage failure: no rating change this time.
    }
  }
  try {
    options.onResult?.(result, p);
  } catch {
    // A failing consumer must not break the solver.
  }
}

/** Applies a solver event and follows up (timers, settlement, end of the line). */
function dispatch(event: SolverEvent): SolverState | undefined {
  const st = get();
  if (!st.solver || st.status !== 'running') return undefined;
  const next = solutionState(st.solver, event);
  if (next === st.solver) return next;
  set({ solver: next });
  settle(next);
  followUp(next);
  return next;
}

/** Schedules what the phase asks for (app moves, the takeback of a wrong move). */
function followUp(s: SolverState): void {
  switch (s.phase) {
    case 'intro':
      schedule(INTRO_DELAY_MS, step);
      return;
    case 'opponent':
      schedule(REPLY_DELAY_MS, step);
      return;
    case 'showing':
      schedule(SOLUTION_STEP_MS, step);
      return;
    case 'wrong':
      schedule(WRONG_SHOW_MS, takeBackWrong);
      return;
    case 'complete':
      clearTimer();
      set({ status: 'done', wrongOnBoard: false });
      return;
    case 'user':
      clearTimer();
      return;
  }
}

/** The app plays the pending move (intro, reply, solution). */
function step(): void {
  const st = get();
  const s = st.solver;
  if (st.status !== 'running' || !s) return;
  const uci = pendingMove(s);
  if (uci !== undefined && !playOnBoard(uci)) {
    endWithMessage('Puzzle ended: its line is not legal in this position.');
    return;
  }
  dispatch({ type: 'advance' });
}

function takeBackWrong(): void {
  const st = get();
  if (!st.wrongOnBoard || !st.solver) return;
  truncateBoard(st.solver.played.length);
  set({ wrongOnBoard: false });
}

/** Removes a wrong move that is still shown before another action. */
function clearWrongNow(): void {
  if (!get().wrongOnBoard) return;
  clearTimer();
  takeBackWrong();
}

/** Game store changes while a session runs: the user's moves, takebacks, loads. */
function onGameChange(g: GameState, prev: GameState): void {
  if (applying) return;
  const st = get();
  if (st.status !== 'running' && st.status !== 'done') return;
  if (g.headers !== prev.headers || g.startFen !== prev.startFen) {
    endWithMessage('Puzzle ended: another position was loaded.');
    return;
  }
  if (g.moves === prev.moves) return; // navigation
  const s = st.solver;
  if (!s) return;
  if (st.status === 'done') {
    // Exploring after the end: the session is over, the result stays on the panel.
    teardown();
    set({ status: 'idle', wrongOnBoard: false });
    return;
  }
  const n = s.played.length;
  if (s.phase === 'wrong' && st.wrongOnBoard && g.moves.length === n) {
    // The user took the wrong move back (Undo) before the app did.
    clearTimer();
    set({ wrongOnBoard: false });
    return;
  }
  if (s.phase === 'user' && g.moves.length === n + 1 && prev.moves.length === n) {
    const before = s;
    const after = dispatch({ type: 'move', uci: moveUci(g.moves[n]!) });
    if (!after || after === before) {
      // Not accepted as a move of the puzzle (illegal for the solver): take it back.
      truncateBoard(n);
      return;
    }
    if (after.phase === 'wrong') set({ wrongOnBoard: true });
    return;
  }
  endWithMessage('Puzzle ended: the board was changed.');
}

function watch(): void {
  unwatchGame?.();
  unwatchGame = useGameStore.subscribe(onGameChange);
  unwatchLocks?.();
  const onLock = () => {
    if (!isActive()) return;
    const lock = humanGameLockReason();
    if (lock) endWithMessage(`Puzzle ended: ${lockText(lock) ?? 'a game started'}.`);
  };
  const offs = [
    usePlayStore.subscribe(onLock),
    useLiveStore.subscribe(onLock),
    useRoomStore.subscribe(onLock),
  ];
  unwatchLocks = () => offs.forEach((off) => off());
}

/** Message for a refused start, or undefined when a puzzle may start. */
function lockMessage(): string | undefined {
  const lock = humanGameLockReason();
  return lock ? `Puzzles are paused: ${lockText(lock) ?? 'a game runs'}.` : undefined;
}

/** Game-store moves for `uci` from `fen` (stops at the first illegal move). */
function recordsFor(fen: string, line: readonly string[]): MoveRecord[] {
  const chess = new Chess(fen);
  const out: MoveRecord[] = [];
  for (const uci of line) {
    try {
      const m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      out.push({
        san: m.san,
        from: m.from,
        to: m.to,
        fen: m.after,
        ...(m.promotion ? { promotion: m.promotion } : {}),
      });
    } catch {
      break;
    }
  }
  return out;
}

const actions: PuzzleActions = {
  next: async () => {
    const locked = lockMessage();
    if (locked) {
      set({ message: locked });
      return;
    }
    // Keep the analysis paused between two puzzles (no engine flicker).
    teardown(true);
    const my = gen;
    const { filter, rating, difficulty } = get();
    set({ status: 'loading', message: undefined, inputError: undefined, wrongOnBoard: false });
    let puzzle: Puzzle | null | undefined;
    try {
      puzzle = await port.nextPuzzle(filter, rating.rating, difficulty);
    } catch (err) {
      if (my !== gen) return;
      teardown();
      set({
        status: 'empty',
        message: `Could not load a puzzle: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (my !== gen || get().status !== 'loading') return;
    if (!puzzle) {
      teardown();
      set({ status: 'empty', message: NO_MORE_TEXT });
      return;
    }
    get().start(puzzle);
  },

  start: (puzzle, opts = {}) => {
    const locked = lockMessage();
    if (locked) {
      if (get().status === 'loading') {
        teardown();
        set({ status: 'idle' });
      }
      set({ message: locked });
      return;
    }
    // A running drill ends first (it would read the new position as "another position loaded").
    useDrillStore.getState().stop();
    teardown(true);
    options = opts;
    settled = false;
    const solver = initialSolution(puzzle);
    let loaded = false;
    apply(() => {
      loaded = useGameStore.getState().loadFen(puzzle.fen);
      if (loaded) useGameStore.setState({ orientation: solver.userColor });
    });
    if (!loaded) {
      teardown();
      set({ status: 'idle', message: 'This puzzle has an invalid position.' });
      return;
    }
    releaseAnalysis ??= pauseAnalysis(() => {
      const st = get().status;
      return st === 'running' || st === 'loading' || st === 'done';
    });
    watch();
    try {
      port.markSeen(puzzle.id);
    } catch {
      // Not remembered: the puzzle may come again.
    }
    set({
      status: 'running',
      solver,
      rated: opts.rated ?? (puzzle.source === 'lichess' && puzzle.rating !== undefined),
      ratingDelta: undefined,
      wrongOnBoard: false,
      message: undefined,
      inputError: undefined,
    });
    followUp(solver);
  },

  playSan: (san) => {
    const st = get();
    const s = st.solver;
    const text = san.trim();
    if (st.status !== 'running' || !s || s.phase !== 'user' || !text) {
      set({ inputError: 'Wait for your turn.' });
      return false;
    }
    const move = resolveSan(s.fen, text);
    if (!move) {
      set({ inputError: `${text} is not a legal move here.` });
      return false;
    }
    set({ inputError: undefined });
    const g = useGameStore.getState();
    if (g.ply !== g.moves.length) {
      apply(() => g.goTo(g.moves.length));
    }
    // Through the game store like a board move (sound, haptics and the watcher's judgement).
    return useGameStore.getState().makeMove(move.from, move.to, move.promotion);
  },

  hint: () => {
    clearWrongNow();
    dispatch({ type: 'hint' });
  },

  retry: () => {
    clearWrongNow();
    dispatch({ type: 'retry' });
  },

  showSolution: () => {
    clearWrongNow();
    dispatch({ type: 'showSolution' });
  },

  analyse: () => {
    const st = get();
    const s = st.solver;
    if (!s || (st.status !== 'done' && st.status !== 'idle')) return;
    const p = s.puzzle;
    const isPrefix = s.played.every((m, i) => p.moves[i] === m);
    const line = isPrefix ? p.moves : s.played;
    teardown(true);
    apply(() => {
      const game = useGameStore.getState();
      if (game.startFen !== p.fen || game.moves.length === 0) game.loadFen(p.fen);
      const moves = recordsFor(p.fen, line);
      useGameStore.setState({ moves, ply: Math.min(s.played.length, moves.length) });
    });
    set({ status: 'idle', wrongOnBoard: false, message: undefined });
    releaseAnalysis?.();
    releaseAnalysis = null;
    useUiStore.getState().setActiveTab('moves');
  },

  stop: (message) => {
    const st = get();
    if (st.status === 'idle' && releaseAnalysis === null) {
      if (message !== undefined) set({ message });
      return;
    }
    teardown();
    set({
      status: 'idle',
      wrongOnBoard: false,
      ...(message !== undefined ? { message } : {}),
    });
  },

  setDifficulty: (difficulty) => {
    set({ difficulty });
    try {
      port.saveDifficulty(difficulty);
    } catch {
      // Not remembered.
    }
  },

  setFilter: (filter) => {
    set({ filter });
    try {
      port.saveFilter(filter);
    } catch {
      // Not remembered.
    }
  },
};

export const usePuzzleStore = create<PuzzleStore>()(() => ({
  status: 'idle',
  rating: { ...GLICKO_DEFAULT, n: 0 },
  rated: false,
  difficulty: 'normal',
  filter: {},
  wrongOnBoard: false,
  ...actions,
}));

/** Who may move on the board during a session (see `Board.movableColor`); undefined = no session. */
export function puzzleMovableColor(
  s: Pick<PuzzleState, 'status' | 'solver' | 'wrongOnBoard'>,
  atTip: boolean,
): 'white' | 'black' | null | undefined {
  if (s.status === 'loading') return null;
  if (s.status !== 'running' || !s.solver) return undefined;
  return s.solver.phase === 'user' && atTip && !s.wrongOnBoard ? s.solver.userColor : null;
}

/** Board marks: the wrong move (red arrow) and the hinted piece (green circle). */
export function puzzleMarks(
  s: Pick<PuzzleState, 'status' | 'solver'>,
): { orig: string; dest?: string; brush: string }[] {
  if (s.status !== 'running' || !s.solver) return [];
  const out: { orig: string; dest?: string; brush: string }[] = [];
  const w = s.solver.wrongMove;
  if (s.solver.phase === 'wrong' && w)
    out.push({ orig: w.slice(0, 2), dest: w.slice(2, 4), brush: 'red' });
  if (s.solver.hint) out.push({ orig: s.solver.hint, brush: 'green' });
  return out;
}

/** Uses `next` for the data and reads rating, difficulty and filter from it. */
function installPort(next: PuzzlePort): void {
  unsubscribePort?.();
  port = next;
  const stored = next.load();
  usePuzzleStore.setState({
    rating: stored.rating,
    difficulty: stored.difficulty,
    filter: stored.filter,
  });
  unsubscribePort = next.subscribe?.((rating) => {
    if (rating.rating !== get().rating.rating || rating.rd !== get().rating.rd) {
      usePuzzleStore.setState({ rating, ratingDelta: undefined });
    }
  });
}

/** Test seam: ends any session and installs `next` (the app's port by default). */
export function resetPuzzleStore(next: PuzzlePort = appPort()): void {
  teardown();
  options = {};
  settled = false;
  usePuzzleStore.setState({
    status: 'idle',
    solver: undefined,
    ratingDelta: undefined,
    rated: false,
    wrongOnBoard: false,
    message: undefined,
    inputError: undefined,
  });
  installPort(next);
}

installPort(port);
