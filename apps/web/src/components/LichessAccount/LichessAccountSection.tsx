import { useId } from 'react';
import { SCOPE_LABEL, useLichessAuth } from '../../lichess/auth';
import styles from './LichessAccount.module.css';
import { LoginButton } from './LoginButton';

/** Settings → "lichess account": log in / logged in as / log out, granted scopes, token note. */
export function LichessAccountSection() {
  const id = useId();
  const { status, username, scopes, error, logout } = useLichessAuth();
  return (
    <section className={styles.section} aria-labelledby={`${id}-h`} data-testid="lichess-account">
      <h3 id={`${id}-h`} className={styles.legend}>
        lichess account
      </h3>
      {status === 'authenticated' ? (
        <>
          <p className={styles.line}>
            Logged in as{' '}
            <a href={`https://lichess.org/@/${encodeURIComponent(username ?? '')}`} target="_blank" rel="noopener noreferrer">
              <strong>{username}</strong>
            </a>
          </p>
          {scopes.length > 0 && (
            <ul className={styles.scopes} aria-label="Granted permissions">
              {scopes.map((s) => (
                <li key={s}>
                  <code>{s}</code> {SCOPE_LABEL[s] ?? ''}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className={styles.button} onClick={() => void logout()}>
            Log out
          </button>
        </>
      ) : (
        <>
          {status === 'error' && error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          <LoginButton />
        </>
      )}
      <p className={styles.help}>
        The login token is stored in this browser only and sent only to lichess. It is used for the opening
        explorer, for your own games in Import and for live games. Logging out revokes it on lichess.
      </p>
    </section>
  );
}
