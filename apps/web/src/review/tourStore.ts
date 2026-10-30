import { create } from 'zustand';
import { isHumanGameRunning } from '../live/lock';
import { findOpening, getBook, loadOpenings, toEpd } from '../openings';
import { familyTextFor, loadFamilyTexts } from '../openings/familyTexts';
import type { Side } from '../puzzles/userSide';
import { START_FEN, useGameStore, type GameState } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { maiaHintAt } from '../maia/hintStore';
import { hintShortText } from '../maia/hintText';
import type { MoveDetails } from './details';
import { computeOpeningFocus } from './openingFocus';
import { openingStopCard } from './openingStop';
import { gameKey as reviewGameKey } from './reviewCache';
import { gameToBatch, useReviewStore } from './reviewStore';
import { timeTroublePlies } from './timeUsage';
import {
  buildSchedule,
  highlightText,
  stopNumber,
  tourActive,
  TourController,
  type TourCard,
  type TourStatus,
  type TourStep,
  type TourTimer,
} from './tour';
import { reviewUserSide, switchReviewSide } from './userSide';

/** Identity of the game on the board (start position + moves). */
export function gameKey(s: Pick<GameState, 'startFen' | 'moves'>): string {
  return `${s.startFen}|${s.moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).join(' ')}`;
}

/** The game's key in the review cache and the puzzles ledger (where the user's side is kept). */
function ledgerKey(s: Pick<GameState, 'startFen' | 'moves'>): string {
  const batch = gameToBatch(s);
  return reviewGameKey(
    batch.startFen,
    batch.moves.map((m) => m.uci),
  );
}

interface TourStore {
  status: TourStatus;
  /** Stops in the game / the number of the stop reached so far ("Stop n of N"). */
  total: number;
  reached: number;
  /** Text of the current step if it is a highlight or a mistake stop, else ''. */
  text: string;
  /** Content of the current stop; undefined on the other steps. */
  card: TourCard | undefined;
  /** The side whose mistakes are stops (ADR-024 section 2); undefined before the first start. */
  userSide: Side | undefined;
  /** Games that already got an automatic tour this session. */
  started: ReadonlySet<string>;
  /**
   * Starts the tour for the reviewed game on the board (manual replay or automatic). Async: the
   * user's side and the opening book are resolved first; `side` overrides the resolution.
   */
  start(side?: Side): Promise<void>;
  /** Continues from a stop (or steps once while playing/paused). */
  next(): void;
  pause(): void;
  resume(): void;
  skip(): void;
  stop(): void;
  /** Stores the other side as the user's (ledger) and restarts the tour with its stops. */
  switchSide(): Promise<void>;
}

let controller: TourController | undefined;
/** The ply the tour itself set last; any other change of the game is the user's. */
let tourPly: number | null = null;
let timer: TourTimer | undefined;
/** Bumped by every start and stop: a start that resolves after a newer one/stop is dropped. */
let startGen = 0;

type UserSideResolver = (game: GameState, ledgerKey: string) => Promise<Side>;
const defaultUserSide: UserSideResolver = (game, key) => reviewUserSide(game, key);
let userSideResolver: UserSideResolver = defaultUserSide;

/** Test hook: replaces the timer used by tours started afterwards. */
export function setTourTimer(t: TourTimer | undefined): void {
  timer = t;
}

/** Test hook: replaces the user's side resolution (default `reviewUserSide`, ADR-024 §2). */
export function setTourUserSide(fn: UserSideResolver | undefined): void {
  userSideResolver = fn ?? defaultUserSide;
}

const afterRender = (fn: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 0);
};

function isTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName !== 'INPUT') return false;
  const type = (el as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(
    type,
  );
}

/** The first rendered (laid out) element of `testId`, else the first one in the DOM (jsdom). */
function visibleByTestId(testId: string): HTMLElement | undefined {
  const all = [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)];
  return all.find((el) => el.getClientRects().length > 0) ?? all[0];
}

