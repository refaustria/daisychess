import { useId, useState, type FormEvent } from 'react';
import { refreshUserSides } from '../../puzzles/gameLedger';
import { knownNames, parseNames, readMyNames, writeMyNames } from '../../puzzles/userSide';
import styles from './SettingsPanel.module.css';

/**
 * Settings → Puzzles, "My names" (ADR-023 §9): the user's player names in PGN files and on other
 * sites, used to tell which side the user played in reviewed games ("Your mistakes"). Stored in
 * localStorage `daisychess.puzzles.names`; saving re-matches the ledger games whose side is
 * still unknown.
 */
export function PuzzleNamesField() {
  const [stored, setStored] = useState(() => readMyNames().join(', '));
  const [draft, setDraft] = useState(stored);
  const [status, setStatus] = useState('');
  const id = useId();
  const dirty = parseNames(draft).join(', ') !== stored;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const saved = writeMyNames(parseNames(draft)).join(', ');
    setStored(saved);
    setDraft(saved);
    setStatus(saved ? 'Saved.' : 'Names removed.');
    void refreshUserSides(knownNames()).then((n) => {
      if (n > 0) setStatus(`Saved. Your side is now known in ${n} more game${n === 1 ? '' : 's'}.`);
    });
  };

  return (
    <form className={styles.group} onSubmit={onSubmit} aria-labelledby={`${id}-legend`}>
      <span id={`${id}-legend`} className={styles.legend}>
        Puzzles
      </span>
      <label className={styles.field} htmlFor={`${id}-names`}>
        My names
      </label>
      <div className={styles.tokenRow}>
        <input
          id={`${id}-names`}
          className={styles.tokenInput}
          type="text"
          value={draft}
          maxLength={1000}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. MyLichessName, my_chesscom_name"
          aria-describedby={`${id}-help`}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setStatus('');
          }}
        />
        <button type="submit" className={styles.reset} disabled={!dirty}>
          Save names
        </button>
      </div>
      <p id={`${id}-help`} className={styles.help} role="status">
        {status ||
          'Your player names in PGN files and on other sites, separated by commas. They tell which side you played in reviewed games, so puzzles can be made from your own mistakes. Stored in this browser only.'}
      </p>
    </form>
  );
}
