import { lazy, Suspense, useState } from 'react';
import {
  APP_BUILD,
  APP_COMMIT,
  APP_VERSION,
  LICENSE_NAME,
  LICENSE_URL,
  NOTICES_URL,
  SOURCE_REPO_URL,
  sourceLinkFor,
} from '../../appInfo';
import styles from './SettingsPanel.module.css';

// Own chunk: the GPL text and the notices are ~100 kB and only needed on demand (works offline
// in the app because the chunk is part of the bundled assets).
const LicencesView = lazy(() =>
  import('./LicencesView').then((m) => ({ default: m.LicencesView })),
);

/** "About" block: version, source link for this build, licences (GPL source offer). */
export function AboutField() {
  const [showLicences, setShowLicences] = useState(false);
  const commit = APP_COMMIT ? APP_COMMIT.slice(0, 7) : 'unknown';
  return (
    <section className={styles.group} aria-label="About">
      <p className={styles.help} data-testid="about-version">
        DaisyChess {APP_VERSION}
        {APP_BUILD ? ` (build ${APP_BUILD})` : ''} · commit {commit}
      </p>
      <p className={styles.help}>
        DaisyChess is free software, licensed under{' '}
        <a href={LICENSE_URL} target="_blank" rel="noopener noreferrer">
          {LICENSE_NAME}
        </a>
        . It includes Stockfish and chessground (GPL).{' '}
        <a href={sourceLinkFor()} target="_blank" rel="noopener noreferrer">
          Source code
        </a>
        {' · '}
        <a href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer">
          Repository
        </a>
        {' · '}
        <a href={NOTICES_URL} target="_blank" rel="noopener noreferrer">
          Third-party notices
        </a>
      </p>
      <button
        type="button"
        className={styles.reset}
        aria-expanded={showLicences}
        onClick={() => setShowLicences((v) => !v)}
      >
        {showLicences ? 'Hide licences' : 'Licences'}
      </button>
      {showLicences && (
        <Suspense fallback={<p className={styles.help}>Loading licences…</p>}>
          <LicencesView />
        </Suspense>
      )}
    </section>
  );
}
