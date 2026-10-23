import { LICHESS_SCOPES, useLichessAuth } from '../../lichess/auth';
import styles from './LichessAccount.module.css';

export const LOGIN_TOOLTIP = `Log in on lichess.org and allow ChessLab: ${LICHESS_SCOPES.join(', ')}`;

/** Starts the lichess OAuth login (a full-page redirect to lichess.org). */
export function LoginButton({ label = 'Log in with lichess' }: { label?: string }) {
  const status = useLichessAuth((s) => s.status);
  const login = useLichessAuth((s) => s.login);
  return (
    <button
      type="button"
      className={styles.button}
      title={LOGIN_TOOLTIP}
      disabled={status === 'authorizing'}
      onClick={() => void login()}
    >
      {status === 'authorizing' ? 'Logging in…' : label}
    </button>
  );
}
