import { formatPuzzleRating, type Difficulty, type SolverState } from '@daisychess/puzzles';
import { useId, useState, type FormEvent } from 'react';
import { lockText, useHumanGameLockReason } from '../../live/lock';
import { usePuzzleStore, type PuzzleState } from '../../puzzles/puzzleStore';
import { PuzzleModes } from './PuzzleModes';
import { DailyCard } from './DailyCard';
import { Filters } from './Filters';
import { usePuzzleActions } from './usePuzzleActions';
import styles from './PuzzlesPanel.module.css';

const DIFFICULTIES: { id: Difficulty; label: string }[] = [
  { id: 'easier', label: 'Easier' },
  { id: 'normal', label: 'Normal' },
  { id: 'harder', label: 'Harder' },
];

export const HINT_TITLE = 'Highlights the piece to move. A hint counts as a miss for the rating.';

const sideName = (side: 'white' | 'black'): string => (side === 'white' ? 'White' : 'Black');

/** The status line for the current state (read out by screen readers). */
export function statusLine(s: Pick<PuzzleState, 'status' | 'solver' | 'message'>): string {
  const sol: SolverState | undefined = s.solver;
  if (s.status === 'loading') return 'Loading a puzzle…';
  if (s.status === 'empty') return s.message ?? 'No puzzle available.';
  if ((s.status === 'idle' || s.status === 'done') && sol?.phase === 'complete') {
    if (sol.outcome === 'shown') return 'Solution shown. Not solved.';
    return sol.result === 'solved' ? 'Solved!' : 'Solved, but counted as a miss.';
  }
  if (s.status !== 'running' || !sol) {
    return s.message ?? 'Press “Next puzzle” to start.';
  }
  const you = sideName(sol.userColor);
  switch (sol.phase) {
    case 'intro':
      return `You play ${you}. Watch the opponent's move…`;
    case 'user':
      if (sol.hint) return `Hint: move the highlighted piece (${you} to play).`;
      return sol.played.length > 1
        ? `Correct! Find the next move for ${you}.`
        : `Your turn: find the best move for ${you}.`;
    case 'opponent':
      return 'Correct!';
    case 'wrong':
      return "That's not the move. Try again.";
    case 'showing':
      return 'Showing the solution…';
    case 'complete':
      return 'Solved!';
  }
}

function SolverPanel() {
  const status = usePuzzleStore((s) => s.status);
  const solver = usePuzzleStore((s) => s.solver);
  const message = usePuzzleStore((s) => s.message);
  const rating = usePuzzleStore((s) => s.rating);
  const ratingDelta = usePuzzleStore((s) => s.ratingDelta);
  const rated = usePuzzleStore((s) => s.rated);
  const difficulty = usePuzzleStore((s) => s.difficulty);
  const inputError = usePuzzleStore((s) => s.inputError);
  const store = usePuzzleStore.getState;
  const lock = useHumanGameLockReason();
  const [san, setSan] = useState('');
  const sanId = useId();
  const difficultyId = useId();

  const { running, finished, canHint, canShow, wrong, nextDisabled, nextLabel } =
    usePuzzleActions();
  const phase = solver?.phase;
  const userTurn = running && phase === 'user';
  const puzzle = solver?.puzzle;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (store().playSan(san)) setSan('');
  };

  return (
    <div className={styles.panel}>
      <div className={styles.ratingRow}>
        <p className={styles.rating} data-testid="puzzle-rating">
          Puzzle rating <strong>{formatPuzzleRating(rating)}</strong>
          {ratingDelta !== undefined && finished && (
            <span
              className={ratingDelta >= 0 ? styles.up : styles.down}
              data-testid="puzzle-rating-delta"
            >
              {' '}
              ({ratingDelta >= 0 ? '+' : '−'}
              {Math.abs(ratingDelta)})
            </span>
          )}
        </p>
        <label htmlFor={difficultyId} className={styles.label}>
          Difficulty
        </label>
        <select
          id={difficultyId}
          className={styles.select}
          value={difficulty}
          onChange={(e) => store().setDifficulty(e.target.value as Difficulty)}
        >
          {DIFFICULTIES.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <p className={styles.status} role="status" aria-live="polite" data-testid="puzzle-status">
        {statusLine({ status, solver, message })}
      </p>
      {message && status !== 'empty' && (
        <p className={styles.message} data-testid="puzzle-message">
          {message}
        </p>
      )}
      {lock && <p className={styles.note}>Puzzles are paused: {lockText(lock)}.</p>}

      {/* data-phone-bar: on phones these live in the action bar under the board (M29-6). */}
      <div className={styles.row} data-phone-bar>
        <button
          type="button"
          className={styles.primary}
          disabled={nextDisabled}
          onClick={() => void store().next()}
        >
          {nextLabel}
        </button>
        <button type="button" disabled={!canHint} onClick={() => store().hint()} title={HINT_TITLE}>
          Hint
        </button>
        {wrong && (
          <button type="button" onClick={() => store().retry()}>
            Try again
          </button>
        )}
        <button type="button" disabled={!canShow} onClick={() => store().showSolution()}>
          Show solution
        </button>
        {finished && (
          <button type="button" onClick={() => store().analyse()}>
            Analyse
          </button>
        )}
      </div>

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
          aria-describedby={inputError ? `${sanId}-error` : undefined}
        />
        <button type="submit" disabled={!userTurn || san.trim() === ''}>
          Play
        </button>
      </form>
      {inputError && (
        <p id={`${sanId}-error`} className={styles.error} role="alert">
          {inputError}
        </p>
      )}

      {puzzle && (
        <p className={styles.meta} data-testid="puzzle-meta">
          {puzzle.source === 'lichess' ? `Puzzle ${puzzle.id}` : 'Puzzle from your game'}
          {finished && puzzle.rating !== undefined && ` · rated ${puzzle.rating}`}
          {!rated && ' · unrated'}
          {finished && puzzle.game && (
            <>
              {' · '}
              <a
                href={`https://lichess.org/${puzzle.game}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                Source game
              </a>
            </>
          )}
        </p>
      )}
      {(phase === 'user' || phase === 'wrong') && running && (
        <p className={styles.note}>Hints and “Show solution” count as a miss for the rating.</p>
      )}

      <Filters />
      <DailyCard />

      <p className={styles.footer}>Puzzles from the lichess.org database (CC0)</p>
    </div>
  );
}

export function PuzzlesPanel() {
  return (
    <PuzzleModes>
      <SolverPanel />
    </PuzzleModes>
  );
}
