import { useEffect } from 'react';
import { useUiStore } from '../../store/uiStore';
import styles from './Notice.module.css';

export const NOTICE_MS = 8000;

/** One-time notice bar (e.g. "Server access token saved on this device"); dismisses itself. */
export function Notice() {
  const notice = useUiStore((s) => s.notice);
  const dismiss = useUiStore((s) => s.dismissNotice);
  useEffect(() => {
    if (notice === null) return;
    const t = setTimeout(dismiss, NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, dismiss]);
  if (notice === null) return null;
  return (
    <div className={styles.notice} role="status" data-testid="app-notice">
      <span>{notice}</span>
      <button type="button" className={styles.close} onClick={dismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
