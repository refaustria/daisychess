import { useState } from 'react';
import { errorText } from '../api';
import { Badge } from '../components/Badge';
import { useLoad } from '../components/useLoad';
import { usePortal } from '../context';
import { formatAgo, formatDate } from '../format';
import type { NodeState } from '../types';
import ui from '../ui.module.css';
import { nodeStatusLabel } from './Nodes';

const STATES: NodeState[] = ['normal', 'suspect', 'disabled'];

/** Administrators only (the hub enforces it too: non-admins get 403). */
export function Admin() {
  const { api, me } = usePortal();
  const operators = useLoad(() => api.adminOperators());
  const nodes = useLoad(() => api.adminNodes());
  const [error, setError] = useState<string | null>(null);

  if (!me.operator.admin) return <p role="alert">Administrators only.</p>;

  const run = async (fn: () => Promise<unknown>, reload: () => void): Promise<void> => {
    setError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section aria-labelledby="admin-h">
      <h2 id="admin-h">Administration</h2>
      {(error ?? operators.error ?? nodes.error) && (
        <p role="alert" className={ui.error}>
          {error ?? operators.error ?? nodes.error}
        </p>
      )}
      <h3>Operators</h3>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <caption className={ui.srOnly}>All operators</caption>
          <thead>
            <tr>
              <th scope="col">Operator</th>
              <th scope="col">Status</th>
              <th scope="col">Nodes</th>
              <th scope="col">Live tokens</th>
              <th scope="col">Last login</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(operators.data ?? []).map((o) => (
              <tr key={o.id}>
                <th scope="row">
                  {o.username}
                  {o.admin && <span className={ui.muted}> (admin)</span>}
                </th>
                <td>
                  <Badge status={o.disabledAt === null ? 'active' : 'disabled'} />
                </td>
                <td>{o.nodes}</td>
                <td>{o.liveTokens}</td>
                <td title={formatDate(o.lastLoginAt)}>{formatAgo(o.lastLoginAt)}</td>
                <td>
                  {o.id !== me.operator.id && (
                    <button
                      type="button"
                      aria-label={`${o.disabledAt === null ? 'Disable' : 'Enable'} ${o.username}`}
                      onClick={() => void run(() => api.adminDisableOperator(o.id, o.disabledAt === null), operators.reload)}
                    >
                      {o.disabledAt === null ? 'Disable' : 'Enable'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>All nodes</h3>
      <div className={ui.tableWrap}>
        <table className={ui.table}>
          <caption className={ui.srOnly}>All nodes</caption>
          <thead>
            <tr>
              <th scope="col">Node</th>
              <th scope="col">Operator</th>
              <th scope="col">Status</th>
              <th scope="col">Version</th>
              <th scope="col">Pool</th>
              <th scope="col">Last seen</th>
              <th scope="col">State</th>
              <th scope="col">Pool ban</th>
            </tr>
          </thead>
          <tbody>
            {(nodes.data ?? []).map((n) => (
              <tr key={n.id}>
                <th scope="row">{n.name}</th>
                <td>{n.operatorUsername ?? n.operatorId}</td>
                <td>
                  <Badge status={nodeStatusLabel(n)} />
                </td>
                <td>{n.live?.version ?? n.lastVersion ?? '-'}</td>
                <td>{n.pool ? `on (${n.poolShare})` : 'off'}</td>
                <td title={formatDate(n.lastSeenAt)}>{formatAgo(n.lastSeenAt)}</td>
                <td>
                  <select
                    aria-label={`State of ${n.name}`}
                    value={n.state}
                    onChange={(e) => void run(() => api.adminNodeState(n.id, { state: e.target.value as NodeState }), nodes.reload)}
                  >
                    {STATES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    aria-label={`${n.poolBanned ? 'Lift pool ban of' : 'Ban from pool:'} ${n.name}`}
                    onClick={() => void run(() => api.adminNodeState(n.id, { poolBanned: !n.poolBanned }), nodes.reload)}
                  >
                    {n.poolBanned ? 'Lift pool ban' : 'Ban from pool'}
                  </button>
                  {n.poolBanned && n.poolBanReason && <div className={ui.muted}>{n.poolBanReason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
