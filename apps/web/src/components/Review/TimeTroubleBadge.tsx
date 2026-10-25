import styles from './ReviewPanel.module.css';

/** "time trouble" badge of a mistake/blunder made with little time left (M22-1). */
export function TimeTroubleBadge() {
  return (
    <span className={styles.timeBadge} data-testid="time-trouble-badge" title="Made with little time left">
      time trouble
    </span>
  );
}
