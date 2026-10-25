import { lockText, useHumanGameLockReason } from '../../live/lock';
import { authMessage, isAuthError } from '../../server/tokenMessages';
import {
  isRemoteKey,
  useAnalysisStore,
  usePrimaryAnalysis,
  type AnalysisState,
  type EngineInstanceState,
} from '../../store/analysisStore';
import { OpenSettingsButton } from '../Settings/OpenSettingsButton';
import styles from './EngineToggle.module.css';

/** Status line of the (primary) engine; `remote` marks a server engine. */
export function engineStatusText(
  s: Pick<AnalysisState, 'enabled' | 'terminal'> &
    Pick<EngineInstanceState, 'status' | 'lines'> &
    Partial<
      Pick<
        EngineInstanceState,
        'error' | 'engineName' | 'capabilities' | 'backendStatus' | 'backendError'
      >
    > & { remote?: boolean },
): string {
  const remote = s.remote === true;
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

/** Engine on/off switch (all enabled engines) with the primary engine's load/error status. */
export function EngineToggle() {
  const enabled = useAnalysisStore((a) => a.enabled);
  const terminal = useAnalysisStore((a) => a.terminal);
  const remote = useAnalysisStore((a) => isRemoteKey(a.enabledEngines[0]));
  const setEnabled = useAnalysisStore((a) => a.setEnabled);
  const retry = useAnalysisStore((a) => a.retry);
  const fallBackToBrowser = useAnalysisStore((a) => a.fallBackToBrowser);
  const lock = useHumanGameLockReason();
  const locked = lock !== null;
  const primary = usePrimaryAnalysis();
  const s = { ...primary, enabled, terminal, remote };
  const rawText = engineStatusText(s);
  const auth = s.status === 'error' && remote && isAuthError(rawText);
  const text = auth ? authMessage() : rawText;
  return (
    <div className={styles.engine}>
      <label
        className={styles.switch}
        title={lockText(lock)}
      >
        <input
          type="checkbox"
          role="switch"
          checked={enabled && !locked}
          disabled={locked}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
          aria-describedby="engine-status"
        />
        <span className={styles.track} aria-hidden="true" />
        <span className={styles.name}>Engine</span>
      </label>
      <span
        id="engine-status"
        className={s.status === 'error' ? `${styles.status} ${styles.error}` : styles.status}
        data-testid="engine-status"
        title={
          auth
            ? text
            : s.engineName
              ? `${s.engineName} (${s.capabilities?.build ?? 'browser'})`
              : text
        }
        aria-live="polite"
      >
        {text}
      </span>
      {auth && <OpenSettingsButton className={styles.retry} />}
      {s.status === 'error' && enabled && (
        <button type="button" className={styles.retry} onClick={() => retry(primary.key)}>
          Retry
        </button>
      )}
      {s.status === 'error' && enabled && remote && (
        <button type="button" className={styles.retry} onClick={fallBackToBrowser}>
          Use browser engine
        </button>
      )}
    </div>
  );
}
