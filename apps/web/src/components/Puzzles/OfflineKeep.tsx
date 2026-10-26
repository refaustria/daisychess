import { useEffect, useRef, useState } from 'react';
import { formatBytes, offlineInfo, type OfflineInfo } from '../../puzzles/filterOptions';
import type { PrefetchProgress } from '../../puzzles/source';
import { usePuzzleStore } from '../../puzzles/puzzleStore';
import styles from './PuzzlesPanel.module.css';

/** "Keep puzzles for offline use": size hint, progress and cancel (M30-3 `prefetchOffline`). */
export function OfflineKeep() {
  const rating = usePuzzleStore((s) => s.rating.rating);
  const [info, setInfo] = useState<OfflineInfo | null | undefined>(undefined);
  const [progress, setProgress] = useState<PrefetchProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    void offlineInfo(rating).then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [rating]);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    const ctl = new AbortController();
    abort.current = ctl;
    setRunning(true);
    setResult('');
    try {
      const { prefetchOffline } = await import('../../puzzles/source');
      const r = await prefetchOffline(rating, { onProgress: setProgress, signal: ctl.signal });
      if (r.reason === 'no-index') setResult('Puzzles are not available to download right now.');
      else if (r.reason === 'cancelled') setResult('Cancelled.');
      else if (r.failed > 0)
        setResult(`Kept ${r.done - r.failed} of ${r.total} sets; ${r.failed} could not be loaded.`);
      else setResult(`Done: ${formatBytes(r.bytes)} of puzzles kept for offline use.`);
    } catch {
      setResult('Could not keep puzzles for offline use.');
    } finally {
      setRunning(false);
      abort.current = null;
    }
  };

  return (
    <div className={styles.offline}>
      <div className={styles.row}>
        <button type="button" disabled={running || info === null} onClick={() => void start()}>
          Keep puzzles for offline use{info ? ` (about ${formatBytes(info.bytes)})` : ''}
        </button>
        {running && (
          <button type="button" onClick={() => abort.current?.abort()}>
            Cancel
          </button>
        )}
      </div>
      {running && progress && (
        <progress
          max={Math.max(progress.total, 1)}
          value={progress.done}
          aria-label="Download progress"
        />
      )}
      <p className={styles.note} role="status" data-testid="puzzle-offline-status">
        {running && progress
          ? `Downloading ${progress.done} of ${progress.total}…`
          : result ||
            (info === null
              ? 'Puzzles can be kept offline once the puzzle list has loaded (needs a connection).'
              : 'Downloads puzzles around your rating so they work without a connection.')}
      </p>
    </div>
  );
}
