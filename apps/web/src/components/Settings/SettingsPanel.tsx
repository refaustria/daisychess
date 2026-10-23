import { boardThemes, findBoardTheme } from '@chesslab/ui-theme/boardThemes';
import { pieceSets } from '@chesslab/ui-theme/pieceSets';
import { useId, useState, type FormEvent } from 'react';
import {
  HIGHLIGHT_STYLES,
  MAX_SERVER_TOKEN_LENGTH,
  normalizeToken,
  useSettingsStore,
  type HighlightStyle,
} from '../../store/settingsStore';
import { LichessAccountSection } from '../LichessAccount/LichessAccountSection';
import styles from './SettingsPanel.module.css';

const HIGHLIGHT_LABEL: Record<HighlightStyle, string> = {
  classic: 'Classic',
  subtle: 'Subtle',
  none: 'None',
};

/**
 * Access token for an engine server started with `ACCESS_TOKEN` (ADR-010). Saved explicitly
 * (button or Enter), because every change reconnects the server engines.
 */
function ServerTokenField() {
  const token = useSettingsStore((s) => s.serverToken);
  const setServerToken = useSettingsStore((s) => s.setServerToken);
  const [draft, setDraft] = useState(token);
  const [shown, setShown] = useState(false);
  const [saved, setSaved] = useState(false);
  const id = useId();
  const dirty = normalizeToken(draft) !== token;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setServerToken(draft);
    setDraft(normalizeToken(draft));
    setSaved(true);
  };
  return (
    <form className={styles.group} onSubmit={onSubmit} aria-labelledby={`${id}-legend`}>
      <span id={`${id}-legend`} className={styles.legend}>
        Engine server
      </span>
      <label className={styles.field} htmlFor={`${id}-token`}>
        Server access token
      </label>
      <div className={styles.tokenRow}>
        <input
          id={`${id}-token`}
          className={styles.tokenInput}
          type={shown ? 'text' : 'password'}
          value={draft}
          maxLength={MAX_SERVER_TOKEN_LENGTH}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-help`}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
            setSaved(false);
          }}
        />
        <button
          type="button"
          className={styles.reset}
          aria-pressed={shown}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
        <button type="submit" className={styles.reset} disabled={!dirty}>
          Save token
        </button>
      </div>
      <p id={`${id}-help`} className={styles.help} role="status">
        {saved && !dirty
          ? token
            ? 'Saved. Server engines reconnect with the new token.'
            : 'Token removed.'
          : 'Only needed when the engine server requires one. Stored in this browser.'}
      </p>
    </form>
  );
}

export function SettingsPanel() {
  const s = useSettingsStore();
  const preset = findBoardTheme(s.boardTheme);
  const custom = s.customBoard ?? {
    light: preset?.light ?? boardThemes[0]!.light,
    dark: preset?.dark ?? boardThemes[0]!.dark,
  };
  return (
    <div className={styles.panel} data-testid="settings-panel">
      <LichessAccountSection />

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

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={s.autoReview}
          onChange={(e) => s.set({ autoReview: e.target.checked })}
        />
        Analyse games automatically after loading
      </label>

      <button type="button" className={styles.reset} onClick={() => s.reset()}>
        Reset to defaults
      </button>

      <ServerTokenField />
    </div>
  );
}
