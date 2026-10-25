import { useState } from 'react';
import { errorText } from '../api';
import { usePortal } from '../context';
import { formatDate } from '../format';
import ui from '../ui.module.css';

export function Account() {
  const { api, me, signedOut } = usePortal();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const logout = (): void => {
    setBusy(true);
    api.logout().then(signedOut, (e: unknown) => {
      setError(errorText(e));
      setBusy(false);
    });
  };
  return (
    <section aria-labelledby="account-h">
      <h2 id="account-h">Account</h2>
      <dl className={ui.facts}>
        <dt>lichess account</dt>
        <dd>{me.operator.username}</dd>
        <dt>Role</dt>
        <dd>{me.operator.admin ? 'Administrator' : 'Operator'}</dd>
        <dt>Session valid until</dt>
        <dd>{formatDate(me.sessionExpiresAt)}</dd>
        <dt>Limits</dt>
        <dd>
          {me.limits.maxNodes} nodes, {me.limits.maxTokens} live tokens, {me.limits.poolTokens} pool tokens
        </dd>
      </dl>
      {error && (
        <p role="alert" className={ui.error}>
          {error}
        </p>
      )}
      <div className={ui.row}>
        <button type="button" className={ui.primary} disabled={busy} onClick={logout}>
          Log out
        </button>
      </div>
      <h3>Delete account</h3>
      <p>
        Deleting an account is not available in the portal yet. To have your account, nodes and tokens removed, contact the hub administrator.
      </p>
    </section>
  );
}
