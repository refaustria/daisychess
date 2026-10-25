import { create } from 'zustand';
import {
  afterMove,
  createClock,
  engineMoveTime,
  runSide,
  tick,
  type ClockSide,
  type GameClock,
} from '../clock/gameClock';
import { sanitizeSetting, type ClockSetting } from '../clock/timeControls';
import { PremoveQueue } from '../live/premoves';
import { browserEnginePool, PooledEngine } from '../engine/wasmPool';
import { useAnalysisStore } from '../store/analysisStore';
import { useSettingsStore } from '../store/settingsStore';
import {
  currentFen,
  START_FEN,
  useGameStore,
  type GameState,
  type MoveRecord,
  type Orientation,
} from '../store/gameStore';
import {
  atTip,
  gameOutcome,
  REASON_TEXT,
  type EndReason,
  type GameResult,
  type Outcome,
} from './outcome';
import { PlayController, type CreatePlayEngine, type PlayConfig } from './PlayController';
import { DEFAULT_MOVE_TIME, DEFAULT_STRENGTH, findStrength, MOVE_TIMES } from './strength';

export type PlayMode = 'idle' | 'playing' | 'finished';
export type ColorChoice = Orientation | 'random';

export interface PlaySetup {
  color: ColorChoice;
  /** Id of a {@link STRENGTH_PRESETS} entry. */
  strength: string;
  /** Engine thinking time per move (ms); with a clock the upper bound (see `engineMoveTime`). */
  moveTime: number;
  /** Clock of both sides; null (or missing) = no clock. */
  timeControl?: ClockSetting | null;
  /**
   * `start` (default): a new game from the initial position. `current`: continues from the
   * position shown on the board, keeping the moves so far (later ones are discarded).
   */
  from?: PlayFrom;
}

export type PlayFrom = 'start' | 'current';

/** The game's base: where the played-out part begins (snapshot, used by rematch). */
export interface PlayBase {
  startFen: string;
  moves: MoveRecord[];
  headers: Record<string, string>;
}

export interface PlayState {
  mode: PlayMode;
  /** The user's colour in the current/last game. */
  playerColor: Orientation;
  /** Last setup (also used by rematch). */
  setup: PlaySetup;
  result?: GameResult;
  reason?: EndReason;
  /** Error text for `reason: 'engine_error'`, or why a game could not start (a live game runs). */
  message?: string;
  /** True while the engine has the move. */
  thinking: boolean;
  /** The user's premoves (UCI), played one per turn (settings `premoves`). */
  premoves: string[];
  /** The game's clock (null without a time control); stopped when the game is finished. */
  clock: GameClock | null;
  /** Number of plies that belong to the base (opening line) of this game; takebacks stop there. */
  fromPly: number;
  /** Snapshot of the base position (start FEN + moves + headers) of this game, for rematch. */
  base: PlayBase | null;
}

export interface PlayActions {
  /**
   * Orients the board for the player and starts a game against the engine, from the initial
   * position or (`from: 'current'`) from the position on the board, keeping the moves so far.
   * A terminal position cannot be started (`message` is set instead).
   */
  start(setup?: Partial<PlaySetup>): void;
  /** Changes the setup (sanitized, persisted in localStorage `chesslab.play`). */
  setSetup(setup: Partial<PlaySetup>): void;
  /**
   * Charges the running clock up to `now` (monotonic ms, default `performance.now()`) and ends
   * the game when a side runs out of time. Called every {@link CLOCK_TICK_MS} while a clock runs.
   */
  tick(now?: number): void;
  resign(): void;
  /** Takes back the user's last move (and the engine's reply); see {@link takeBackPlies}. */
  takeBack(): void;
  /** Ends/leaves the game and returns to the setup. */
  stop(): void;
  /** A new game with the same setup. */
  rematch(): void;
  /** Adds a premove while the engine thinks (replaces it in `single` mode, ignored in `none`). */
  addPremove(uci: string): void;
  clearPremoves(): void;
}

export type PlayStore = PlayState & PlayActions;

