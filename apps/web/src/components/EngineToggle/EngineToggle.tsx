import { useAnalysisStore, type AnalysisState } from '../../store/analysisStore';
import styles from './EngineToggle.module.css';

export function engineStatusText(
  s: Pick<
    AnalysisState,
    'enabled' | 'status' | 'error' | 'engineName' | 'capabilities' | 'lines' | 'terminal'
  > &
    Partial<Pick<AnalysisState, 'settings' | 'backendStatus' | 'backendError'>>,
): string {
  const remote = s.settings?.backend === 'remote';
  if (s.status === 'error') {
    if (remote) return s.backendError ?? s.error ?? 'Server error';
    return `Error: ${s.error ?? 'engine failed'}`;
  }
  if (!s.enabled) return 'Off';
  if (remote && s.backendStatus === 'closed') return 'Connection lost';
  if (s.status === 'loading' || s.status === 'idle') {
    return remote ? 'Connecting to server…' : 'Loading engine…';
  }
  // UCI names can be long ("Stockfish 19 Lite WASM Multithreaded …"); keep name + version.
  const full = s.engineName ?? 'Stockfish';
  const name = /^Stockfish \S+/.exec(full)?.[0] ?? full;
  const n = s.capabilities?.threadCount;
  const parts = [name];
  if (remote) parts.push('server');
  if (n !== undefined) parts.push(`${n} thread${n === 1 ? '' : 's'}`);
  const depth = s.lines[0]?.depth;
  if (s.terminal) parts.push('game over');
  else if (depth !== undefined) parts.push(`depth ${depth}`);
  return parts.join(' · ');
}

/** Engine on/off switch with load/error status (browser engine). */
export function EngineToggle() {
  const s = useAnalysisStore();
  const text = engineStatusText(s);
  return (
    <div className={styles.engine}>
      <label className={styles.switch}>
        <input
          type="checkbox"
          role="switch"
          checked={s.enabled}
          onChange={(e) => s.setEnabled(e.currentTarget.checked)}
          aria-describedby="engine-status"
        />
        <span className={styles.track} aria-hidden="true" />
        <span className={styles.name}>Engine</span>
      </label>
      <span
        id="engine-status"
        className={s.status === 'error' ? `${styles.status} ${styles.error}` : styles.status}
        data-testid="engine-status"
        title={s.engineName ? `${s.engineName} (${s.capabilities?.build ?? 'browser'})` : text}
        aria-live="polite"
      >
        {text}
      </span>
      {s.status === 'error' && s.enabled && (
        <button type="button" className={styles.retry} onClick={s.retry}>
          Retry
        </button>
      )}
      {s.status === 'error' && s.enabled && s.settings.backend === 'remote' && (
        <button
          type="button"
          className={styles.retry}
          onClick={() => s.setSettings({ backend: 'wasm' })}
        >
          Use browser engine
        </button>
      )}
    </div>
  );
}
