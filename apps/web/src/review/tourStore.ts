import { create } from 'zustand';
import { isHumanGameRunning } from '../live/lock';
import { useGameStore, type GameState } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { useReviewStore } from './reviewStore';
import {
  buildSchedule,
  highlightText,
  TourController,
  type TourStatus,
  type TourStep,
  type TourTimer,
} from './tour';
import { timeTroublePlies } from './timeUsage';

/** Identity of the game on the board (start position + moves). */
export function gameKey(s: Pick<GameState, 'startFen' | 'moves'>): string {
  return `${s.startFen}|${s.moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).join(' ')}`;
}

interface TourStore {
  status: TourStatus;
  /** Highlights in the game / reached so far (including the current step). */
  total: number;
  reached: number;
  /** Text of the current step if it is a highlight, else ''. */
  text: string;
  /** Games that already got an automatic tour this session. */
  started: ReadonlySet<string>;
  /** Starts the tour for the reviewed game on the board (manual replay or automatic). */
  start(): void;
  pause(): void;
  resume(): void;
  skip(): void;
  stop(): void;
}

let controller: TourController | undefined;
/** The ply the tour itself set last; any other change of the game is the user's. */
let tourPly: number | null = null;
let timer: TourTimer | undefined;

/** Test hook: replaces the timer used by tours started afterwards. */
export function setTourTimer(t: TourTimer | undefined): void {
  timer = t;
}

export const useTourStore = create<TourStore>()((set, get) => ({
  status: 'idle',
  total: 0,
  reached: 0,
  text: '',
  started: new Set(),
  start: () => {
    const review = useReviewStore.getState();
    const game = useGameStore.getState();
    const { summary, moveDetails } = review;
    if (review.status !== 'done' || !summary || game.moves.length === 0) return;
    if (summary.moves.length !== game.moves.length) return;
    controller?.stop();
    const schedule = buildSchedule(summary);
    const trouble = timeTroublePlies(game, summary);
    const notable = schedule.filter((s) => s.kind);
    const reachedAt = (i: number) => schedule.slice(0, i + 1).filter((s) => s.kind).length;
    const c = new TourController(
      schedule,
      {
        onStep: (step: TourStep, i: number) => {
          tourPly = step.ply;
          useGameStore.getState().goTo(step.ply);
          set({ reached: reachedAt(i), text: step.kind ? highlightText(moveDetails, step, trouble) : '' });
        },
        onStatus: (status) => {
          if (status === 'playing' || status === 'paused') {
            set({ status });
          } else {
            tourPly = null;
            set({ status });
          }
        },
      },
      timer,
    );
    controller = c;
    set({
      total: notable.length,
      reached: 0,
      text: '',
      started: new Set(get().started).add(gameKey(game)),
    });
    c.start();
  },
  pause: () => controller?.pause(),
  resume: () => controller?.resume(),
  skip: () => controller?.skip(),
  stop: () => controller?.stop(),
}));

/**
 * Wires the tour: starts it once per game when its review is done (computed or cached) and the
 * Review tab is showing, and stops it on any navigation the tour did not cause (game store
 * `ply`/`moves`/start position) or when the user leaves the Review tab. Returns the unsubscribe.
 */
export function installReviewTour(): () => void {
  const unwatchReview = useReviewStore.subscribe((s, prev) => {
    if (s.status !== 'done' || prev.status === 'done') return;
    if (!useSettingsStore.getState().reviewTour) return;
    if (useUiStore.getState().activeTab !== 'review') return;
    if (isHumanGameRunning()) return;
    const tour = useTourStore.getState();
    if (tour.started.has(gameKey(useGameStore.getState()))) return;
    tour.start();
  });
  const unwatchGame = useGameStore.subscribe((s, prev) => {
    const { status } = useTourStore.getState();
    if (status !== 'playing' && status !== 'paused') return;
    const external =
      s.moves !== prev.moves ||
      s.startFen !== prev.startFen ||
      (s.ply !== prev.ply && s.ply !== tourPly);
    if (external) useTourStore.getState().stop();
  });
  const unwatchUi = useUiStore.subscribe((s, prev) => {
    if (s.activeTab !== prev.activeTab && s.activeTab !== 'review') useTourStore.getState().stop();
  });
  const unwatchReviewReset = useReviewStore.subscribe((s, prev) => {
    if (prev.status === 'done' && s.status !== 'done') useTourStore.getState().stop();
  });
  return () => {
    unwatchReview();
    unwatchGame();
    unwatchUi();
    unwatchReviewReset();
    controller?.stop();
  };
}
