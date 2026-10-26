import { useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import { formatClock, isLowTime } from '../../clock/format';
import { lockText, useHumanGameLockReason } from '../../live/lock';
import {
  getPuzzlesState,
  subscribePuzzlesState,
  type RushDuration,
} from '../../puzzles/puzzlesState';
import { usePuzzleStore } from '../../puzzles/puzzleStore';
import { RUSH_STRIKES, useRushStore } from '../../puzzles/rushStore';
import styles from './RushPanel.module.css';

const DURATIONS: RushDuration[] = [3, 5];

export function RushPanel() {
  const status = useRushStore((s) => s.status);
  const duration = useRushStore((s) => s.duration);
  const remainingMs = useRushStore((s) => s.remainingMs);
  const score = useRushStore((s) => s.score);
  const strikes = useRushStore((s) => s.strikes);
  const puzzleNo = useRushStore((s) => s.puzzleNo);
  const newBest = useRushStore((s) => s.newBest);
  const message = useRushStore((s) => s.message);
  const inputError = usePuzzleStore((s) => s.inputError);
  const phase = usePuzzleStore((s) => s.solver?.phase);
  const puzzleStatus = usePuzzleStore((s) => s.status);
  const puzzlesState = useSyncExternalStore(subscribePuzzlesState, getPuzzlesState);
  const lock = useHumanGameLockReason();
  const [san, setSan] = useState('');
  const sanId = useId();

  const running = status === 'running';
  const busy = running || status === 'loading';
  const userTurn = running && puzzleStatus === 'running' && phase === 'user';
  const best = (d: RushDuration): number =>
    d === 3 ? puzzlesState.rush.best3 : puzzlesState.rush.best5;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (usePuzzleStore.getState().playSan(san)) setSan('');
  };

  return (
    <div className={styles.panel} data-testid="rush-panel">
      {!busy && (
        <>
          <p className={styles.intro}>
            Solve as many puzzles as you can before the time runs out. Puzzles get harder; a wrong
            move is a strike and three strikes end the run. Rush is unrated and works offline.
          </p>
          <div className={styles.row}>
            {DURATIONS.map((d) => (
              <button
                key={d}
                type="button"
                className={styles.primary}
                disabled={lock !== null}
                onClick={() => void useRushStore.getState().start(d)}
              >
                {d} minutes
              </button>
            ))}
          </div>
          <p className={styles.best} data-testid="rush-best">
            Best: 3 min <strong>{best(3)}</strong> · 5 min <strong>{best(5)}</strong>
          </p>
        </>
      )}
      {lock && !busy && <p className={styles.note}>Rush is paused: {lockText(lock)}.</p>}

      {status === 'loading' && (
        <p className={styles.status} role="status">
          Preparing the run…
        </p>
      )}

      {(running || status === 'over') && (
        <div className={styles.scoreboard}>
          <span
            className={`${styles.timer} ${isLowTime(remainingMs, duration * 60_000) ? styles.low : ''}`}
            role="timer"
            aria-live="off"
            aria-label={`Time left ${formatClock(remainingMs)}`}
            data-testid="rush-timer"
          >
            {formatClock(remainingMs)}
          </span>
          <span className={styles.score} data-testid="rush-score">
            Score <strong>{score}</strong>
          </span>
          <span
            className={styles.strikes}
            data-testid="rush-strikes"
            aria-label={`${strikes} of ${RUSH_STRIKES} strikes`}
          >
            {Array.from({ length: RUSH_STRIKES }, (_, i) => (
              <span
                key={i}
                className={i < strikes ? styles.strikeOn : styles.strikeOff}
                aria-hidden="true"
              >
                ✗
              </span>
            ))}
          </span>
        </div>
      )}

      {running && (
        <>
          <p className={styles.status} role="status" aria-live="polite" data-testid="rush-status">
            {userTurn ? `Puzzle ${puzzleNo}: your move.` : `Puzzle ${puzzleNo}…`}
          </p>
          <form className={styles.sanForm} onSubmit={onSubmit}>
            <label htmlFor={sanId} className={styles.label}>
              Move, e.g. Nf3
            </label>
            <input
              id={sanId}
              className={styles.sanInput}
              value={san}
              onChange={(e) => setSan(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={!userTurn}
            />
            <button type="submit" disabled={!userTurn || san.trim() === ''}>
              Play
            </button>
          </form>
          {inputError && (
            <p className={styles.error} role="alert">
              {inputError}
            </p>
          )}
          <div className={styles.row}>
            <button type="button" onClick={() => useRushStore.getState().end()}>
              End run
            </button>
          </div>
        </>
      )}

      {status === 'over' && (
        <p className={styles.result} role="status" data-testid="rush-result">
          {message} Final score <strong>{score}</strong>
          {newBest ? ' · new best!' : ''}
        </p>
      )}
      {status === 'idle' && message && (
        <p className={styles.note} data-testid="rush-message">
          {message}
        </p>
      )}
    </div>
  );
}
