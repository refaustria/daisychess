import type { Puzzle } from '@daisychess/puzzles';
import { useEffect, useState } from 'react';
import { useHumanGameLockReason } from '../../live/lock';
import {
  dailyStreak,
  getPuzzlesState,
  recordDaily,
  subscribePuzzlesState,
  updatePuzzlesState,
  type PuzzlesState,
} from '../../puzzles/puzzlesState';
import { usePuzzleStore } from '../../puzzles/puzzleStore';
import styles from './PuzzlesPanel.module.css';

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of a date in UTC. */
export const utcDate = (d: Date): string => d.toISOString().slice(0, 10);

/** The last `n` UTC dates ending at `today`, oldest first. */
export function lastDates(today: string, n = 30): string[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => utcDate(new Date(end - (n - 1 - i) * DAY_MS)));
}

/** Puzzles tab: the daily puzzle (bundled pool, same for everyone on a release), streak, 30 days. */
export function DailyCard() {
  const [state, setState] = useState<PuzzlesState>(getPuzzlesState);
  const [today, setToday] = useState(() => utcDate(new Date()));
  const [missing, setMissing] = useState(false);
  const lock = useHumanGameLockReason();

  useEffect(() => subscribePuzzlesState(setState), []);
  useEffect(() => {
    const t = setInterval(() => setToday(utcDate(new Date())), 60_000);
    return () => clearInterval(t);
  }, []);

  const result = state.daily.results[today];
  const streak = dailyStreak(state, today);

  const play = async () => {
    const date = today;
    let puzzle: Puzzle | null = null;
    try {
      puzzle = await (await import('../../puzzles/starter')).dailyPuzzle(date);
    } catch {
      puzzle = null;
    }
    if (!puzzle) {
      setMissing(true);
      return;
    }
    setMissing(false);
    // Rated on the first attempt of the day only (ADR-023 §6); "Play again" is free. Hints and
    // "Show solution" count as a miss (the store reports 'failed'); only the first result counts.
    usePuzzleStore.getState().start(puzzle, {
      rated: getPuzzlesState().daily.results[date] === undefined,
      onResult: (r) => {
        updatePuzzlesState((s) => recordDaily(s, date, r));
      },
    });
  };

  return (
    <section className={styles.daily} aria-label="Daily puzzle" data-testid="puzzle-daily">
      <div className={styles.dailyHead}>
        <strong>Daily puzzle</strong>
        <span className={styles.note} data-testid="puzzle-daily-streak">
          Streak {streak} {streak === 1 ? 'day' : 'days'}
        </span>
      </div>
      <div className={styles.row}>
        <button type="button" disabled={lock !== null} onClick={() => void play()}>
          {result ? 'Play again' : 'Solve today’s puzzle'}
        </button>
        {result && (
          <span
            className={result === 'solved' ? styles.up : styles.down}
            data-testid="puzzle-daily-result"
          >
            {result === 'solved' ? 'Solved today' : 'Missed today'}
          </span>
        )}
      </div>
      {missing && <p className={styles.note}>The daily puzzle is not available.</p>}
      <ol className={styles.dailyDays} aria-label="Last 30 days">
        {lastDates(today).map((d) => {
          const r = state.daily.results[d];
          return (
            <li
              key={d}
              className={r === 'solved' ? styles.daySolved : r === 'failed' ? styles.dayFailed : ''}
              title={`${d}: ${r === 'solved' ? 'solved' : r === 'failed' ? 'missed' : 'not played'}`}
              aria-label={`${d}: ${r === 'solved' ? 'solved' : r === 'failed' ? 'missed' : 'not played'}`}
            />
          );
        })}
      </ol>
    </section>
  );
}
