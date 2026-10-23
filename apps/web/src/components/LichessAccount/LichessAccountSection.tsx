import { useId, useState, type FormEvent } from 'react';
import { LICHESS_SCOPES, LICHESS_TOKEN_CREATE_URL, SCOPE_LABEL, useLichessAuth } from '../../lichess/auth';
import styles from './LichessAccount.module.css';
import { LoginButton } from './LoginButton';

/** Collapsible "personal access token" login (alternative to the OAuth redirect). */
function TokenLogin() {
  const id = useId();
  const status = useLichessAuth((s) => s.status);
  const loginWithToken = useLichessAuth((s) => s.loginWithToken);
  const [draft, setDraft] = useState('');
  const [shown, setShown] = useState(false);
  const busy = status === 'authorizing';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // The store reports the reason (rendered as the alert above); the token is dropped from the form.
    loginWithToken(draft).then(
      () => setDraft(''),
      () => undefined,
    );
  };

  return (
    <details className={styles.details}>
      <summary>Use a personal access token instead</summary>
      <form className={styles.tokenForm} onSubmit={submit}>
        <p className={styles.help}>
          <a href={LICHESS_TOKEN_CREATE_URL} target="_blank" rel="noopener noreferrer">
            Create a token on lichess
          </a>{' '}
          with the permissions {LICHESS_SCOPES.map((x) => `"${x}"`).join(', ')}, then paste it here.
        </p>
        <label htmlFor={`${id}-t`}>Personal access token</label>
        <div className={styles.tokenRow}>
          <input
            id={`${id}-t`}
            className={styles.input}
            type={shown ? 'text' : 'password'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="lip_…"
          />
          <button type="button" className={styles.button} aria-label={shown ? 'Hide lichess token' : 'Show lichess token'} onClick={() => setShown((v) => !v)}>
            {shown ? 'Hide' : 'Show'}
          </button>
        </div>
        <button type="submit" className={styles.button} disabled={busy || !draft.trim()}>
          {busy ? 'Checking…' : 'Save lichess token'}
        </button>
      </form>
    </details>
  );
}

/** Settings → "lichess account": log in / logged in as / log out, granted scopes, token note. */
export function LichessAccountSection() {
  const id = useId();
  const { status, source, username, scopes, error, logout } = useLichessAuth();
  const missing = LICHESS_SCOPES.filter((x) => !scopes.includes(x));
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
          <p className={styles.help}>{source === 'token' ? 'via token' : 'via lichess login'}</p>
          <ul className={styles.scopes} aria-label="Granted permissions">
            {LICHESS_SCOPES.map((sc) => (
              <li key={sc}>
                <span aria-label={scopes.includes(sc) ? 'granted' : 'missing'}>{scopes.includes(sc) ? '✓' : '✗'}</span>{' '}
                <code>{sc}</code> {SCOPE_LABEL[sc] ?? ''}
              </li>
            ))}
          </ul>
          {missing.length > 0 && (
            <p className={styles.error}>Create a new token with the missing permissions: {missing.join(', ')}.</p>
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
          <TokenLogin />
        </>
      )}
      <p className={styles.help}>
        The login token is stored in this browser only and sent only to lichess. It is used for the opening
        explorer, for your own games in Import and for live games. Logging out of a lichess login revokes it on
        lichess; a pasted token is only forgotten here and stays valid on lichess.
      </p>
    </section>
  );
}
