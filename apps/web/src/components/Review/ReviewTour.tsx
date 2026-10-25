import { useTourStore } from '../../review/tourStore';
import styles from './ReviewTour.module.css';

/**
 * Guided-tour bar of the Review panel (M20-2): progress through the highlights, play/pause, skip
 * to the next highlight and stop; the current highlight's text is a status region. After the tour
 * (finished or stopped) a "Replay tour" button remains.
 */
export function ReviewTour() {
  const status = useTourStore((s) => s.status);
  const total = useTourStore((s) => s.total);
  const reached = useTourStore((s) => s.reached);
  const text = useTourStore((s) => s.text);
  const { start, pause, resume, skip, stop } = useTourStore.getState();

  if (status === 'playing' || status === 'paused') {
    const playing = status === 'playing';
    return (
      <div className={styles.bar} data-testid="review-tour" data-status={status}>
        <div className={styles.row}>
          <span className={styles.label}>
            Tour: {reached} of {total} highlight{total === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            className={styles.btn}
            aria-label={playing ? 'Pause tour' : 'Resume tour'}
            onClick={playing ? pause : resume}
          >
            <span aria-hidden>{playing ? '⏸' : '▶'}</span>
          </button>
          <button
            type="button"
            className={styles.btn}
            aria-label="Skip to next highlight"
            onClick={skip}
          >
            Skip <span aria-hidden>▶|</span>
          </button>
          <button type="button" className={styles.btn} aria-label="Stop tour" onClick={stop}>
            Stop
          </button>
        </div>
        <p className={styles.text} role="status" data-testid="review-tour-text">
          {text}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.bar} data-testid="review-tour" data-status={status}>
      <div className={styles.row}>
        {status === 'finished' && (
          <span role="status" data-testid="review-tour-text">
            Tour finished — browse the moves or jump to a mistake.
          </span>
        )}
        {status === 'stopped' && (
          <span role="status" data-testid="review-tour-text">
            Tour stopped.
          </span>
        )}
        <button type="button" className={styles.btn} onClick={start}>
          Replay tour
        </button>
      </div>
    </div>
  );
}
