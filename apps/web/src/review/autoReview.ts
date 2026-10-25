import { isHumanGameRunning } from '../live/lock';
import { isLiveLocked, useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { isRoomLocked, useRoomStore } from '../room/roomStore';
import { useGameStore, type GameState } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { MIN_CACHED_PLIES, warmReviewCache } from './reviewCache';
import { REVIEW_PRESETS, useReviewStore } from './reviewStore';

/** Games shorter than this are not reviewed automatically. */
export const AUTO_REVIEW_MIN_MOVES = 2;

/**
 * A finished game against the engine is reviewed automatically from this many plies (whole game,
 * including an opening line it was started from, e.g. the drill's "Play on vs engine").
 */
export const ENGINE_GAME_REVIEW_MIN_PLIES = 6;

/** Delay between a change of the game's moves and the review cache lookup (ADR-016). */
export const CACHE_LOOKUP_DEBOUNCE_MS = 100;

/**
 * Shows the stored review (ADR-016) of the game on the board whenever its moves change (a load, a
 * finished game, moves entered by hand), debounced by {@link CACHE_LOOKUP_DEBOUNCE_MS}. Navigation
 * leaves `moves` untouched and never triggers it; neither does a running review, a game under
 * {@link MIN_CACHED_PLIES} plies or a running human game (fair play). Never starts an engine.
 * Returns the unsubscribe function.
 */
export function installReviewCacheLookup(): () => void {
  void warmReviewCache();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unwatch = useGameStore.subscribe((s, prev) => {
    if (s.moves === prev.moves) return;
    clearTimeout(timer);
    if (s.moves.length < MIN_CACHED_PLIES) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (isHumanGameRunning()) return;
      if (useReviewStore.getState().status === 'running') return;
      void useReviewStore.getState().loadCached();
    }, CACHE_LOOKUP_DEBOUNCE_MS);
  });
  return () => {
    clearTimeout(timer);
    unwatch();
  };
}

/**
 * True when the game store change `prev → s` replaced the game by a loaded one (loadPgn):
 * a load always installs a new `headers` object (and possibly a new `startFen`) together with the
 * moves, while ordinary moves, takebacks and navigation leave both untouched. New game /
 * `loadFen` also replace them but leave no moves, so the move count rules them out (same
 * "position replaced" idea as the play store's game watcher).
 */
export function isGameLoad(
  s: Pick<GameState, 'headers' | 'startFen' | 'moves'>,
  prev: Pick<GameState, 'headers' | 'startFen' | 'moves'>,
): boolean {
  return (
    (s.headers !== prev.headers || s.startFen !== prev.startFen) &&
    s.moves.length >= AUTO_REVIEW_MIN_MOVES
  );
}

/**
 * Starts a fast review whenever a game is loaded (PGN paste/file, online import), if the
 * `autoReview` setting is on and no human game (engine game, live lichess game) is running, and
 * switches the side panel to the Review tab (except from the Explorer tab, which stays open; lines
 * loaded by the Openings tab are not reviewed).
 * Also reviews a finished engine game of at least {@link ENGINE_GAME_REVIEW_MIN_PLIES} plies in
 * the background (no tab switch) and cancels a running review when an engine game starts.
 * Also reviews a live lichess game when it finishes (without switching tabs: the Live panel shows
 * the result) and cancels a running review when a live game or seek starts; the same for a game
 * against a friend (room, ADR-013). A running review (of
 * the previous game) is replaced. A game with a stored review of the same or a stronger preset
 * just shows it (the review store's cache, ADR-016). Also installs
 * {@link installReviewCacheLookup}. Returns the unsubscribe function.
 */
export function installAutoReview(): () => void {
  const unwatchCache = installReviewCacheLookup();
  const unwatchGame = useGameStore.subscribe((s, prev) => {
    if (!isGameLoad(s, prev)) return;
    if (!useSettingsStore.getState().autoReview) return;
    // Checked synchronously: a load during a game aborts it (play store), but it never counts as a
    // finished game here, so the engine game and the review never overlap.
    // Live lichess games are never reviewed while they run (fair play).
    if (isHumanGameRunning()) return;
    const ui = useUiStore.getState();
    // Opening lines shown by the Openings tab (Browse) are no games to review.
    if (ui.activeTab === 'openings') return;
    // Loads from the Explorer keep the user there; the review runs in the background.
    if (ui.activeTab !== 'explorer') ui.setActiveTab('review');
    startFast();
  });
  const unwatchLive = useLiveStore.subscribe((s, prev) => {
    // Lock engaged (seek or game started): a running review must not go on.
    if (isLiveLocked(s) && !isLiveLocked(prev)) {
      const review = useReviewStore.getState();
      if (review.status === 'running') review.cancel();
    }
    // A live game just ended: review it (in the background, the Live panel shows the result).
    if (s.status === 'finished' && prev.status === 'playing') {
      if (!useSettingsStore.getState().autoReview) return;
      if (useGameStore.getState().moves.length < AUTO_REVIEW_MIN_MOVES) return;
      if (isHumanGameRunning()) return;
      startFast();
    }
  });
  const unwatchRoom = useRoomStore.subscribe((s, prev) => {
    // The user's game against a friend started: no review may run (fair play).
    if (isRoomLocked(s) && !isRoomLocked(prev)) {
      const review = useReviewStore.getState();
      if (review.status === 'running') review.cancel();
    }
    // It just ended: review it in the background (the Friend panel shows the result).
    if (!isRoomLocked(s) && isRoomLocked(prev) && s.room?.status === 'finished') {
      if (!useSettingsStore.getState().autoReview) return;
      if (useGameStore.getState().moves.length < AUTO_REVIEW_MIN_MOVES) return;
      if (isHumanGameRunning()) return;
      startFast();
    }
  });
  const unwatchPlay = usePlayStore.subscribe((s, prev) => {
    // A new engine game: the review of the previous game must not compete with the engine.
    if (s.mode === 'playing' && prev.mode !== 'playing') {
      const review = useReviewStore.getState();
      if (review.status === 'running') review.cancel();
    }
    // An engine game just ended (M18-3): review it in the background like a live game; the Play
    // panel keeps showing the result and its "Review this game" button opens the review. Not after
    // an abort (a load or New game replaced the game; the load reviews itself).
    if (s.mode === 'finished' && prev.mode === 'playing' && s.reason !== 'aborted') {
      // Deferred: the play store restores the live analysis right after this notification, and
      // the review must see it switched on to pause it (and switch it back on afterwards).
      queueMicrotask(() => {
        if (!useSettingsStore.getState().autoReview) return;
        if (usePlayStore.getState().mode !== 'finished') return;
        if (useGameStore.getState().moves.length < ENGINE_GAME_REVIEW_MIN_PLIES) return;
        if (isHumanGameRunning()) return;
        startFast();
      });
    }
  });
  return () => {
    unwatchCache();
    unwatchGame();
    unwatchLive();
    unwatchRoom();
    unwatchPlay();
  };
}

function startFast(): void {
  const review = useReviewStore.getState();
  review.reset();
  void review.start({ ...REVIEW_PRESETS.fast }, { auto: true });
}
