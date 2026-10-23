import { useEffect } from 'react';
import { usePreviewStore } from '../../store/previewStore';
import styles from './PreviewBanner.module.css';

/** Banner over the board while an engine line is previewed; Esc or a click returns to the game. */
export function PreviewBanner() {
  const previewing = usePreviewStore((s) => s.fen !== null);
  const clear = usePreviewStore((s) => s.clear);
  useEffect(() => {
    if (!previewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewing, clear]);
  if (!previewing) return null;
  return (
    <button type="button" className={styles.banner} data-testid="preview-banner" onClick={clear}>
      Previewing line — Esc to return
    </button>
  );
}
