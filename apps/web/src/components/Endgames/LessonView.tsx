import { shownHints, type EndgameTheme, type LessonGroup } from '@daisychess/endgames';
import { useId, useState, type FormEvent } from 'react';
import {
  budgetLine,
  GROUP_TITLES,
  LESSON_HINT_TITLE,
  lessonById,
  lessonStatusLine,
  useLessonStore,
} from '../../endgames/lessonStore';
import { usePuzzleStore } from '../../puzzles/puzzleStore';
import { RookPackCard } from './RookPackCard';
import styles from './EndgamesPanel.module.css';

/** Puzzle theme of the "Endgame puzzles" button per course group. */
export const GROUP_THEME: Record<LessonGroup, EndgameTheme> = {
  basic_mates: 'endgame',
  king_pawn: 'pawnEndgame',
  queen_pawn: 'queenEndgame',
  rook_pawn: 'rookEndgame',
};

/** One lesson: text, goal and budget, status, controls, typed moves, the result summary. */
export function LessonView() {
  const status = useLessonStore((s) => s.status);
  const lessonId = useLessonStore((s) => s.lessonId);
  const game = useLessonStore((s) => s.game);
  const thinking = useLessonStore((s) => s.thinking);
  const thrown = useLessonStore((s) => s.thrown);
  const message = useLessonStore((s) => s.message);
  const needsPack = useLessonStore((s) => s.needsPack);
  const inputError = useLessonStore((s) => s.inputError);
  const source = useLessonStore((s) => s.source);
  const store = useLessonStore.getState;
  const [san, setSan] = useState('');
  const sanId = useId();

  const lesson = game?.lesson ?? lessonById(lessonId);
  if (!lesson) return null;

  const running = status === 'running';
  const done = game?.phase === 'done';
  const userTurn = running && game?.phase === 'user' && !thinking;
  const canTakeBack =
    !thinking &&
    (status === 'running' || status === 'done') &&
    game !== undefined &&
    game.played.length > 0 &&
    (game.phase === 'user' || (done && game.outcome === 'failure'));
  const line = lessonStatusLine({ status, game, thinking, thrown, message });
  const hints = game ? shownHints(game) : [];
  const statusCls = done
    ? `${styles.status} ${game.outcome === 'success' ? styles.statusGood : styles.statusBad}`
    : styles.status;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (store().playSan(san)) setSan('');
  };

  return (
    <div className={styles.panel} data-testid="lesson-view">
      <div className={styles.row}>
        <button type="button" onClick={() => store().stop()} data-testid="lesson-back">
          ← Course
        </button>
        <span className={styles.meta}>{GROUP_TITLES[lesson.group]}</span>
      </div>
      <h3 className={styles.title} data-testid="lesson-title">
        {lesson.title}
        {lesson.advanced && <span className={styles.tag}> · advanced</span>}
      </h3>
      <p className={styles.text}>{lesson.text}</p>
      <p className={styles.meta} data-testid="lesson-budget">
        {game
          ? budgetLine(game)
          : lesson.goal === 'win'
            ? `Goal: checkmate within ${lesson.budget} moves`
            : `Goal: hold the draw for ${lesson.budget} moves`}
        {source && ` · ${source === 'local' ? 'tables on this device' : 'lichess tablebase'}`}
      </p>

      <p className={statusCls} role="status" aria-live="polite" data-testid="lesson-status">
        {line}
      </p>
      {message && game && status !== 'idle' && (
        <p className={styles.message} data-testid="lesson-message">
          {message}
        </p>
      )}

      {needsPack && <RookPackCard showReady />}

      {hints.length > 0 && (
        <ol className={styles.hints} aria-label="Hints" data-testid="lesson-hints">
          {hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ol>
      )}

      {(running || done) && (
        <>
          {/* data-phone-bar: on phones Hint · Take back · Stop live in the action bar (M29-6). */}
          {running && (
            <div className={styles.row} data-phone-bar>
              <button
                type="button"
                disabled={!userTurn}
                title={LESSON_HINT_TITLE}
                onClick={() => void store().hint()}
              >
                Hint
              </button>
              <button type="button" disabled={!canTakeBack} onClick={() => store().takeBack()}>
                Take back
              </button>
              <button type="button" onClick={() => store().stop()}>
                Stop
              </button>
            </div>
          )}
          <div className={styles.row}>
            {running && (
              <button
                type="button"
                disabled={!userTurn}
                title="Draws the best move as an arrow. Counts as a mistake."
                onClick={() => void store().showMove()}
              >
                Show move
              </button>
            )}
            {done && game.outcome === 'failure' && (
              <button
                type="button"
                className={styles.primary}
                disabled={!canTakeBack}
                onClick={() => store().takeBack()}
              >
                Take back
              </button>
            )}
            <button type="button" onClick={() => store().restart()}>
              Restart
            </button>
          </div>
        </>
      )}

      {running && (
        <>
          <form className={styles.sanForm} onSubmit={onSubmit}>
            <label htmlFor={sanId} className={styles.label}>
              Move, e.g. Qd5
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
          <p className={styles.note}>Hints, shown moves and take-backs count as mistakes.</p>
        </>
      )}

      {done && game && <Summary group={lesson.group} />}

      {status === 'idle' && !done && (
        <div className={styles.row}>
          <button
            type="button"
            className={styles.primary}
            data-testid="lesson-start"
            onClick={() => void store().start(lesson.id)}
          >
            {game ? 'Start again' : 'Start'}
          </button>
        </div>
      )}
    </div>
  );
}

/** "Next lesson", "Repeat" and "Endgame puzzles" after a lesson. */
function Summary({ group }: { group: LessonGroup }) {
  const game = useLessonStore((s) => s.game);
  const store = useLessonStore.getState;
  if (!game) return null;
  const extra = game.hints + game.mistakes;
  return (
    <section className={styles.summary} aria-label="Lesson result" data-testid="lesson-summary">
      <p className={styles.meta}>
        {game.userMoves} {game.userMoves === 1 ? 'move' : 'moves'} played
        {extra > 0 && ` · ${extra} ${extra === 1 ? 'mistake' : 'mistakes'} (hints, take-backs)`}
        {game.attempts > 1 && ` · attempt ${game.attempts}`}
      </p>
      <div className={styles.row}>
        <button type="button" className={styles.primary} onClick={() => void store().nextLesson()}>
          Next lesson
        </button>
        <button type="button" onClick={() => void store().start(game.lesson.id)}>
          Repeat
        </button>
        <button
          type="button"
          onClick={() =>
            void usePuzzleStore.getState().openWithFilter({ endgame: GROUP_THEME[group] })
          }
        >
          Endgame puzzles
        </button>
      </div>
    </section>
  );
}
