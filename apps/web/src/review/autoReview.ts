import { usePlayStore } from '../play/playStore';
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
 * `autoReview` setting is on and no game against the engine is running, and switches the side
 * panel to the Review tab (except from the Explorer tab, which stays open). A running review (of the previous game) is replaced. Returns the
 * unsubscribe function.
 */
export function installAutoReview(): () => void {
  return useGameStore.subscribe((s, prev) => {
    if (!isGameLoad(s, prev)) return;
    if (!useSettingsStore.getState().autoReview) return;
    // Checked synchronously: a load during a game aborts it (play store), but it never counts as a
    // finished game here, so the engine game and the review never overlap.
    if (usePlayStore.getState().mode === 'playing') return;
    // Loads from the Explorer keep the user there; the review runs in the background.
    const ui = useUiStore.getState();
    if (ui.activeTab !== 'explorer') ui.setActiveTab('review');
    const review = useReviewStore.getState();
    review.reset();
    void review.start({ ...REVIEW_PRESETS.fast }, { auto: true });
  });
}
