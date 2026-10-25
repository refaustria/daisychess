import { formatScore, type Score } from '@daisychess/engine-core';
import {
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { convertPv } from '../../engine/pvToSan';
import {
  describeEngine,
  formatDownload,
  listEngines,
  maxWasmThreads,
  shortEngineName,
  type EngineDescriptor,
} from '../../engine/registry';
import {
  ENGINE_SETTING_FIELDS,
  isRemoteKey,
  MAX_MULTIPV,
  newInstance,
  useAnalysisStore,
  type AnalysisLine,
  type EngineInstanceState,
  type EngineSettingsOverride,
  type EngineSettingsPatch,
} from '../../store/analysisStore';
import {
  authMessage,
  displayError,
  isAuthError,
  isDeniedText,
  isTokenFixText,
} from '../../server/tokenMessages';
import { nodeParts } from '../EngineToggle/EngineToggle';
import { OpenSettingsButton } from '../Settings/OpenSettingsButton';
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

/** Short tab/chip label: from the engine's own name once loaded, else from the registry. */
export function shortLabel(
  d: EngineDescriptor,
  i: Pick<EngineInstanceState, 'engineName'>,
): string {
  return i.engineName ? shortEngineName(i.engineName) : d.short;
}

/** Status dot of an engine tab. */
export function instanceDot(
  i: Pick<EngineInstanceState, 'status' | 'backendStatus'>,
): 'error' | 'loading' | 'analysing' | 'ready' | 'idle' {
  if (i.status === 'error' || i.backendStatus === 'closed') return 'error';
  if (i.status === 'loading') return 'loading';
  return i.status;
}

/** localStorage flag: the user agreed to the large download of the full browser build once. */
export const FULL_BUILD_CONFIRMED_KEY = 'daisychess.fullBuildConfirmed';

function downloadConfirmed(): boolean {
  try {
    return localStorage.getItem(FULL_BUILD_CONFIRMED_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberDownloadConfirmed(): void {
  try {
    localStorage.setItem(FULL_BUILD_CONFIRMED_KEY, '1');
  } catch {
    /* storage unavailable: ask again next time */
  }
}

/** Engine picker: checkbox list of the registry (browser builds + server engines). */
function EnginePicker() {
  const enabledEngines = useAnalysisStore((s) => s.enabledEngines);
  const probe = useAnalysisStore((s) => s.serverProbe);
  const env = useAnalysisStore((s) => s.env);
  const hint = useAnalysisStore((s) => s.engineHint);
  const setEngineEnabled = useAnalysisStore((s) => s.setEngineEnabled);
  const probeServer = useAnalysisStore((s) => s.probeServer);
  const clearEngineHint = useAnalysisStore((s) => s.clearEngineHint);
  const [open, setOpen] = useState(false);
  /** Engine waiting for the download confirmation (full build, first time only). */
  const [confirm, setConfirm] = useState<EngineDescriptor | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const engines = useMemo(
    () => listEngines(probe, enabledEngines, env),
    [probe, enabledEngines, env],
  );
  const toggle = (d: EngineDescriptor, on: boolean) => {
    if (on && d.downloadBytes !== undefined && !downloadConfirmed()) {
      setConfirm(d);
      return;
    }
    setConfirm(null);
    setEngineEnabled(d.key, on);
  };

  // Server engines are discovered when the picker opens (cached by the store).
  useEffect(() => {
    if (open) void probeServer();
  }, [open, probeServer]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target))
        setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const n = enabledEngines.length;
  return (
    <div className={styles.pickerWrap} ref={ref}>
      <button
        type="button"
        className={styles.pickerButton}
        aria-expanded={open}
        aria-controls={`${id}-picker`}
        onClick={() => {
          clearEngineHint();
          setOpen((o) => !o);
        }}
      >
        {n > 1 ? `Engines (${n})` : 'Engines'}
        <span aria-hidden="true"> ▾</span>
      </button>
      {open && (
        <div
          id={`${id}-picker`}
          className={styles.picker}
          role="group"
          aria-label="Engines"
          data-testid="engine-picker"
        >
          {engines.map((d) => {
            const checked = enabledEngines.includes(d.key);
            const disabled = !checked && !d.available;
            const inputId = `${id}-${d.key}`;
            return (
              <div
                key={d.key}
                className={disabled ? `${styles.option} ${styles.optionOff}` : styles.option}
              >
                <input
                  id={inputId}
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  aria-describedby={d.reason ? `${inputId}-reason` : undefined}
                  onChange={(e) => toggle(d, e.currentTarget.checked)}
                />
                <label htmlFor={inputId} className={styles.optionName}>
                  {d.name}
                </label>
                {d.reason && !d.available && (
                  <span id={`${inputId}-reason`} className={styles.optionReason}>
                    {d.reason}
                  </span>
                )}
              </div>
            );
          })}
          {confirm && (
            <div className={styles.confirm} role="alertdialog" aria-labelledby={`${id}-confirm`}>
              <p id={`${id}-confirm`}>
                {confirm.name.replace(/\s*\(.*$/, '')} at maximum strength downloads{' '}
                {formatDownload(confirm.downloadBytes ?? 0)} once (cached afterwards) and uses more
                memory. Load it?
              </p>
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => {
                    rememberDownloadConfirmed();
                    setConfirm(null);
                    setEngineEnabled(confirm.key, true);
                  }}
                >
                  Download and enable
                </button>
                <button
                  type="button"
                  className={styles.linkButton}
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          {probe.status === 'error' && isAuthError(probe.error) && (
            <p className={styles.hint} data-testid="auth-hint">
              {authMessage()} <OpenSettingsButton className={styles.linkButton} />
            </p>
          )}
          {probe.status === 'error' && probe.error !== undefined && isDeniedText(probe.error) && (
            <p className={styles.hint} data-testid="denied-hint">
              {probe.error}{' '}
              {isTokenFixText(probe.error) && <OpenSettingsButton className={styles.linkButton} />}
            </p>
          )}
          {probe.status === 'ok' && probe.node && (
            <p className={styles.hint} data-testid="node-hint">
              Server engines run {nodeParts(probe.node).join(' · ')}
            </p>
          )}
          {probe.status === 'error' && (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => void probeServer({ force: true })}
            >
              Check the server again
            </button>
          )}
          {hint && (
            <p className={styles.hint} role="status" data-testid="engine-hint">
              {hint}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface CompareChipProps {
  descriptor: EngineDescriptor;
  instance: EngineInstanceState;
  fen: string;
  active: boolean;
  onSelect(): void;
}

/** One engine in the compare strip: name, top eval, depth and first move. */
function CompareChip({ descriptor, instance, fen, active, onSelect }: CompareChipProps) {
  const top = instance.lines[0];
  const first = useMemo(
    () => (top ? convertPv(fen, top.pv.slice(0, 1)).san[0] : undefined),
    [fen, top],
  );
  const dot = instanceDot(instance);
  return (
    <button
      type="button"
      className={active ? `${styles.compareChip} ${styles.compareActive}` : styles.compareChip}
      data-testid="compare-chip"
      data-engine={descriptor.key}
      aria-pressed={active}
      title={descriptor.name}
      onClick={onSelect}
    >
      <span className={styles.compareName}>
        <span className={styles.dot} data-status={dot} aria-hidden="true" />
        {shortLabel(descriptor, instance)}{' '}
        <span className={styles.compareBadge}>{descriptor.badge}</span>
      </span>
      {top ? (
        <>
          <span
            className={`${styles.chip} ${styles[scoreTone(top.score)]}`}
            data-testid="compare-eval"
          >
            {formatScore(top.score)}
          </span>
          <span className={styles.depth}>d{top.depth}</span>
          <span className={styles.compareMove}>{first ?? ''}</span>
        </>
      ) : (
        <span className={styles.compareWait}>
          {dot === 'error' ? (instance.backendError ?? 'error') : '…'}
        </span>
      )}
    </button>
  );
}

/**
 * Live engine panel: header, engine picker, settings, MultiPV lines in SAN. With two or more
 * engines enabled, a compare strip (top eval of each engine) and one tab per engine are shown.
 * Rendered only while analysis is enabled.
 */
export function AnalysisPanel() {
  const enabled = useAnalysisStore((s) => s.enabled);
  const enabledEngines = useAnalysisStore((s) => s.enabledEngines);
  const instances = useAnalysisStore((s) => s.instances);
  const probe = useAnalysisStore((s) => s.serverProbe);
  const defaults = useAnalysisStore((s) => s.settings);
  const engineSettings = useAnalysisStore((s) => s.engineSettings);
  const env = useAnalysisStore((s) => s.env);
  const fen = useAnalysisStore((s) => s.fen);
  const terminal = useAnalysisStore((s) => s.terminal);
  const setSettings = useAnalysisStore((s) => s.setSettings);
  const setEngineSettings = useAnalysisStore((s) => s.setEngineSettings);
  const applySettingsToAll = useAnalysisStore((s) => s.applySettingsToAll);
  const wasmNotice = useAnalysisStore((s) => s.wasmNotice);
  const dismissWasmNotice = useAnalysisStore((s) => s.dismissWasmNotice);
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const tabsId = useId();

  const activeKey =
    selected !== null && enabledEngines.includes(selected) ? selected : (enabledEngines[0] ?? '');
  const inst = instances[activeKey] ?? newInstance(activeKey);
  const lines = useDeferredValue(inst.lines);
  const multi = enabledEngines.length > 1;
  const descriptors = useMemo(
    () => enabledEngines.map((k) => describeEngine(k, probe, env)),
    [enabledEngines, probe, env],
  );

  // Leaving the panel (engine off) must not leave arrows or a preview behind.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      usePreviewStore.getState().setHover(null);
      usePreviewStore.getState().clear();
    };
  }, [enabled]);

  if (!enabled) return null;

  const remote = isRemoteKey(activeKey);
  const caps = inst.capabilities;
  const limits = inst.remoteLimits;
  // Settings of the selected engine: the defaults merged with its override (ADR-010).
  const override: EngineSettingsOverride | undefined = engineSettings[activeKey];
  const settings = override ? { ...defaults, ...override } : defaults;
  const activeDescriptor = descriptors.find((d) => d.key === activeKey);
  const maxThreads =
    remote && limits ? limits.maxThreads : maxWasmThreads(env);
  const maxLines = remote && limits ? Math.min(MAX_MULTIPV, limits.maxMultipv) : MAX_MULTIPV;
  const maxDepth = remote && limits ? limits.maxDepth : Infinity;
  // The server clamps to its limits; show what will actually run.
  const threads = Math.min(settings.threads ?? caps?.threadCount ?? 1, maxThreads);
  const multipv = Math.min(settings.multipv, maxLines);
  // The server clamps the depth to its limit; a persisted non-preset depth (e.g. 16) stays listed.
  const shownDepth = settings.depth > maxDepth ? maxDepth : settings.depth;
  const depthOptions = withCurrent(
    DEPTH_OPTIONS.filter((d) => d === 0 || d <= maxDepth),
    shownDepth,
  );
  const threadsOk = caps?.threads ?? false;
  const engineName = inst.engineName;
  const name = engineName ? (/^Stockfish \S+/.exec(engineName)?.[0] ?? engineName) : 'Engine';
  const n = caps?.threadCount;
  const nps = formatNps(lines[0]?.nps);
  const depth = lines[0]?.depth;

  /**
   * With several engines the selects edit the selected engine only; with one engine they edit
   * the defaults (and drop that engine's override of the field, so what is shown is what runs).
   */
  const change = (patch: Partial<Record<'depth' | 'multipv' | 'threads', number>>) => {
    if (multi) {
      setEngineSettings(activeKey, patch);
      return;
    }
    setSettings(patch);
    const clear: EngineSettingsPatch = {};
    for (const f of ENGINE_SETTING_FIELDS)
      if (f in patch && override?.[f] !== undefined) clear[f] = null;
    if (Object.keys(clear).length > 0) setEngineSettings(activeKey, clear);
  };

  const onTabKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = enabledEngines.indexOf(activeKey);
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0 || i < 0) return;
    e.preventDefault();
    const next = enabledEngines[(i + step + enabledEngines.length) % enabledEngines.length];
    if (next === undefined) return;
    setSelected(next);
    document.getElementById(`${tabsId}-tab-${next}`)?.focus();
  };

  const body = terminal ? (
    <p className={styles.empty}>
      {terminal === 'checkmate' ? 'Checkmate' : 'Stalemate'}: nothing to analyse.
    </p>
  ) : lines.length === 0 ? (
    <>
      <p className={styles.empty}>
        {inst.status === 'error'
          ? displayError(inst.backendError ?? inst.error ?? 'Engine unavailable.')
          : 'Thinking…'}
      </p>
      {inst.status === 'error' &&
        (isAuthError(inst.backendError ?? inst.error) ||
          isTokenFixText(inst.backendError ?? inst.error ?? '')) && (
        <p className={styles.authHint} data-testid="auth-hint">
          <OpenSettingsButton className={styles.linkButton} />
        </p>
      )}
    </>
  ) : (
    <ol className={styles.lines} data-testid="analysis-lines">
      {lines.map((l) => (
        <LineRow key={l.multipv} line={l} fen={fen} />
      ))}
    </ol>
  );

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
        <span className={styles.meta} data-testid="analysis-meta">
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
      {multi && (
        <div className={styles.compare} data-testid="compare-strip" aria-label="Engine comparison">
          {descriptors.map((d) => (
            <CompareChip
              key={d.key}
              descriptor={d}
              instance={instances[d.key] ?? newInstance(d.key)}
              fen={fen}
              active={d.key === activeKey}
              onSelect={() => setSelected(d.key)}
            />
          ))}
        </div>
      )}
      {wasmNotice && (
        <p className={styles.notice} role="status" data-testid="wasm-notice">
          {wasmNotice}{' '}
          <button type="button" className={styles.linkButton} onClick={dismissWasmNotice}>
            Dismiss
          </button>
        </p>
      )}
      {open && (
        <>
          <div className={styles.settings}>
            <EnginePicker />
            {multi && activeDescriptor && (
              <span className={styles.settingsFor} data-testid="settings-engine">
                Settings for{' '}
                <span className={styles.settingsForName} title={activeDescriptor.name}>
                  {shortLabel(activeDescriptor, inst)} {activeDescriptor.badge}
                </span>
              </span>
            )}
            <label className={styles.setting}>
              Depth
              <select
                value={shownDepth}
                onChange={(e) => change({ depth: Number(e.currentTarget.value) })}
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
                onChange={(e) => change({ multipv: Number(e.currentTarget.value) })}
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
                onChange={(e) => change({ threads: Number(e.currentTarget.value) })}
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
            {multi && (
              <button
                type="button"
                className={`${styles.linkButton} ${styles.applyAll}`}
                title="Use these settings for every engine"
                onClick={() => applySettingsToAll(activeKey)}
              >
                Apply to all
              </button>
            )}
          </div>
          {multi ? (
            <>
              <div className={styles.engineTabs} role="tablist" aria-label="Engine results">
                {descriptors.map((d) => {
                  const i = instances[d.key] ?? newInstance(d.key);
                  const on = d.key === activeKey;
                  return (
                    <button
                      key={d.key}
                      id={`${tabsId}-tab-${d.key}`}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      aria-controls={`${tabsId}-panel`}
                      tabIndex={on ? 0 : -1}
                      className={
                        on ? `${styles.engineTab} ${styles.engineTabOn}` : styles.engineTab
                      }
                      data-testid="engine-tab"
                      data-engine={d.key}
                      title={d.name}
                      onClick={() => setSelected(d.key)}
                      onKeyDown={onTabKey}
                    >
                      <span
                        className={styles.dot}
                        data-status={instanceDot(i)}
                        aria-hidden="true"
                      />
                      {shortLabel(d, i)}
                      <span className={styles.tabBadge}>{d.badge}</span>
                    </button>
                  );
                })}
              </div>
              <div
                id={`${tabsId}-panel`}
                role="tabpanel"
                aria-labelledby={`${tabsId}-tab-${activeKey}`}
                data-testid="engine-tabpanel"
                data-engine={activeKey}
              >
                {body}
              </div>
            </>
          ) : (
            body
          )}
        </>
      )}
    </section>
  );
}
