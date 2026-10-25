import { useEffect, useId, useState } from 'react';
import { countStoredReviews, onReviewCacheChange } from '../../review/reviewCache';
import { clearReviewCaches } from '../../review/reviewStore';
import {
  fetchServerReviewStats,
  type ServerReviewStats,
} from '../../review/serverReviewStore';
import styles from './SettingsPanel.module.css';

/** `1.2 GB` / `340 MB` / `12 kB` (one decimal for GB and MB). */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${bytes} B`;
}

/** "Server: 123 reviews · 1.2 GB of 5 GB" */
export function serverStatsLabel(s: ServerReviewStats): string {
  const max = s.maxBytes >= 1e9 ? `${+(s.maxBytes / 1e9).toFixed(1)} GB` : formatBytes(s.maxBytes);
  return `Server: ${s.reviews} review${s.reviews === 1 ? '' : 's'} · ${formatBytes(s.bytes)} of ${max}`;
}

/**
 * "Review cache" row (ADR-016/017): number of stored reviews, the server store's size when the
 * engine server reports one, and a button to clear the local cache.
 */
export function ReviewCacheField() {
  const [count, setCount] = useState<number | null>(null);
  const [server, setServer] = useState<ServerReviewStats | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void countStoredReviews().then((n) => {
        if (alive) setCount(n);
      });
      void fetchServerReviewStats().then((s) => {
        if (alive) setServer(s && s.enabled ? s : null);
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
      {server && (
        <div className={styles.row}>
          <span data-testid="review-cache-server">{serverStatsLabel(server)}</span>
        </div>
      )}
      <p className={styles.help}>
        Finished reviews are kept in this browser, so a game is never reviewed twice with the same
        depth. The engine server keeps finished reviews too, shared by every device; clearing only
        affects this browser.
      </p>
    </div>
  );
}
