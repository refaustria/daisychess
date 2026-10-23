import { isHumanGameRunning } from '../live/lock';
import { isLiveLocked, useLiveStore } from '../live/liveStore';
import { isRoomLocked, useRoomStore } from '../room/roomStore';
import { useGameStore, type GameState } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { REVIEW_PRESETS, useReviewStore } from './reviewStore';

/** Games shorter than this are not reviewed automatically. */
export const AUTO_REVIEW_MIN_MOVES = 2;

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
 * switches the side panel to the Review tab (except from the Explorer tab, which stays open).
 * Also reviews a live lichess game when it finishes (without switching tabs: the Live panel shows
 * the result) and cancels a running review when a live game or seek starts; the same for a game
 * against a friend (room, ADR-013). A running review (of
 * the previous game) is replaced. Returns the unsubscribe function.
 */
export function installAutoReview(): () => void {
  const unwatchGame = useGameStore.subscribe((s, prev) => {
    if (!isGameLoad(s, prev)) return;
    if (!useSettingsStore.getState().autoReview) return;
    // Checked synchronously: a load during a game aborts it (play store), but it never counts as a
    // finished game here, so the engine game and the review never overlap.
    // Live lichess games are never reviewed while they run (fair play).
    if (isHumanGameRunning()) return;
    // Loads from the Explorer keep the user there; the review runs in the background.
    const ui = useUiStore.getState();
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
  return () => {
    unwatchGame();
    unwatchLive();
    unwatchRoom();
  };
}

function startFast(): void {
  const review = useReviewStore.getState();
  review.reset();
  void review.start({ ...REVIEW_PRESETS.fast }, { auto: true });
}
