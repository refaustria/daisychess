import { create } from 'zustand';
import { useAnalysisStore } from '../store/analysisStore';
import { currentFen, useGameStore, type GameState, type Orientation } from '../store/gameStore';
import { atTip, type EndReason, type GameResult, type Outcome } from './outcome';
import { PlayController, type CreatePlayEngine } from './PlayController';
import { DEFAULT_MOVE_TIME, DEFAULT_STRENGTH, findStrength, MOVE_TIMES } from './strength';

export type PlayMode = 'idle' | 'playing' | 'finished';
export type ColorChoice = Orientation | 'random';

export interface PlaySetup {
  color: ColorChoice;
  /** Id of a {@link STRENGTH_PRESETS} entry. */
  strength: string;
  /** Engine thinking time per move (ms). */
  moveTime: number;
}

export interface PlayState {
  mode: PlayMode;
  /** The user's colour in the current/last game. */
  playerColor: Orientation;
  /** Last setup (also used by rematch). */
  setup: PlaySetup;
  result?: GameResult;
  reason?: EndReason;
  /** Error text for `reason: 'engine_error'`. */
  message?: string;
  /** True while the engine has the move. */
  thinking: boolean;
}

export interface PlayActions {
  /** Resets the board, orients it for the player and starts a game against the engine. */
  start(setup?: Partial<PlaySetup>): void;
  resign(): void;
  /** Takes back the user's last move (and the engine's reply); see {@link takeBackPlies}. */
  takeBack(): void;
  /** Ends/leaves the game and returns to the setup. */
  stop(): void;
  /** A new game with the same setup. */
  rematch(): void;
}

export type PlayStore = PlayState & PlayActions;

/**
 * How many plies a takeback removes: back to the user's previous turn (2 plies when it is the
 * user's turn, 1 while the engine still has to answer). 0 when the user has not moved yet.
 */
export function takeBackPlies(
  g: Pick<GameState, 'startFen' | 'moves' | 'ply'>,
  playerColor: Orientation,
): number {
  const toMove = currentFen(atTip(g)).split(' ')[1] === 'b' ? 'black' : 'white';
  const n = toMove === playerColor ? 2 : 1;
  return g.moves.length >= n ? n : 0;
}

const createWasmPlayEngine: CreatePlayEngine = async () => {
  const { WasmEngineClient } = await import('../engine/WasmEngineClient');
  // Same build/threads selection as the registry: multi-threaded `lite` with
  // max(1, min(cores - 1, 4)) threads when cross-origin isolated, `lite-single` otherwise.
  return new WasmEngineClient();
};

interface PlayHooks {
  createEngine: CreatePlayEngine;
  extraDelayMs?: () => number;
  idleDisposeMs?: number;
  random: () => number;
}

let hooks: PlayHooks = { createEngine: createWasmPlayEngine, random: Math.random };
let controller: PlayController | null = null;
let pagehideBound = false;
/** True while the live analysis is switched off by the play store. */
let analysisSuspended = false;
let unwatchAnalysis: (() => void) | null = null;
let unwatchGame: (() => void) | null = null;

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
        controller?.start({
          playerColor: s.playerColor,
          strength: findStrength(s.setup.strength),
          moveTime: s.setup.moveTime,
        });
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
    if (s.headers !== prev.headers || s.startFen !== prev.startFen) finish({ reason: 'aborted' });
  });
}

function finish(outcome: Outcome, message?: string): void {
  unwatchGame?.();
  unwatchGame = null;
  controller?.stop();
  usePlayStore.setState({
    mode: 'finished',
    result: outcome.result,
    reason: outcome.reason,
    message,
    thinking: false,
  });
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
  });
}

const sanitizeSetup = (s: PlaySetup): PlaySetup => ({
  color: s.color === 'black' || s.color === 'random' ? s.color : 'white',
  strength: findStrength(s.strength).id,
  moveTime: MOVE_TIMES.some((t) => t.ms === s.moveTime) ? s.moveTime : DEFAULT_MOVE_TIME,
});

export const usePlayStore = create<PlayStore>()((set, get) => ({
  mode: 'idle',
  playerColor: 'white',
  setup: { color: 'white', strength: DEFAULT_STRENGTH, moveTime: DEFAULT_MOVE_TIME },
  thinking: false,

  start: (partial) => {
    const setup = sanitizeSetup({ ...get().setup, ...partial });
    const playerColor: Orientation =
      setup.color === 'random' ? (hooks.random() < 0.5 ? 'white' : 'black') : setup.color;
    const ctl = getController();
    ctl.stop();
    const game = useGameStore.getState();
    game.reset();
    useGameStore.setState({ orientation: playerColor });
    suspendAnalysis();
    watchGame();
    set({
      mode: 'playing',
      playerColor,
      setup,
      result: undefined,
      reason: undefined,
      message: undefined,
      thinking: false,
    });
    ctl.start({ playerColor, strength: findStrength(setup.strength), moveTime: setup.moveTime });
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
    const n = takeBackPlies(g, s.playerColor);
    if (n === 0) return;
    controller?.cancel();
    // One store update, so the controller never sees the intermediate (engine-to-move) position.
    const len = g.moves.length - n;
    useGameStore.setState({ moves: g.moves.slice(0, len), ply: len });
  },

  stop: () => {
    unwatchGame?.();
    unwatchGame = null;
    controller?.stop();
    set({
      mode: 'idle',
      result: undefined,
      reason: undefined,
      message: undefined,
      thinking: false,
    });
    restoreAnalysis();
  },

  rematch: () => get().start(get().setup),
}));
