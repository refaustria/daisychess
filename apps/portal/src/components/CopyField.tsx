import { useState } from 'react';
import ui from '../ui.module.css';

/** Read-only monospace value with a Copy button (clipboard failures just say so). */
export function CopyField({ label, value, multiline }: { label: string; value: string; multiline?: boolean }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <div className={ui.copyField}>
      <div className={ui.copyHead}>
        <span className={ui.label}>{label}</span>
        <button type="button" onClick={() => void copy()} aria-label={`Copy ${label}`}>
          {state === 'copied' ? 'Copied' : 'Copy'}
        </button>
        <span role="status" className={ui.muted}>
          {state === 'failed' ? 'Copy failed: select the text and copy it by hand.' : ''}
        </span>
      </div>
      {multiline ? (
        <pre className={ui.code} tabIndex={0} aria-label={label}>
          {value}
        </pre>
      ) : (
        <code className={ui.codeLine} tabIndex={0} aria-label={label}>
          {value}
        </code>
      )}
    </div>
  );
}
