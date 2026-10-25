import { useId } from 'react';
import { MAIA_RATINGS, useSettingsStore } from '../../store/settingsStore';
import styles from './SettingsPanel.module.css';

/**
 * Human-like review hints (M23-3): on/off and the Maia level used for a side whose PGN has no
 * rating (also for games played here).
 */
export function MaiaHintsField() {
  const enabled = useSettingsStore((s) => s.maiaHints);
  const rating = useSettingsStore((s) => s.maiaRating);
  const set = useSettingsStore((s) => s.set);
  const id = useId();
  return (
    <div className={styles.group}>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={enabled}
          data-testid="maia-hints-toggle"
          onChange={(e) => set({ maiaHints: e.currentTarget.checked })}
        />
        Human-like hints in the review (Maia)
      </label>
      <label className={styles.field}>
        Your level for human-like hints
        <select
          value={rating}
          disabled={!enabled}
          aria-describedby={`${id}-help`}
          data-testid="maia-rating-select"
          onChange={(e) => set({ maiaRating: Number(e.currentTarget.value) })}
        >
          {MAIA_RATINGS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <p id={`${id}-help`} className={styles.help}>
        For each mistake the review shows what players of that rating typically play (needs the
        engine server and its access token). The players’ ratings from the PGN are used when
        present; this level otherwise.
      </p>
    </div>
  );
}
