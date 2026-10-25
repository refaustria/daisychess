import { LICENSE_NAME, LICENSE_URL, NOTICES_URL, SOURCE_REPO_URL } from '../../appInfo';
import styles from './SettingsPanel.module.css';

/** "About" block: source-code link and licence line (GPL source offer). */
export function AboutField() {
  return (
    <section className={styles.group} aria-label="About">
      <p className={styles.help}>
        DaisyChess is free software, licensed under{' '}
        <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
          {LICENSE_NAME}
        </a>
        . It includes Stockfish and chessground (GPL).{' '}
        <a href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer">
          Source code
        </a>
        {' · '}
        <a href={NOTICES_URL} target="_blank" rel="noopener noreferrer">
          Third-party notices
        </a>
      </p>
    </section>
  );
}
