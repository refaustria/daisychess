import { useMemo, useState } from 'react';
import { BarChart } from '../components/BarChart';
import { useLoad } from '../components/useLoad';
import { usePortal } from '../context';
import { formatDuration, lastDays } from '../format';
import type { UsageReport } from '../types';
import ui from '../ui.module.css';

type Metric = 'sessions' | 'searches' | 'engineMs';
const METRICS: { id: Metric; label: string; unit: string }[] = [
  { id: 'sessions', label: 'Sessions', unit: 'sessions' },
  { id: 'searches', label: 'Searches', unit: 'searches' },
  { id: 'engineMs', label: 'Engine time (seconds)', unit: 'seconds' },
];

export function Usage() {
  const { api } = usePortal();
  const nodes = useLoad(() => api.listNodes());
  const tokens = useLoad(() => api.listTokens());
  const [subject, setSubject] = useState<string>('');
  const [metric, setMetric] = useState<Metric>('sessions');

  const choices = useMemo(
    () => [
      ...(nodes.data ?? []).map((n) => ({ key: `node:${n.id}`, label: `Node: ${n.name}` })),
      ...(tokens.data ?? []).map((t) => ({ key: `token:${t.id}`, label: `Token: ${t.label || t.id}` })),
    ],
    [nodes.data, tokens.data],
  );
  const current = subject || choices[0]?.key || '';

  const usage = useLoad<UsageReport | null>(async () => {
    if (!current) return null;
    const [kind, id] = current.split(':') as [string, string];
    return kind === 'node' ? api.nodeUsage(id) : api.tokenUsage(id);
  }, current);

  const days = useMemo(() => {
    const byDay = new Map((usage.data?.days ?? []).map((d) => [d.day, d]));
    return lastDays(30).map((day) => {
      const d = byDay.get(day);
      return { day, sessions: d?.sessions ?? 0, searches: d?.searches ?? 0, engineMs: d?.engineMs ?? 0 };
    });
  }, [usage.data]);

  const m = METRICS.find((x) => x.id === metric) ?? METRICS[0]!;
  const value = (d: (typeof days)[number]): number => (metric === 'engineMs' ? Math.round(d.engineMs / 1000) : d[metric]);
  const loadError = nodes.error ?? tokens.error ?? usage.error;

  return (
    <section aria-labelledby="usage-h">
      <h2 id="usage-h">Usage</h2>
      <p className={ui.muted}>Last 30 days (UTC), per node or per token.</p>
      {loadError && (
        <p role="alert" className={ui.error}>
          {loadError}
        </p>
      )}
      {choices.length === 0 && !nodes.loading && !tokens.loading ? (
        <p className={ui.empty}>Create a node or a token first; usage appears here once it is used.</p>
      ) : (
        <>
          <div className={ui.row}>
            <label className={ui.field}>
              <span className={ui.label}>Show</span>
              <select value={current} onChange={(e) => setSubject(e.target.value)}>
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className={ui.field}>
              <span className={ui.label}>Metric</span>
              <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
                {METRICS.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {usage.loading && !usage.data ? (
            <p role="status">Loading usage...</p>
          ) : usage.data ? (
            <>
              <p>
                Total: {usage.data.total.sessions} sessions, {usage.data.total.searches} searches, {formatDuration(usage.data.total.engineMs)} engine time
              </p>
              <BarChart bars={days.map((d) => ({ label: d.day, value: value(d) }))} title={m.label} unit={m.unit} />
              <div className={ui.tableWrap}>
                <table className={ui.table}>
                  <caption>Usage per day (days without use omitted)</caption>
                  <thead>
                    <tr>
                      <th scope="col">Day (UTC)</th>
                      <th scope="col">Sessions</th>
                      <th scope="col">Searches</th>
                      <th scope="col">Engine time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {days.filter((d) => d.sessions || d.searches || d.engineMs).length === 0 ? (
                      <tr>
                        <td colSpan={4}>No usage in the last 30 days.</td>
                      </tr>
                    ) : (
                      days
                        .filter((d) => d.sessions || d.searches || d.engineMs)
                        .reverse()
                        .map((d) => (
                          <tr key={d.day}>
                            <th scope="row">{d.day}</th>
                            <td>{d.sessions}</td>
                            <td>{d.searches}</td>
                            <td>{formatDuration(d.engineMs)}</td>
                          </tr>
                        ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
