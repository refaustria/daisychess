import { useId, useState } from 'react';
import { resetPuzzlesState } from '../../puzzles/puzzlesState';
import { OfflineKeep } from '../Puzzles/OfflineKeep';
import styles from './SettingsPanel.module.css';

/** Settings → Puzzles: offline use and "Reset puzzle rating and history". */
export function PuzzleDataField() {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);

  return (
    <div className={styles.group} role="group" aria-labelledby={`${id}-legend`}>
      <span id={`${id}-legend`} className={styles.legend}>
        Puzzle data
      </span>
      <OfflineKeep />
      <div className={styles.tokenRow}>
        {confirming ? (
          <>
            <button
              type="button"
              className={styles.reset}
              onClick={() => {
                resetPuzzlesState();
                setConfirming(false);
                setDone(true);
              }}
            >
              Yes, reset
            </button>
            <button type="button" className={styles.reset} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.reset}
            onClick={() => {
              setConfirming(true);
              setDone(false);
            }}
          >
            Reset puzzle rating and history
          </button>
        )}
      </div>
      <p className={styles.help} role="status">
        {confirming
          ? 'This sets the puzzle rating back to 1500 and clears the daily streak, the rush bests, the seen puzzles and the filters. It cannot be undone.'
          : done
            ? 'Puzzle rating and history were reset.'
            : 'Starts the puzzle rating, streak and history over.'}
      </p>
    </div>
  );
}
