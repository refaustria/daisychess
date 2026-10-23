import { useLichessAuth } from '../../lichess/auth';
import { useUiStore } from '../../store/uiStore';
import styles from './LichessAccount.module.css';

/** Header chip: the lichess username (or "Log in"); opens the Settings tab with the account section. */
export function AccountChip() {
  const status = useLichessAuth((s) => s.status);
  const username = useLichessAuth((s) => s.username);
  const error = useLichessAuth((s) => s.error);
  const authed = status === 'authenticated' && username !== undefined;
  const text = authed ? username : status === 'authorizing' ? 'Logging in…' : 'Log in';
  const label = authed ? `lichess account ${username}, open settings` : 'Log in with lichess, open settings';
  return (
    <button
      type="button"
      className={status === 'error' ? `${styles.chip} ${styles.chipError}` : styles.chip}
      data-testid="account-chip"
      aria-label={label}
      title={status === 'error' && error ? error : label}
      onClick={() => useUiStore.getState().setActiveTab('settings')}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
      <span className={styles.chipText}>{text}</span>
    </button>
  );
}
