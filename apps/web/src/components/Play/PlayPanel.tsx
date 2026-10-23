import { useId } from 'react';
import { REASON_TEXT, type GameResult } from '../../play/outcome';
import { takeBackPlies, usePlayStore, type ColorChoice } from '../../play/playStore';
import { findStrength, MOVE_TIMES, STRENGTH_PRESETS } from '../../play/strength';
import { useGameStore, type Orientation } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import styles from './PlayPanel.module.css';

const COLORS: { id: ColorChoice; label: string }[] = [
  { id: 'white', label: 'White' },
  { id: 'black', label: 'Black' },
  { id: 'random', label: 'Random' },
];

const colorName = (c: Orientation) => (c === 'white' ? 'White' : 'Black');

function verdict(result: GameResult | undefined, player: Orientation): string {
  if (!result) return 'Game aborted';
  if (result === '½-½') return 'Draw';
  const won = (result === '1-0') === (player === 'white');
  return won ? 'You won' : 'You lost';
}

async function reviewThisGame(setTab: (t: 'review') => void): Promise<void> {
  const { REVIEW_PRESETS, useReviewStore } = await import('../../review/reviewStore');
  setTab('review');
  const review = useReviewStore.getState();
  review.reset();
  void review.start({ ...REVIEW_PRESETS.deep });
}

/** "Play vs Engine": setup, running game controls and the result. */
export function PlayPanel() {
  const play = usePlayStore();
  const plies = useGameStore((g) => takeBackPlies(g, play.playerColor));
  const atTip = useGameStore((g) => g.ply === g.moves.length);
  const setTab = useUiStore((s) => s.setActiveTab);
  const id = useId();
  const { setup } = play;
  const summary = `${colorName(play.playerColor)} · ${findStrength(setup.strength).label} · ${
    MOVE_TIMES.find((t) => t.ms === setup.moveTime)?.label ?? ''
  }`;

  if (play.mode === 'idle') {
    return (
      <form
        className={styles.panel}
        aria-label="New game against the engine"
        onSubmit={(e) => {
          e.preventDefault();
          play.start();
        }}
      >
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Your colour</legend>
          <div className={styles.segmented}>
            {COLORS.map((c) => (
              <label key={c.id} className={styles.segment}>
                <input
                  type="radio"
                  name={`${id}-color`}
                  value={c.id}
                  checked={setup.color === c.id}
                  onChange={() => usePlayStore.setState({ setup: { ...setup, color: c.id } })}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className={styles.field}>
          <span>Strength</span>
          <select
            value={setup.strength}
            onChange={(e) =>
              usePlayStore.setState({ setup: { ...setup, strength: e.target.value } })
            }
          >
            {STRENGTH_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Thinking time</span>
          <select
            value={setup.moveTime}
            onChange={(e) =>
              usePlayStore.setState({ setup: { ...setup, moveTime: Number(e.target.value) } })
            }
          >
            {MOVE_TIMES.map((t) => (
              <option key={t.ms} value={t.ms}>
                {t.label} per move
              </option>
            ))}
          </select>
        </label>
        <p className={styles.note}>
          Live analysis is paused during the game and resumes afterwards.
        </p>
        <button type="submit" className={styles.primary}>
          Start
        </button>
      </form>
    );
  }

  if (play.mode === 'playing') {
    const status = play.thinking
      ? 'Engine thinking…'
      : atTip
        ? 'Your move'
        : 'Your move (go to the last move to play)';
    return (
      <div className={styles.panel}>
        <p className={styles.meta}>{summary}</p>
        <p
          className={play.thinking ? styles.status : `${styles.status} ${styles.statusYou}`}
          data-testid="play-status"
          role="status"
          aria-live="polite"
        >
          {status}
        </p>
        <div className={styles.row}>
          <button type="button" onClick={play.takeBack} disabled={play.thinking || plies === 0}>
            Take back
          </button>
          <button type="button" onClick={play.resign}>
            Resign
          </button>
          <button type="button" onClick={play.stop}>
            Stop
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <p className={styles.meta}>{summary}</p>
      <div className={styles.result} role="status" aria-live="polite">
        <span className={styles.score} data-testid="play-result">
          {play.result ?? '*'}
        </span>
        <span>
          <strong>{verdict(play.result, play.playerColor)}</strong>
          {play.reason && <> — {REASON_TEXT[play.reason]}</>}
        </span>
      </div>
      {play.message && (
        <p className={styles.error} role="alert">
          {play.message}
        </p>
      )}
      <div className={styles.row}>
        <button type="button" className={styles.primary} onClick={play.rematch}>
          Rematch
        </button>
        <button type="button" onClick={() => void reviewThisGame(setTab)}>
          Review this game
        </button>
        <button type="button" onClick={play.stop}>
          New setup
        </button>
      </div>
    </div>
  );
}
