/**
 * "Train due" actions of the Your mistakes mode, shared by the panel and the phone action bar
 * (M29-6). The session queue and the panel's note live in {@link useMistakeSession}.
 */
import { lockText, type HumanGameLock } from '../live/lock';
import { dueMistakes, recordMistakeResult, type MistakeRecord } from './mistakeStore';
import { resetMistakeSession, setMistakeNote, useMistakeSession } from './mistakeSession';
import { usePuzzleStore } from './puzzleStore';

/** Starts one mistake puzzle (unrated; the result updates its schedule). */
export function playMistake(m: MistakeRecord, lock: HumanGameLock): void {
  setMistakeNote(undefined);
  usePuzzleStore.getState().start(m.puzzle, {
    rated: false,
    onResult: (result) => void recordMistakeResult(m.id, result === 'solved'),
  });
  if (usePuzzleStore.getState().status !== 'running') {
    resetMistakeSession();
    setMistakeNote(
      lock ? `Training is paused: ${lockText(lock)}.` : 'The puzzle could not be started.',
    );
  }
}

/** "Next due": the next puzzle of the session queue, or ends the session when it is empty. */
export function nextDueMistake(lock: HumanGameLock): void {
  const [next, ...rest] = useMistakeSession.getState().queue;
  if (!next) {
    resetMistakeSession();
    setMistakeNote('No more due puzzles. Well done.');
    return;
  }
  useMistakeSession.setState((st) => ({ queue: rest, index: st.index + 1 }));
  playMistake(next, lock);
}

/** "Train due": starts a session with every due puzzle. */
export async function trainDueMistakes(lock: HumanGameLock): Promise<void> {
  const d = await dueMistakes();
  if (d.length === 0) {
    setMistakeNote('Nothing is due right now.');
    return;
  }
  useMistakeSession.setState({ queue: d.slice(1), index: 1, total: d.length, active: true });
  playMistake(d[0]!, lock);
}

/** "End training": drops the session and stops the puzzle. */
export function endMistakeTraining(): void {
  resetMistakeSession();
  usePuzzleStore.getState().stop();
}
