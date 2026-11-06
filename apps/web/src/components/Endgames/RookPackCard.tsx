import { useEffect } from 'react';
import { formatBytes, packSize } from '../../endgames/tablePacks';
import { useTablebaseStore } from '../../endgames/tablebaseStore';
import styles from './EndgamesPanel.module.css';

/**
 * The rook endgames download for the trainer (ADR-025 §6, §9): the size from the manifest before
 * starting, progress, cancel, errors. Runs only on request. Renders nothing once the pack is
 * ready unless `showReady` is set.
 */
export function RookPackCard({ showReady = false }: { showReady?: boolean }) {
  const pack = useTablebaseStore((s) => s.packs.rook);
  const download = useTablebaseStore((s) => s.downloadPack);
  const cancel = useTablebaseStore((s) => s.cancelDownload);
  const refresh = useTablebaseStore((s) => s.refreshPacks);
  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const state = pack.status?.state ?? 'absent';
  if (state === 'ready' && pack.busy === null && !showReady) return null;
  const total = pack.status?.totalBytes ?? packSize('rook');
  const loaded = pack.progress?.loaded ?? pack.status?.storedBytes ?? 0;
  const size = formatBytes(total);

  let text: string;
  if (pack.busy === 'download') text = `Downloading… ${formatBytes(loaded)} of ${size}`;
  else if (state === 'ready')
    text = `Downloaded (${size}). Rook endings work without a connection.`;
  else if (state === 'partial') text = `Partly downloaded (${formatBytes(loaded)} of ${size}).`;
  else text = `Rook endings need the lichess tablebase, or a one-time download of ${size}.`;

  return (
    <section className={styles.card} aria-label="Rook endings offline" data-testid="rook-pack">
      <p className={styles.note} role="status" data-testid="rook-pack-status">
        {text}
      </p>
      {pack.busy === 'download' && (
        <progress value={loaded} max={total} aria-label="Rook endings download" />
      )}
      <div className={styles.row}>
        {pack.busy === 'download' ? (
          <button type="button" onClick={cancel}>
            Cancel download
          </button>
        ) : (
          state !== 'ready' && (
            <button
              type="button"
              disabled={pack.busy !== null}
              data-testid="rook-pack-download"
              onClick={() => void download('rook')}
            >
              {state === 'partial' ? 'Resume download' : `Download (${size})`}
            </button>
          )
        )}
      </div>
      {pack.error && (
        <p className={styles.error} role="alert">
          {pack.error}
        </p>
      )}
    </section>
  );
}