/**
 * Moves the focus to the visible "Next" of the tour (the tour bar's on desktop, the action bar's
 * on phones) after the render, unless the user is typing in a text field.
 */
export function focusTourNext(): void {
  afterRender(() => {
    if (useTourStore.getState().status !== 'waiting') return;
    if (isTextEntry(document.activeElement)) return;
    visibleByTestId('tour-next')?.focus();
  });
}

/**
 * Returns the focus to "Replay tour" after the tour ended, when it was on a tour control that
 * disappeared (or nowhere); never takes it from where the user moved it.
 */
export function focusTourReplay(): void {
  const active = document.activeElement;
  const inTour =
    !active ||
    active === document.body ||
    active.closest('[data-testid="review-tour"], [data-testid="action-bar"]') !== null;
  if (!inTour) return;
  afterRender(() => {
    const a = document.activeElement;
    if (a && a !== document.body && !a.closest('[data-testid="review-tour"], [data-testid="action-bar"]'))
      return;
    visibleByTestId('tour-replay')?.focus();
  });
}

/** Text of a highlight step with the Maia suffix ("… — common at 1500"). */
function stepText(
  step: TourStep,
  details: MoveDetails,
  trouble: ReadonlySet<number>,
): string {
  if (!step.kind) return '';
  const text = highlightText(details, step, trouble);
  // Human-like hint (M23-3), when it has arrived by now.
  const short = step.kind !== 'great' ? hintShortText(maiaHintAt(step.ply)) : undefined;
  return short ? `${text} — ${short}` : text;
}

/** Opening card and last book ply of a standard-start game (undefined when unavailable). */
async function openingStop(
  game: GameState,
  details: MoveDetails,
): Promise<{ lastBookPly: number; card: TourCard } | undefined> {
  if (game.startFen !== START_FEN || game.moves.length === 0) return undefined;
  try {
    await loadOpenings();
    await loadFamilyTexts();
  } catch {
    return undefined; // offline chunk failure: a tour without the opening stop
  }
  const book = getBook();
  if (!book) return undefined;
  const sans = game.moves.map((m) => m.san);
  const focus = computeOpeningFocus({
    sans,
    epds: [toEpd(game.startFen), ...game.moves.map((m) => toEpd(m.fen))],
    book,
    findOpening,
    details,
  });
  if (focus.lastBookPly < 1) return undefined;
  const family = focus.openingName
    ? familyTextFor({ name: focus.openingName, eco: focus.eco })
    : undefined;
  return { lastBookPly: focus.lastBookPly, card: openingStopCard(focus, sans, family) };
}

