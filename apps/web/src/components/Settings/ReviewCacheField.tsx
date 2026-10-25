import { useEffect, useId, useState } from 'react';
import { countStoredReviews, onReviewCacheChange } from '../../review/reviewCache';
import { clearReviewCaches } from '../../review/reviewStore';
import styles from './SettingsPanel.module.css';

/** "Review cache" row (ADR-016): number of stored reviews and a button to clear them. */
export function ReviewCacheField() {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void countStoredReviews().then((n) => {
        if (alive) setCount(n);
      });
    };
    refresh();
    const unsubscribe = onReviewCacheChange(refresh);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  const clear = async () => {
    setBusy(true);
    try {
      await clearReviewCaches();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.group} role="group" aria-labelledby={`${id}-legend`}>
      <span id={`${id}-legend`} className={styles.legend}>
        Review cache
      </span>
      <div className={styles.row}>
        <span data-testid="review-cache-count" aria-live="polite">
          {count === null
            ? 'Counting stored reviews…'
            : `${count} stored review${count === 1 ? '' : 's'}`}
        </span>
        <button
          type="button"
          className={styles.reset}
          disabled={busy || count === 0}
          onClick={() => void clear()}
        >
          Clear cache
        </button>
      </div>
      <p className={styles.help}>
        Finished reviews are kept in this browser, so a game is never reviewed twice with the same
        depth.
      </p>
    </div>
  );
}