/**
 * How many plies a takeback removes: back to the user's previous turn (2 plies when it is the
 * user's turn, 1 while the engine still has to answer). 0 when the user has not moved yet;
 * never goes below `fromPly` (the base of a game started from a position).
 */
export function takeBackPlies(
  g: Pick<GameState, 'startFen' | 'moves' | 'ply'>,
  playerColor: Orientation,
  fromPly = 0,
): number {
  const toMove = currentFen(atTip(g)).split(' ')[1] === 'b' ? 'black' : 'white';
  const n = toMove === playerColor ? 2 : 1;
  // The moves of the base (opening line) are not the user's to take back.
  return g.moves.length - Math.max(0, fromPly) >= n ? n : 0;
}

/**
 * The engine plays on the shared browser engine of the review/drill (ADR-015): each move leases
 * it (strength options applied per lease, `UCI_LimitStrength` switched off again afterwards), so a
 * game never adds a WASM instance. Same build/threads as the registry: multi-threaded `lite` with
 * max(1, min(cores - 1, 4)) threads (memory budget cap) when cross-origin isolated, else
 * `lite-single`.
 */
const createWasmPlayEngine: CreatePlayEngine = () =>
  new PooledEngine(browserEnginePool, { purpose: 'play', restore: { UCI_LimitStrength: false } });

interface PlayHooks {
  createEngine: CreatePlayEngine;
  extraDelayMs?: () => number;
  idleDisposeMs?: number;
  random: () => number;
  /** Monotonic clock source (ms). */
  now: () => number;
}

/** Interval of the clock ticker (display and flag detection; the time itself is exact). */
export const CLOCK_TICK_MS = 100;
export const PLAY_STORAGE_KEY = 'chesslab.play';

/**
 * Returns a reason why a local engine game must not start (a live lichess game or a game against
 * a friend runs), or null. Registered by the live store (`live/liveStore.ts`) and the room store
 * (`room/roomStore.ts`), which keeps this module free of an import cycle; the shared rule for the
 * UI is `live/lock.ts`.
 */
export type PlayStartGuard = () => string | null;
const startGuards = new Map<string, PlayStartGuard>();

/** Registers (or replaces) the guard named `name`. */
export function setPlayStartGuard(guard: PlayStartGuard, name = 'live'): void {
  startGuards.set(name, guard);
}

function startGuard(): string | null {
  for (const g of startGuards.values()) {
    const r = g();
    if (r) return r;
  }
  return null;
}

const monotonicNow = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

let hooks: PlayHooks = {
  createEngine: createWasmPlayEngine,
  random: Math.random,
  now: monotonicNow,
};
let controller: PlayController | null = null;
let pagehideBound = false;
/** True while the live analysis is switched off by the play store. */
let analysisSuspended = false;
let unwatchAnalysis: (() => void) | null = null;
let unwatchGame: (() => void) | null = null;
let premoveQueue: PremoveQueue | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;

const toSide = (c: Orientation): ClockSide => (c === 'white' ? 'w' : 'b');
const tipTurn = (g: Pick<GameState, 'startFen' | 'moves' | 'ply'>): ClockSide =>
  currentFen(atTip(g)).split(' ')[1] === 'b' ? 'b' : 'w';