export const useTourStore = create<TourStore>()((set, get) => ({
  status: 'idle',
  total: 0,
  reached: 0,
  text: '',
  card: undefined,
  userSide: undefined,
  started: new Set(),
  start: async (sideOverride) => {
    const review = useReviewStore.getState();
    const game = useGameStore.getState();
    const { summary, moveDetails } = review;
    if (review.status !== 'done' || !summary || game.moves.length === 0) return;
    if (summary.moves.length !== game.moves.length) return;
    const key = gameKey(game);
    const gen = ++startGen;
    set({ started: new Set(get().started).add(key) });

    let side: Side = sideOverride ?? game.orientation;
    if (!sideOverride) {
      try {
        side = await userSideResolver(game, ledgerKey(game));
      } catch {
        side = game.orientation; // ledger unavailable: the side at the bottom of the board
      }
    }
    const opening = await openingStop(game, moveDetails);

    // A newer start, a stop or another game/review while resolving: drop this start.
    const now = useGameStore.getState();
    const r = useReviewStore.getState();
    if (gen !== startGen || gameKey(now) !== key || r.status !== 'done' || r.summary !== summary)
      return;

    const schedule = buildSchedule(summary, {
      userSide: side,
      lastBookPly: opening?.lastBookPly,
      startFen: game.startFen,
    });
    const trouble = timeTroublePlies(game, summary);
    const c = new TourController(
      schedule,
      {
        onStep: (step: TourStep, i: number) => {
          if (controller !== c) return;
          tourPly = step.ply;
          useGameStore.getState().goTo(step.ply);
          const text = stepText(step, moveDetails, trouble);
          let card: TourCard | undefined;
          if (step.stop === 'opening') card = opening?.card;
          else if (step.stop === 'mistake') {
            const plain = text || stepText({ ...step, kind: 'mistake' }, moveDetails, trouble);
            card = { kind: 'mistake', ply: step.ply, text: plain };
          }
          set({ reached: stopNumber(schedule, i), text, card });
        },
        onStatus: (status) => {
          if (controller !== c) return;
          if (tourActive(status)) {
            set({ status });
            if (status === 'waiting') focusTourNext();
          } else {
            tourPly = null;
            set({ status, card: undefined });
            focusTourReplay();
          }
        },
      },
      timer,
    );
    const previous = controller;
    controller = c;
    previous?.stop(); // its callbacks are detached (controller !== previous)
    set({
      total: schedule.filter((s) => s.stop).length,
      reached: 0,
      text: '',
      card: undefined,
      userSide: side,
    });
    c.start();
  },
  next: () => controller?.next(),
  pause: () => controller?.pause(),
  resume: () => controller?.resume(),
  skip: () => controller?.skip(),
  stop: () => {
    startGen++;
    controller?.stop();
  },
  switchSide: async () => {
    const game = useGameStore.getState();
    const current = get().userSide ?? game.orientation;
    const other: Side = current === 'white' ? 'black' : 'white';
    try {
      await switchReviewSide(ledgerKey(game), other);
    } catch {
      // Not stored (ledger unavailable): the tour still follows the chosen side.
    }
    if (gameKey(useGameStore.getState()) !== gameKey(game)) return;
    await get().start(other);
  },
}));

/** Keys that continue a waiting tour (ADR-024 section 1). */
const CONTINUE_KEYS = new Set(['ArrowRight', 'Enter', ' ', 'Spacebar']);

function onTourKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
  const tour = useTourStore.getState();
  if (tour.status !== 'waiting') return;
  const t = e.target instanceof Element ? e.target : null;
  if (isTextEntry(t)) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    tour.stop();
    return;
  }
  if (!CONTINUE_KEYS.has(e.key)) return;
  // Widgets that own the arrows (tabs, radios) keep them; a stepping arrow would end the tour.
  const role = t?.getAttribute('role');
  if (e.key === 'ArrowRight' && (role === 'tab' || role === 'radio' || role === 'slider')) return;
  // Enter/Space on another control activates that control natively (Next itself included).
  if (e.key !== 'ArrowRight' && t && t !== document.body && t.closest('button, a[href], [role="button"], summary'))
    return;
  // preventDefault: the move-list/board key handlers skip prevented events.
  e.preventDefault();
  tour.next();
}

/**
 * Wires the tour: starts it once per game when its review is done (computed or cached) and the
 * Review tab is showing, stops it on any navigation the tour did not cause (game store
 * `ply`/`moves`/start position) or when the user leaves the Review tab, and listens for the keys
 * that continue a waiting tour (→, Enter, Space; Escape stops). Returns the unsubscribe.
 */
export function installReviewTour(): () => void {
  const unwatchReview = useReviewStore.subscribe((s, prev) => {
    if (s.status !== 'done' || prev.status === 'done') return;
    if (!useSettingsStore.getState().reviewTour) return;
    if (useUiStore.getState().activeTab !== 'review') return;
    if (isHumanGameRunning()) return;
    const tour = useTourStore.getState();
    if (tour.started.has(gameKey(useGameStore.getState()))) return;
    void tour.start();
  });
  const unwatchGame = useGameStore.subscribe((s, prev) => {
    const { status } = useTourStore.getState();
    if (!tourActive(status)) return;
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
  document.addEventListener('keydown', onTourKey);
  return () => {
    unwatchReview();
    unwatchGame();
    unwatchUi();
    unwatchReviewReset();
    document.removeEventListener('keydown', onTourKey);
    useTourStore.getState().stop();
  };
}
