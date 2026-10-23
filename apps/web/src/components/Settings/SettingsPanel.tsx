import { boardThemes, findBoardTheme } from '@chesslab/ui-theme/boardThemes';
import { pieceSets } from '@chesslab/ui-theme/pieceSets';
import { HIGHLIGHT_STYLES, useSettingsStore, type HighlightStyle } from '../../store/settingsStore';
import styles from './SettingsPanel.module.css';

const HIGHLIGHT_LABEL: Record<HighlightStyle, string> = {
  classic: 'Classic',
  subtle: 'Subtle',
  none: 'None',
};

export function SettingsPanel() {
  const s = useSettingsStore();
  const preset = findBoardTheme(s.boardTheme);
  const custom = s.customBoard ?? {
    light: preset?.light ?? boardThemes[0]!.light,
    dark: preset?.dark ?? boardThemes[0]!.dark,
  };
  return (
    <div className={styles.panel} data-testid="settings-panel">
      <fieldset className={styles.group}>
        <legend>Board colours</legend>
        <div className={styles.swatches} role="radiogroup" aria-label="Board theme">
          {boardThemes.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={s.boardTheme === t.id}
              aria-label={t.name}
              title={t.name}
              data-testid={`board-theme-${t.id}`}
              className={
                s.boardTheme === t.id ? `${styles.swatch} ${styles.swatchOn}` : styles.swatch
              }
              style={{ background: `linear-gradient(135deg, ${t.light} 50%, ${t.dark} 50%)` }}
              onClick={() => s.set({ boardTheme: t.id })}
            />
          ))}
        </div>
        <div className={styles.row}>
          <label className={styles.inline}>
            Custom light
            <input
              type="color"
              aria-label="Custom light square"
              value={custom.light}
              onChange={(e) => s.setCustomBoard({ ...custom, light: e.target.value })}
            />
          </label>
          <label className={styles.inline}>
            Custom dark
            <input
              type="color"
              aria-label="Custom dark square"
              value={custom.dark}
              onChange={(e) => s.setCustomBoard({ ...custom, dark: e.target.value })}
            />
          </label>
        </div>
      </fieldset>

      <label className={styles.field}>
        Piece set
        <select value={s.pieceSet} onChange={(e) => s.set({ pieceSet: e.target.value })}>
          {pieceSets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        Highlight style
        <select
          value={s.highlightStyle}
          onChange={(e) => s.set({ highlightStyle: e.target.value as HighlightStyle })}
        >
          {HIGHLIGHT_STYLES.map((h) => (
            <option key={h} value={h}>
              {HIGHLIGHT_LABEL[h]}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={s.coordinates}
          onChange={(e) => s.set({ coordinates: e.target.checked })}
        />
        Show coordinates
      </label>

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={s.sound}
          onChange={(e) => s.set({ sound: e.target.checked })}
        />
        Sound
      </label>

      <button type="button" className={styles.reset} onClick={() => s.reset()}>
        Reset to defaults
      </button>
    </div>
  );
}
