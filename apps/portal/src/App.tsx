import '@daisychess/ui-theme/base.css';
import { useEffect, useMemo, useState } from 'react';
import { createApi, errorText, ApiError, type PortalApi } from './api';
import { completeLoginFromUrl, startLogin, type LichessDeps } from './auth/lichess';
import { PortalContext } from './context';
import { Account } from './screens/Account';
import { Admin } from './screens/Admin';
import { Nodes } from './screens/Nodes';
import { Tokens } from './screens/Tokens';
import { Usage } from './screens/Usage';
import type { Me } from './types';
import ui from './ui.module.css';
import styles from './App.module.css';

type Session = { status: 'loading' } | { status: 'anonymous'; error?: string } | { status: 'authed'; me: Me };
type Tab = 'nodes' | 'tokens' | 'usage' | 'admin' | 'account';

export interface AppProps {
  /** Test hook: the fetch used for the hub API. */
  fetchImpl?: typeof fetch;
  /** Test hook: fetch + navigation used for lichess. */
  lichess?: LichessDeps;
}

export function App({ fetchImpl, lichess }: AppProps) {
  const [session, setSession] = useState<Session>({ status: 'loading' });

  const api: PortalApi = useMemo(
    () =>
      createApi({
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
        onUnauthorized: () => setSession((s) => (s.status === 'authed' ? { status: 'anonymous', error: 'Your session has ended. Please log in again.' } : s)),
      }),
    [fetchImpl],
  );

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await completeLoginFromUrl(api, lichess);
      if (!live) return;
      if (result.kind === 'ok') return setSession({ status: 'authed', me: result.me });
      if (result.kind === 'error') return setSession({ status: 'anonymous', error: result.message });
      try {
        const me = await api.me();
        if (live) setSession({ status: 'authed', me });
      } catch (e) {
        if (!live) return;
        // 401 = simply not logged in; anything else is worth saying.
        setSession(e instanceof ApiError && e.status === 401 ? { status: 'anonymous' } : { status: 'anonymous', error: errorText(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [api, lichess]);

  if (session.status === 'loading') {
    return (
      <main className={styles.center}>
        <p role="status">Loading...</p>
      </main>
    );
  }
  if (session.status === 'anonymous') return <Login error={session.error} lichess={lichess} />;
  return (
    <PortalContext.Provider value={{ api, me: session.me, signedOut: () => setSession({ status: 'anonymous' }) }}>
      <Shell me={session.me} />
    </PortalContext.Provider>
  );
}

function Login({ error, lichess }: { error?: string | undefined; lichess?: LichessDeps | undefined }) {
  const [err, setErr] = useState(error);
  const [busy, setBusy] = useState(false);
  return (
    <main className={styles.center}>
      <div className={styles.card}>
        <h1>DaisyChess operator portal</h1>
        <p>Run engine nodes for yourself and your friends, and manage the tokens that use them.</p>
        <p className={ui.muted}>
          You log in with your lichess account. The portal asks for no permissions: it only learns your lichess user name, and the temporary lichess token is revoked right after login.
        </p>
        {err && (
          <p role="alert" className={ui.error}>
            {err}
          </p>
        )}
        <button
          type="button"
          className={ui.primary}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setErr(undefined);
            startLogin(lichess).catch((e: unknown) => {
              setErr(e instanceof Error ? e.message : 'Login failed.');
              setBusy(false);
            });
          }}
        >
          Log in with lichess
        </button>
      </div>
    </main>
  );
}

function Shell({ me }: { me: Me }) {
  const [tab, setTab] = useState<Tab>('nodes');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'nodes', label: 'Nodes' },
    { id: 'tokens', label: 'Tokens' },
    { id: 'usage', label: 'Usage' },
    ...(me.operator.admin ? [{ id: 'admin' as const, label: 'Admin' }] : []),
    { id: 'account', label: 'Account' },
  ];
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <strong>DaisyChess portal</strong>
        <nav aria-label="Portal sections" className={styles.nav}>
          {tabs.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? styles.tabActive : styles.tab} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <span className={ui.muted}>{me.operator.username}</span>
      </header>
      <main className={styles.main}>
        {tab === 'nodes' && <Nodes />}
        {tab === 'tokens' && <Tokens />}
        {tab === 'usage' && <Usage />}
        {tab === 'admin' && <Admin />}
        {tab === 'account' && <Account />}
      </main>
    </div>
  );
}
