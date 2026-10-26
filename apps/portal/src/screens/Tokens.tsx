import { useState, type FormEvent } from 'react';
import { errorText, type CreatedToken } from '../api';
import { Badge } from '../components/Badge';
import { ConfirmDialog, Dialog } from '../components/Dialog';
import { SecretDialog } from '../components/SecretDialog';
import { useLoad } from '../components/useLoad';
import { usePortal } from '../context';
import { formatAgo, formatDate } from '../format';
import type { NodeView, TokenCreateInput, TokenKind, TokenPatchInput, TokenTier, TokenView } from '../types';
import ui from '../ui.module.css';

const TIERS: TokenTier[] = ['small', 'standard', 'full'];
const EXPIRY: { value: string; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

type Action = { kind: 'create' } | { kind: 'edit'; token: TokenView } | { kind: 'revoke'; token: TokenView };

export function Tokens() {
  const { api, me } = usePortal();
  const tokens = useLoad(() => api.listTokens());
  const nodes = useLoad(() => api.listNodes());
  const [action, setAction] = useState<Action | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const list = tokens.data ?? [];
  const nodeList = nodes.data ?? [];
  const live = list.filter((t) => t.status === 'active').length;

  const nodeName = (id: string): string =>
    id === 'local' ? 'hub (built-in)' : (nodeList.find((n) => n.id === id)?.name ?? id);

  return (
    <section aria-labelledby="tokens-h">
      <div className={ui.sectionHead}>
        <h2 id="tokens-h">Tokens</h2>
        <button type="button" className={ui.primary} disabled={live >= me.limits.maxTokens} onClick={() => setAction({ kind: 'create' })}>
          Create token
        </button>
      </div>
      <p className={ui.muted}>
        Player tokens let you and your friends use your nodes from the DaisyChess app. Pool tokens grant access to the shared pool. {live} of {me.limits.maxTokens} live tokens used.
      </p>
      {tokens.error && (
        <p role="alert" className={ui.error}>
          {tokens.error} <button type="button" onClick={tokens.reload}>Retry</button>
        </p>
      )}
      {tokens.loading && !tokens.data ? (
        <p role="status">Loading tokens...</p>
      ) : list.length === 0 && !tokens.error ? (
        <p className={ui.empty}>No tokens yet.</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <caption className={ui.srOnly}>Your tokens</caption>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Status</th>
                <th scope="col">Kind</th>
                <th scope="col">Nodes</th>
                <th scope="col">Tier</th>
                <th scope="col">Pool fallback</th>
                <th scope="col">Expires</th>
                <th scope="col">Last used</th>
                <th scope="col">Connections</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <th scope="row">
                    {t.label || <span className={ui.muted}>(no label)</span>}
                    <div className={ui.muted}>{t.id}</div>
                  </th>
                  <td>
                    <Badge status={t.status} />
                  </td>
                  <td>{t.kind}</td>
                  <td>{t.nodeIds.length ? t.nodeIds.map(nodeName).join(', ') : t.kind === 'pool' ? 'pool' : 'any'}</td>
                  <td>{t.tier}</td>
                  <td>{t.poolFallback ? 'yes' : 'no'}</td>
                  <td>{t.expiresAt === null ? 'never' : formatDate(t.expiresAt)}</td>
                  <td title={formatDate(t.lastUsedAt)}>{formatAgo(t.lastUsedAt)}</td>
                  <td>{t.connections}</td>
                  <td>
                    <div className={ui.actions}>
                      {t.status !== 'revoked' && (
                        <>
                          <button type="button" aria-label={`Edit token ${t.label || t.id}`} onClick={() => setAction({ kind: 'edit', token: t })}>
                            Edit
                          </button>
                          <button type="button" className={ui.dangerText} aria-label={`Revoke token ${t.label || t.id}`} onClick={() => setAction({ kind: 'revoke', token: t })}>
                            Revoke
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {action?.kind === 'create' && (
        <TokenForm
          title="Create token"
          submitLabel="Create"
          nodes={nodeList}
          maxPool={me.limits.poolTokens}
          onCancel={() => setAction(null)}
          onSubmit={async (v) => {
            const input: TokenCreateInput = { kind: v.kind };
            if (v.label) input.label = v.label;
            if (v.nodeIds) input.nodeIds = v.nodeIds;
            if (v.poolFallback !== undefined) input.poolFallback = v.poolFallback;
            if (v.tier) input.tier = v.tier;
            if (v.expiresInDays !== undefined) input.expiresInDays = v.expiresInDays;
            const res = await api.createToken(input);
            setAction(null);
            setCreated(res);
          }}
        />
      )}
      {action?.kind === 'edit' && (
        <TokenForm
          title="Edit token"
          submitLabel="Save"
          nodes={nodeList}
          maxPool={me.limits.poolTokens}
          initial={action.token}
          onCancel={() => setAction(null)}
          onSubmit={async (v) => {
            const patch: TokenPatchInput = { label: v.label ?? '', poolFallback: v.poolFallback ?? false };
            if (v.tier) patch.tier = v.tier;
            if (action.token.kind === 'player') patch.nodeIds = v.nodeIds ?? [];
            if (v.expiry === 'never') patch.expiresAt = null;
            else if (v.expiresInDays !== undefined) patch.expiresInDays = v.expiresInDays;
            await api.updateToken(action.token.id, patch);
            setAction(null);
            tokens.reload();
          }}
        />
      )}
      {action?.kind === 'revoke' && <RevokeConfirm token={action.token} onCancel={() => setAction(null)} onDone={() => { setAction(null); tokens.reload(); }} />}
      {created && (
        <SecretDialog
          title="Token created"
          secretLabel="Player token"
          secret={created.playerToken}
          setupLink={created.setupLink}
          appLink={created.appLink ?? null}
          onClose={() => {
            setCreated(null);
            tokens.reload();
          }}
        >
          {!created.setupLink && (
            <p className={ui.muted}>
              This hub has no public origin configured, so no setup link was generated. Paste the token into Settings, Engine server, in the DaisyChess app.
            </p>
          )}
        </SecretDialog>
      )}
    </section>
  );
}

function RevokeConfirm({ token, onCancel, onDone }: { token: TokenView; onCancel: () => void; onDone: () => void }) {
  const { api } = usePortal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmDialog
      title={`Revoke token ${token.label || token.id}`}
      message={`Anyone using this token loses access immediately${token.connections ? ` and its ${token.connections} open connection(s) are closed` : ''}. This cannot be undone.`}
      confirmLabel="Revoke token"
      danger
      busy={busy}
      error={error}
      onCancel={onCancel}
      onConfirm={() => {
        setBusy(true);
        api.revokeToken(token.id).then(onDone, (e: unknown) => {
          setError(errorText(e));
          setBusy(false);
        });
      }}
    />
  );
}

interface FormValues {
  kind: TokenKind;
  label?: string;
  nodeIds?: string[];
  poolFallback?: boolean;
  tier?: TokenTier;
  expiresInDays?: number;
  /** 'never' | 'keep' | 'days' (edit only distinguishes keep). */
  expiry: string;
}

function TokenForm(props: {
  title: string;
  submitLabel: string;
  nodes: NodeView[];
  maxPool: number;
  initial?: TokenView;
  onSubmit: (v: FormValues) => Promise<void>;
  onCancel: () => void;
}) {
  const editing = props.initial !== undefined;
  const [kind, setKind] = useState<TokenKind>(props.initial?.kind ?? 'player');
  const [label, setLabel] = useState(props.initial?.label ?? '');
  const [nodeIds, setNodeIds] = useState<string[]>(props.initial?.nodeIds ?? []);
  const [fallback, setFallback] = useState(props.initial?.poolFallback ?? false);
  const [tier, setTier] = useState<TokenTier>(props.initial?.tier ?? 'standard');
  const [expiry, setExpiry] = useState(editing ? 'keep' : 'never');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectable = props.nodes.filter((n) => n.revokedAt === null);

  const toggle = (id: string): void => setNodeIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const v: FormValues = { kind, label: label.trim(), poolFallback: fallback, tier, expiry };
    if (kind === 'player') v.nodeIds = nodeIds;
    if (expiry !== 'never' && expiry !== 'keep') v.expiresInDays = Number(expiry);
    props.onSubmit(v).catch((err: unknown) => {
      setError(errorText(err));
      setBusy(false);
    });
  };

  return (
    <Dialog title={props.title} onClose={props.onCancel}>
      <form className={ui.stack} onSubmit={submit}>
        {!editing && (
          <fieldset className={ui.fieldset}>
            <legend className={ui.label}>Kind</legend>
            <label className={ui.check}>
              <input type="radio" name="kind" checked={kind === 'player'} onChange={() => setKind('player')} />
              Player token (your nodes)
            </label>
            <label className={ui.check}>
              <input type="radio" name="kind" checked={kind === 'pool'} onChange={() => setKind('pool')} />
              Pool token (shared pool, max {props.maxPool} live)
            </label>
          </fieldset>
        )}
        <label className={ui.field}>
          <span className={ui.label}>Label (who or what is it for)</span>
          <input value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} />
        </label>
        {kind === 'player' && (
          <fieldset className={ui.fieldset}>
            <legend className={ui.label}>Nodes this token may use</legend>
            {selectable.length === 0 ? (
              <p className={ui.muted}>You have no nodes yet; the token will use the pool if fallback is on.</p>
            ) : (
              selectable.map((n) => (
                <label key={n.id} className={ui.check}>
                  <input type="checkbox" checked={nodeIds.includes(n.id)} onChange={() => toggle(n.id)} />
                  {n.name}
                </label>
              ))
            )}
          </fieldset>
        )}
        <label className={ui.field}>
          <span className={ui.label}>Tier</span>
          <select value={tier} onChange={(e) => setTier(e.target.value as TokenTier)}>
            {TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        {kind === 'player' && (
          <label className={ui.check}>
            <input type="checkbox" checked={fallback} onChange={(e) => setFallback(e.target.checked)} />
            Fall back to the shared pool when none of the nodes is available
          </label>
        )}
        <label className={ui.field}>
          <span className={ui.label}>Expires</span>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {editing && <option value="keep">Keep current ({props.initial?.expiresAt == null ? 'never' : formatDate(props.initial.expiresAt)})</option>}
            {EXPIRY.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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
