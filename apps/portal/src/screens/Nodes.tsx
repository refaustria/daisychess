import { useState, type FormEvent } from 'react';
import { errorText, type CreatedNode } from '../api';
import { Badge } from '../components/Badge';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { CopyField } from '../components/CopyField';
import { SecretDialog } from '../components/SecretDialog';
import { useLoad } from '../components/useLoad';
import { usePortal } from '../context';
import { composeSnippet, formatAgo, formatDate, hubLinkUrl, npxSnippet } from '../format';
import type { NodeView } from '../types';
import ui from '../ui.module.css';

/** Status shown for a node: terminal and flagged states win over the link state. */
export function nodeStatusLabel(n: NodeView): string {
  if (n.revokedAt !== null) return 'revoked';
  if (n.state === 'disabled') return 'disabled';
  if (n.state === 'suspect') return 'suspect';
  return n.status;
}

type Action =
  | { kind: 'create' }
  | { kind: 'edit'; node: NodeView }
  | { kind: 'rotate'; node: NodeView }
  | { kind: 'revoke'; node: NodeView }
  | { kind: 'delete'; node: NodeView };

export function Nodes() {
  const { api, me } = usePortal();
  const nodes = useLoad(() => api.listNodes());
  const [action, setAction] = useState<Action | null>(null);
  // The node token exists here only until the dialog is closed.
  const [created, setCreated] = useState<(CreatedNode & { rotated: boolean }) | null>(null);
  const list = nodes.data ?? [];
  const active = list.filter((n) => n.revokedAt === null).length;

  const closeAction = (): void => setAction(null);
  const closeSecret = (): void => {
    setCreated(null);
    nodes.reload();
  };

  return (
    <section aria-labelledby="nodes-h">
      <div className={ui.sectionHead}>
        <h2 id="nodes-h">Nodes</h2>
        <button type="button" className={ui.primary} disabled={active >= me.limits.maxNodes} onClick={() => setAction({ kind: 'create' })}>
          Create node
        </button>
      </div>
      <p className={ui.muted}>
        A node is a machine that runs engines for your tokens (and, if you allow it, for the shared pool). {active} of {me.limits.maxNodes} used.
      </p>
      {nodes.error && (
        <p role="alert" className={ui.error}>
          {nodes.error} <button type="button" onClick={nodes.reload}>Retry</button>
        </p>
      )}
      {nodes.loading && !nodes.data ? (
        <p role="status">Loading nodes...</p>
      ) : list.length === 0 && !nodes.error ? (
        <p className={ui.empty}>No nodes yet. Create one to get a node token and the commands to run it.</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <caption className={ui.srOnly}>Your nodes</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Version</th>
                <th scope="col">Load</th>
                <th scope="col">Sessions</th>
                <th scope="col">Pool</th>
                <th scope="col">Last seen</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((n) => (
                <tr key={n.id}>
                  <th scope="row">
                    {n.name}
                    <div className={ui.muted}>{n.id}</div>
                  </th>
                  <td>
                    <Badge status={nodeStatusLabel(n)} />
                    {n.rotationOverlapUntil !== null && <div className={ui.muted}>old token valid until {formatDate(n.rotationOverlapUntil)}</div>}
                  </td>
                  <td>{n.live?.version ?? n.lastVersion ?? '-'}</td>
                  <td>{n.live?.load1 != null ? n.live.load1.toFixed(2) : '-'}</td>
                  <td>{n.live ? `${n.live.sessions ?? 0} / ${n.live.maxSessions}` : '-'}</td>
                  <td>
                    {n.pool ? `on (share ${n.poolShare})` : 'off'}
                    {n.live && n.pool && !n.live.inPool && <div className={ui.muted}>not in pool right now</div>}
                  </td>
                  <td title={formatDate(n.lastSeenAt)}>{formatAgo(n.lastSeenAt)}</td>
                  <td>
                    <div className={ui.actions}>
                      {n.revokedAt === null && (
                        <>
                          <button type="button" aria-label={`Edit ${n.name}`} onClick={() => setAction({ kind: 'edit', node: n })}>
                            Edit
                          </button>
                          <button type="button" aria-label={`Rotate token of ${n.name}`} onClick={() => setAction({ kind: 'rotate', node: n })}>
                            Rotate
                          </button>
                          <button type="button" aria-label={`Revoke ${n.name}`} onClick={() => setAction({ kind: 'revoke', node: n })}>
                            Revoke
                          </button>
                        </>
                      )}
                      <button type="button" className={ui.dangerText} aria-label={`Delete ${n.name}`} onClick={() => setAction({ kind: 'delete', node: n })}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {action?.kind === 'create' && (
        <NodeForm
          title="Create node"
          submitLabel="Create"
          onCancel={closeAction}
          onSubmit={async (v) => {
            const res = await api.createNode(v);
            setAction(null);
            setCreated({ ...res, rotated: false });
          }}
        />
      )}
      {action?.kind === 'edit' && (
        <NodeForm
          title={`Edit ${action.node.name}`}
          submitLabel="Save"
          initial={action.node}
          onCancel={closeAction}
          onSubmit={async (v) => {
            await api.updateNode(action.node.id, v);
            setAction(null);
            nodes.reload();
          }}
        />
      )}
      {action?.kind === 'rotate' && (
        <Confirm
          title={`Rotate token of ${action.node.name}`}
          message="A new node token is generated and shown once. The old token keeps working for a short overlap so you can restart the node with the new one."
          label="Rotate token"
          run={async () => {
            const res = await api.rotateNode(action.node.id);
            setAction(null);
            setCreated({ ...res, rotated: true });
          }}
          onCancel={closeAction}
        />
      )}
      {action?.kind === 'revoke' && (
        <Confirm
          title={`Revoke ${action.node.name}`}
          message="The node is disconnected now and can never connect again. Tokens that point at it fall back to their other settings."
          label="Revoke node"
          danger
          run={async () => {
            await api.revokeNode(action.node.id);
            setAction(null);
            nodes.reload();
          }}
          onCancel={closeAction}
        />
      )}
      {action?.kind === 'delete' && (
        <Confirm
          title={`Delete ${action.node.name}`}
          message="The node and its usage history are removed permanently. This cannot be undone."
          label="Delete node"
          danger
          run={async () => {
            await api.deleteNode(action.node.id);
            setAction(null);
            nodes.reload();
          }}
          onCancel={closeAction}
        />
      )}
      {created && (
        <SecretDialog
          title={created.rotated ? `New token for ${created.node.name}` : `Node ${created.node.name} created`}
          secretLabel="Node token"
          secret={created.nodeToken}
          onClose={closeSecret}
        >
          <RunSnippets token={created.nodeToken} pool={created.node.pool} />
        </SecretDialog>
      )}
    </section>
  );
}

function RunSnippets({ token, pool }: { token: string; pool: boolean }) {
  const hub = hubLinkUrl();
  return (
    <div className={ui.stack}>
      <h3>Run the node</h3>
      <CopyField label="docker-compose.yml" value={composeSnippet(hub, token, pool)} multiline />
      <p className={ui.muted}>Then run docker compose up -d. Or without Docker (Node 20+):</p>
      <CopyField label="npx command" value={npxSnippet(hub, token, pool)} />
    </div>
  );
}

function Confirm(props: { title: string; message: string; label: string; danger?: boolean; run: () => Promise<void>; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      title={props.title}
      message={props.message}
      confirmLabel={props.label}
      danger={props.danger ?? false}
      busy={busy}
      error={error}
      onCancel={props.onCancel}
      onConfirm={() => {
        setBusy(true);
        setError(null);
        props.run().catch((e: unknown) => {
          setError(errorText(e));
          setBusy(false);
        });
      }}
    />
  );
}

function NodeForm(props: {
  title: string;
  submitLabel: string;
  initial?: NodeView;
  onSubmit: (v: { name: string; pool: boolean; poolShare: number }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.initial?.name ?? '');
  const [pool, setPool] = useState(props.initial?.pool ?? false);
  const [share, setShare] = useState(String(props.initial?.poolShare ?? 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const poolShare = Number.parseInt(share, 10);
    if (!name.trim()) return setError('Give the node a name.');
    if (!Number.isInteger(poolShare) || poolShare < 0 || poolShare > 256) return setError('Pool share is a number from 0 to 256.');
    setBusy(true);
    setError(null);
    props.onSubmit({ name: name.trim(), pool, poolShare }).catch((err: unknown) => {
      setError(errorText(err));
      setBusy(false);
    });
  };

  return (
    <Dialog title={props.title} onClose={props.onCancel}>
      <form className={ui.stack} onSubmit={submit}>
        <label className={ui.field}>
          <span className={ui.label}>Name (max 32 characters)</span>
          <input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className={ui.check}>
          <input type="checkbox" checked={pool} onChange={(e) => setPool(e.target.checked)} />
          Offer spare capacity to the shared pool
        </label>
        <label className={ui.field}>
          <span className={ui.label}>Pool share (sessions donated to the pool)</span>
          <input type="number" min={0} max={256} value={share} onChange={(e) => setShare(e.target.value)} disabled={!pool} />
        </label>
        {error && (
          <p role="alert" className={ui.error}>
            {error}
          </p>
        )}
        <div className={ui.row}>
          <button type="submit" className={ui.primary} disabled={busy}>
            {props.submitLabel}
          </button>
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
