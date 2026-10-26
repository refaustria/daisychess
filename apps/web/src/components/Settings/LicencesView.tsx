import gplText from '../../../../../LICENSE?raw';
import noticesText from '../../../../../THIRD_PARTY_NOTICES.md?raw';
import styles from './SettingsPanel.module.css';

/**
 * Full GPL-3.0 text and THIRD_PARTY_NOTICES.md, bundled so they work offline (ADR-022 §3).
 * Loaded lazily from AboutField (own chunk, not in the main entry).
 */
export function LicencesView() {
  return (
    <div className={styles.licences}>
      <section aria-label="Attributions">
        <h4>Attributions</h4>
        <ul className={styles.help}>
          <li>
            Stockfish (GPL-3.0): the Stockfish developers, derived from Glaurung by Tord Romstad.
          </li>
          <li>
            Leela Chess Zero (Lc0, GPL-3.0-or-later): the LCZero authors; used on engine servers.
          </li>
          <li>
            Maia networks (GPL-3.0): CSSLab, University of Toronto; McIlroy-Young et al., KDD 2020;
            used on engine servers.
          </li>
          <li>chessground (GPL-3.0-or-later): lichess.org, including the Cburnett piece set.</li>
        </ul>
      </section>
      <section aria-label="Third-party notices">
        <h4>Third-party notices</h4>
        <pre className={styles.licenceText}>{noticesText}</pre>
      </section>
      <section aria-label="GNU General Public License">
        <h4>GNU General Public License, version 3</h4>
        <pre className={styles.licenceText}>{gplText}</pre>
      </section>
    </div>
  );
}
