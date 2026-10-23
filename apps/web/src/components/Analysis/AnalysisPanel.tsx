import { formatScore, type Score } from '@chesslab/engine-core';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { convertPv } from '../../engine/pvToSan';
import {
  MAX_MULTIPV,
  useAnalysisStore,
  type AnalysisLine,
  type Backend,
} from '../../store/analysisStore';
import { usePreviewStore } from '../../store/previewStore';
import styles from './AnalysisPanel.module.css';

export const DEPTH_OPTIONS = [10, 14, 18, 22, 26, 30, 0];

export function formatNps(nps: number | undefined): string | null {
  if (nps === undefined || !Number.isFinite(nps)) return null;
  if (nps >= 1e6) return `${(nps / 1e6).toFixed(1)} MN/s`;
  if (nps >= 1e3) return `${Math.round(nps / 1e3)} kN/s`;
  return `${Math.round(nps)} N/s`;
}

export function scoreTone(score: Score): 'neutral' | 'positive' | 'negative' {
  if ('mate' in score) return score.mate > 0 ? 'positive' : 'negative';
  if (score.cp > 30) return 'positive';
  if (score.cp < -30) return 'negative';
  return 'neutral';
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

function withCurrent(options: number[], current: number): number[] {
  return options.includes(current) ? options : [...options, current].sort((x, y) => x - y);
}

const BACKENDS: { value: Backend; label: string }[] = [
  { value: 'wasm', label: 'Browser' },
  { value: 'remote', label: 'Server' },
];

interface LineRowProps {
  line: AnalysisLine;
  fen: string;
}

function LineRow({ line, fen }: LineRowProps) {
  const conv = useMemo(() => convertPv(fen, line.pv), [fen, line.pv]);
  const tone = scoreTone(line.score);
  const start = usePreviewStore((s) => s.start);
  const setHover = usePreviewStore((s) => s.setHover);
  return (
    <li className={styles.lineItem}>
      <button
        type="button"
        className={styles.line}
        data-testid="analysis-line"
        data-multipv={line.multipv}
        title="Click to preview this line"
        onMouseEnter={() => setHover(line.pv)}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(line.pv)}
        onBlur={() => setHover(null)}
        onClick={() => {
          if (conv.count > 0) start(conv.fen, conv.san);
        }}
      >
        <span className={`${styles.chip} ${styles[tone]}`} data-testid="analysis-eval">
          {formatScore(line.score)}
        </span>
        <span className={styles.depth}>d{line.depth}</span>
        <span className={styles.pv} data-testid="analysis-pv">
          {conv.text}
        </span>
      </button>
    </li>
  );
}

/** Live engine panel: header, settings, MultiPV lines in SAN. Rendered only while the engine is enabled. */
export function AnalysisPanel() {
  const enabled = useAnalysisStore((s) => s.enabled);
  const status = useAnalysisStore((s) => s.status);
  const engineName = useAnalysisStore((s) => s.engineName);
  const caps = useAnalysisStore((s) => s.capabilities);
  const settings = useAnalysisStore((s) => s.settings);
  const fen = useAnalysisStore((s) => s.fen);
  const terminal = useAnalysisStore((s) => s.terminal);
  const liveLines = useAnalysisStore((s) => s.lines);
  const setSettings = useAnalysisStore((s) => s.setSettings);
  const limits = useAnalysisStore((s) => s.remoteLimits);
  const lines = useDeferredValue(liveLines);
  const [open, setOpen] = useState(true);

  // Leaving the panel (engine off) must not leave arrows or a preview behind.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      usePreviewStore.getState().setHover(null);
      usePreviewStore.getState().clear();
    };
  }, [enabled]);

  if (!enabled) return null;

  const remote = settings.backend === 'remote';
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  const maxThreads = remote && limits ? limits.maxThreads : Math.max(1, hw - 1);
  const maxLines = remote && limits ? Math.min(MAX_MULTIPV, limits.maxMultipv) : MAX_MULTIPV;
  const maxDepth = remote && limits ? limits.maxDepth : Infinity;
  // The server clamps to its limits; show what will actually run.
  const threads = Math.min(settings.threads ?? caps?.threadCount ?? 1, maxThreads);
  const multipv = Math.min(settings.multipv, maxLines);
  const depthOptions = remote
    ? DEPTH_OPTIONS.filter((d) => d === 0 || d <= maxDepth)
    : withCurrent(DEPTH_OPTIONS, settings.depth);
  const threadsOk = caps?.threads ?? false;
  const name = engineName ? (/^Stockfish \S+/.exec(engineName)?.[0] ?? engineName) : 'Engine';
  const n = caps?.threadCount;
  const nps = formatNps(lines[0]?.nps);
  const depth = lines[0]?.depth;

  return (
    <section className={styles.panel} aria-label="Engine analysis" data-testid="analysis-panel">
      <button
        type="button"
        className={styles.header}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={styles.name}>{name}</span>
        <span className={styles.badge} data-testid="backend-badge">
          {remote ? 'Server' : 'Browser'}
        </span>
        <span className={styles.meta}>
          {[
            n !== undefined ? `${n} thread${n === 1 ? '' : 's'}` : null,
            caps?.build ?? null,
            depth !== undefined ? `depth ${depth}` : null,
            nps,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span className={styles.caret} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <>
          <div className={styles.settings}>
            <div className={styles.segmented} role="radiogroup" aria-label="Engine location">
              {BACKENDS.map((b) => (
                <button
                  key={b.value}
                  type="button"
                  role="radio"
                  aria-checked={settings.backend === b.value}
                  className={
                    settings.backend === b.value
                      ? `${styles.segment} ${styles.segmentOn}`
                      : styles.segment
                  }
                  onClick={() => {
                    if (settings.backend !== b.value) setSettings({ backend: b.value });
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>
            <label className={styles.setting}>
              Depth
              <select
                value={settings.depth}
                onChange={(e) => setSettings({ depth: Number(e.currentTarget.value) })}
              >
                {depthOptions.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? '∞' : d}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.setting}>
              Lines
              <select
                value={multipv}
                onChange={(e) => setSettings({ multipv: Number(e.currentTarget.value) })}
              >
                {range(1, maxLines).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label
              className={styles.setting}
              title={
                threadsOk ? undefined : 'Multi-threading is not available in this browser build'
              }
            >
              Threads
              <select
                value={threads}
                disabled={!threadsOk}
                onChange={(e) => setSettings({ threads: Number(e.currentTarget.value) })}
              >
                {(remote ? range(1, maxThreads) : withCurrent(range(1, maxThreads), threads)).map(
                  (t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
          {terminal ? (
            <p className={styles.empty}>
              {terminal === 'checkmate' ? 'Checkmate' : 'Stalemate'}: nothing to analyse.
            </p>
          ) : lines.length === 0 ? (
            <p className={styles.empty}>
              {status === 'error' ? 'Engine unavailable.' : 'Thinking…'}
            </p>
          ) : (
            <ol className={styles.lines} data-testid="analysis-lines">
              {lines.map((l) => (
                <LineRow key={l.multipv} line={l} fen={fen} />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}
