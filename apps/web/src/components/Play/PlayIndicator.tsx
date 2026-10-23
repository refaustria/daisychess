import { usePlayStore } from '../../play/playStore';
import styles from './PlayIndicator.module.css';

/** Subtle on-board hint while the engine is thinking (the Play panel announces it to AT). */
export function PlayIndicator() {
  const show = usePlayStore((s) => s.mode === 'playing' && s.thinking);
  if (!show) return null;
  return (
    <div className={styles.indicator} data-testid="engine-thinking" aria-hidden="true">
      <span className={styles.dot} />
      Engine is thinking…
    </div>
  );
}