/** Runs the ticker while a clock runs (one interval at most). */
function syncTicker(): void {
  const c = usePlayStore.getState().clock;
  const want = usePlayStore.getState().mode === 'playing' && c !== null && c.runningSide !== null;
  if (want && ticker === null)
    ticker = setInterval(() => usePlayStore.getState().tick(), CLOCK_TICK_MS);
  else if (!want && ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** Applies a clock transition; a flag ends the game (the other side wins). */
function setClock(next: GameClock | null): void {
  if (next === usePlayStore.getState().clock) return;
  usePlayStore.setState({ clock: next });
  if (next?.flagged && usePlayStore.getState().mode === 'playing') {
    finish({ result: next.flagged === 'w' ? '0-1' : '1-0', reason: 'timeout' });
    return;
  }
  syncTicker();
}

const engineSideOf = (s: Pick<PlayState, 'playerColor'>): ClockSide =>
  s.playerColor === 'white' ? 'b' : 'w';

/**
 * The engine's clock runs only while it searches: it starts when the search starts (loading the
 * WASM engine for the first move is not charged) and stops when the move is ready.
 */
function engineSearchStarts(): void {
  const s = usePlayStore.getState();
  if (s.mode !== 'playing' || !s.clock || s.clock.flagged) return;
  if (s.clock.runningSide === null) setClock(runSide(s.clock, engineSideOf(s), hooks.now()));
}

/** Clock after the tip changed: the engine's side waits for its search to start. */
function holdEngine(c: GameClock): GameClock {
  const s = usePlayStore.getState();
  return c.runningSide === engineSideOf(s) ? { ...c, runningSide: null } : c;
}

/** The engine has its move: its clock stops (it is not charged while the user browses back). */
function engineMoveReady(): void {
  const s = usePlayStore.getState();
  if (s.mode !== 'playing' || !s.clock) return;
  if (s.clock.runningSide !== toSide(s.playerColor)) setClock(runSide(s.clock, null, hooks.now()));
}

/** Controller config for the current setup; with a clock the search time follows it. */
function playConfig(playerColor: Orientation, setup: PlaySetup): PlayConfig {
  const config: PlayConfig = {
    playerColor,
    strength: findStrength(setup.strength),
    moveTime: setup.moveTime,
  };
  if (setup.timeControl) {
    const engineSide: ClockSide = playerColor === 'white' ? 'b' : 'w';
    config.searchTime = () => {
      const c = usePlayStore.getState().clock;
      if (!c) return setup.moveTime;
      const t = tick(c, hooks.now());
      return engineMoveTime(setup.moveTime, t[engineSide], t.incrementMs);
    };
  }
  return config;
}

function startPremoves(): void {
  premoveQueue?.dispose();
  premoveQueue = new PremoveQueue({
    game: useGameStore,
    color: () =>
      usePlayStore.getState().mode === 'playing' ? usePlayStore.getState().playerColor : null,
    mode: () => useSettingsStore.getState().premoves,
    onChange: (list) => usePlayStore.setState({ premoves: [...list] }),
  });
}

function stopPremoves(): void {
  premoveQueue?.dispose();
  premoveQueue = null;
  if (usePlayStore.getState().premoves.length) usePlayStore.setState({ premoves: [] });
}

function suspendAnalysis(): void {
  const analysis = useAnalysisStore.getState();
  if (analysis.enabled) {
    analysis.setEnabled(false);
    analysisSuspended = true;
  }
  // Never two engines at once: switching the live analysis on during a game is deferred to its end.
  unwatchAnalysis ??= useAnalysisStore.subscribe((s) => {
    if (s.enabled && usePlayStore.getState().mode === 'playing') {
      analysisSuspended = true;
      s.setEnabled(false);
    }
  });
}

function restoreAnalysis(): void {
  unwatchAnalysis?.();
  unwatchAnalysis = null;
  if (!analysisSuspended) return;
  analysisSuspended = false;
  if (!useAnalysisStore.getState().enabled) useAnalysisStore.getState().setEnabled(true);
}

function getController(): PlayController {
  if (!controller) {
    controller = new PlayController({
      game: useGameStore,
      createEngine: hooks.createEngine,
      extraDelayMs: hooks.extraDelayMs,
      idleDisposeMs: hooks.idleDisposeMs,
      onThinking: (thinking) => usePlayStore.setState({ thinking }),
      onMoveReady: engineMoveReady,
      onSearchStart: engineSearchStarts,
      onGameOver: (outcome) => finish(outcome),
      onError: (message) => finish({ reason: 'engine_error' }, message),
    });
  }
  if (!pagehideBound && typeof window !== 'undefined') {
    pagehideBound = true;
    window.addEventListener('pagehide', () => void controller?.dispose());
    // Back from the bfcache: the engine was disposed on pagehide, so pick the game up again.
    window.addEventListener('pageshow', (e) => {
      const s = usePlayStore.getState();
      if (e.persisted && s.mode === 'playing') {
        controller?.start(playConfig(s.playerColor, s.setup));
      }
    });
  }
  return controller;
}

/**
 * Ends the game when the game store is reset or a position/PGN is loaded (New game, loadFen,
 * loadPgn, Import): those replace `headers` and/or `startFen`, ordinary moves, takebacks and
 * navigation do not.
 */
function watchGame(): void {
  unwatchGame?.();
  unwatchGame = useGameStore.subscribe((s, prev) => {
    if (usePlayStore.getState().mode !== 'playing') return;
    if (s.headers !== prev.headers || s.startFen !== prev.startFen) {
      finish({ reason: 'aborted' });
      return;
    }
    if (s.moves !== prev.moves) onMovesChanged(s, prev);
  });
}

/**
 * Clock transitions on a change of the game's tip: one move appended = the mover pressed the
 * clock (increment, opponent's clock starts); anything else (takeback, a move on an earlier
 * ply) just runs the clock of the side to move, without increment.
 */
function onMovesChanged(s: GameState, prev: GameState): void {
  const c = usePlayStore.getState().clock;
  if (!c) return;
  const now = hooks.now();
  const n = prev.moves.length;
  const appended = s.moves.length === n + 1 && (n === 0 || s.moves[n - 1] === prev.moves[n - 1]);
  setClock(holdEngine(appended ? afterMove(c, tipTurn(prev), now) : runSide(c, tipTurn(s), now)));
}

function finish(outcome: Outcome, message?: string): void {
  unwatchGame?.();
  unwatchGame = null;
  stopPremoves();
  controller?.stop();
  const c = usePlayStore.getState().clock;
  usePlayStore.setState({
    clock: c && c.runningSide !== null ? runSide(c, null, hooks.now()) : c,
    mode: 'finished',
    result: outcome.result,
    reason: outcome.reason,
    message,
    thinking: false,
  });
  syncTicker();
  restoreAnalysis();
}

/** Test seam: replaces the engine factory etc. and disposes the current controller. */
export async function configurePlay(next: Partial<PlayHooks>): Promise<void> {
  await resetPlay();
  hooks = { ...hooks, ...next };
}

/** Stops any game, disposes the engine and restores the defaults of the store (tests). */
export async function resetPlay(): Promise<void> {
  unwatchGame?.();
  unwatchGame = null;
  stopPremoves();
  const c = controller;
  controller = null;
  if (c) await c.dispose();
  restoreAnalysis();
  usePlayStore.setState({
    mode: 'idle',
    result: undefined,
    reason: undefined,
    message: undefined,
    thinking: false,
    clock: null,
    fromPly: 0,
    base: null,
  });
  syncTicker();
}

const sanitizeSetup = (s: PlaySetup): PlaySetup => ({
  color: s.color === 'black' || s.color === 'random' ? s.color : 'white',
  strength: findStrength(s.strength).id,
  moveTime: MOVE_TIMES.some((t) => t.ms === s.moveTime) ? s.moveTime : DEFAULT_MOVE_TIME,
  timeControl: sanitizeSetting(s.timeControl),
  from: s.from === 'current' ? 'current' : 'start',
});

const DEFAULT_SETUP: PlaySetup = {
  color: 'white',
  strength: DEFAULT_STRENGTH,
  moveTime: DEFAULT_MOVE_TIME,
  timeControl: null,
  from: 'start',
};

/** The last setup from localStorage `chesslab.play` (defaults when missing or invalid). */
export function readPlaySetup(): PlaySetup {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(PLAY_STORAGE_KEY);
    if (!raw) return DEFAULT_SETUP;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return DEFAULT_SETUP;
    return sanitizeSetup({ ...DEFAULT_SETUP, ...(v as Partial<PlaySetup>) });
  } catch {
    return DEFAULT_SETUP;
  }
}

function writePlaySetup(setup: PlaySetup): void {
  try {
    localStorage.setItem(PLAY_STORAGE_KEY, JSON.stringify(setup));
  } catch {
    // Storage full or blocked: the setup just is not remembered.
  }
}

export const usePlayStore = create<PlayStore>()((set, get) => ({
  mode: 'idle',
  playerColor: 'white',
  setup: readPlaySetup(),
  thinking: false,
  premoves: [],
  clock: null,
  fromPly: 0,
  base: null,

  start: (partial) => {
    const blocked = startGuard();
    if (blocked) {
      set({ message: blocked });
      return;
    }
    const setup = sanitizeSetup({ ...get().setup, ...partial });
    writePlaySetup(setup);
    const playerColor: Orientation =
      setup.color === 'random' ? (hooks.random() < 0.5 ? 'white' : 'black') : setup.color;
    const ctl = getController();
    let base: PlayBase;
    if (setup.from === 'current') {
      const cur = useGameStore.getState();
      base = { startFen: cur.startFen, moves: cur.moves.slice(0, cur.ply), headers: cur.headers };
      const end = gameOutcome({
        startFen: base.startFen,
        moves: base.moves,
        ply: base.moves.length,
      });
      if (end) {
        set({ setup, message: `This position is already over (${REASON_TEXT[end.reason]}).` });
        return;
      }
    } else {
      base = { startFen: START_FEN, moves: [], headers: {} };
    }
    ctl.stop();
    if (setup.from === 'current') {
      // Same startFen/headers objects: the game watcher (started below) sees no replacement.
      useGameStore.setState({
        moves: base.moves,
        ply: base.moves.length,
        orientation: playerColor,
      });
    } else {
      useGameStore.getState().reset();
      useGameStore.setState({ orientation: playerColor });
    }
    suspendAnalysis();
    watchGame();
    startPremoves();
    set({
      mode: 'playing',
      playerColor,
      setup,
      result: undefined,
      reason: undefined,
      message: undefined,
      thinking: false,
      fromPly: base.moves.length,
      base,
      clock: setup.timeControl ? createClock(setup.timeControl, hooks.now()) : null,
    });
    // The user's clock starts now when they have White; the engine's when its search starts.
    const c = get().clock;
    if (c && tipTurn(useGameStore.getState()) === toSide(playerColor)) {
      set({ clock: runSide(c, toSide(playerColor), hooks.now()) });
    }
    syncTicker();
    ctl.start(playConfig(playerColor, setup));
  },

  setSetup: (partial) => {
    const setup = sanitizeSetup({ ...get().setup, ...partial });
    set({ setup });
    writePlaySetup(setup);
  },

  tick: (now) => {
    const c = get().clock;
    if (!c || get().mode !== 'playing') return;
    setClock(tick(c, now ?? hooks.now()));
  },

  resign: () => {
    const s = get();
    if (s.mode !== 'playing') return;
    finish({ result: s.playerColor === 'white' ? '0-1' : '1-0', reason: 'resign' });
  },

  takeBack: () => {
    const s = get();
    if (s.mode !== 'playing') return;
    const g = useGameStore.getState();
    const n = takeBackPlies(g, s.playerColor, s.fromPly);
    if (n === 0) return;
    premoveQueue?.clear();
    controller?.cancel();
    // One store update, so the controller never sees the intermediate (engine-to-move) position.
    const len = g.moves.length - n;
    useGameStore.setState({ moves: g.moves.slice(0, len), ply: len });
  },

  stop: () => {
    unwatchGame?.();
    unwatchGame = null;
    stopPremoves();
    controller?.stop();
    set({
      mode: 'idle',
      result: undefined,
      reason: undefined,
      message: undefined,
      thinking: false,
      clock: null,
    });
    syncTicker();
    restoreAnalysis();
  },

  rematch: () => {
    const { setup, base } = get();
    if (setup.from === 'current' && base) {
      if (startGuard()) return get().start(setup); // sets the guard's message
      // Back to the same base position (the finished game's moves are replaced).
      useGameStore.setState({
        startFen: base.startFen,
        moves: base.moves,
        ply: base.moves.length,
        headers: base.headers,
      });
    }
    get().start(setup);
  },

  addPremove: (uci) => {
    if (get().mode === 'playing') premoveQueue?.add(uci);
  },

  clearPremoves: () => premoveQueue?.clear(),
}));
