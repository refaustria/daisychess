import { boardThemes, findBoardTheme } from '@daisychess/ui-theme/boardThemes';
import { pieceSets } from '@daisychess/ui-theme/pieceSets';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { SERVER_TOKEN_INPUT_ID } from '../../server/tokenMessages';
import { SETUP_LINK_WARNING, setupLink } from '../../setup/setupLink';
import { useUiStore } from '../../store/uiStore';
import {
  HIGHLIGHT_STYLES,
  MAX_SERVER_TOKEN_LENGTH,
  normalizeToken,
  PREMOVE_MODES,
  REVIEW_ENGINE_PREFERENCES,
  useSettingsStore,
  type HighlightStyle,
  type PremoveMode,
  type ReviewEnginePreference,
} from '../../store/settingsStore';
import { isNativeApp } from '../../platform';
import { LichessAccountSection } from '../LichessAccount/LichessAccountSection';
import { MaiaHintsField } from './MaiaHintsField';
import { AboutField } from './AboutField';
import { ReviewCacheField } from './ReviewCacheField';
import styles from './SettingsPanel.module.css';

const HIGHLIGHT_LABEL: Record<HighlightStyle, string> = {
  classic: 'Classic',
  subtle: 'Subtle',
  none: 'None',
};

const PREMOVE_LABEL: Record<PremoveMode, string> = {
  none: 'Off',
  single: 'One premove',
  queue: 'Queue (several)',
};

const REVIEW_ENGINE_LABEL: Record<ReviewEnginePreference, string> = {
  auto: 'Auto (server when available)',
  browser: 'Browser',
  server: 'Server',
};

/** Where the game review runs (ADR-014); next to the engine server settings. */
function ReviewEngineField() {
  const value = useSettingsStore((s) => s.reviewEngine);
  const set = useSettingsStore((s) => s.set);
  const id = useId();
  return (
    <div className={styles.group}>
      <label className={styles.field}>
        Review engine
        <select
          value={value}
          aria-describedby={`${id}-help`}
          data-testid="review-engine-select"
          onChange={(e) => set({ reviewEngine: e.currentTarget.value as ReviewEnginePreference })}
        >
          {REVIEW_ENGINE_PREFERENCES.map((p) => (
            <option key={p} value={p}>
              {REVIEW_ENGINE_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      <p id={`${id}-help`} className={styles.help}>
        Game review on the engine server is much faster than in the browser (needs the access
        token). If the server is unavailable the review runs in the browser.
      </p>
    </div>
  );
}

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
  const [linkCopied, setLinkCopied] = useState<'copied' | 'failed' | null>(null);
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const focusRequested = useUiStore((s) => s.focusServerToken);
  const clearFocus = useUiStore((s) => s.clearFocusServerToken);
  useEffect(() => {
    if (!focusRequested) return;
    inputRef.current?.focus();
    clearFocus();
  }, [focusRequested, clearFocus]);
  const dirty = normalizeToken(draft) !== token;
  const copyLink = () => {
    const link = setupLink(token);
    const write = navigator.clipboard?.writeText(link) ?? Promise.reject(new Error('no clipboard'));
    write.then(
      () => setLinkCopied('copied'),
      () => setLinkCopied('failed'),
    );
  };
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
      <label className={styles.field} htmlFor={SERVER_TOKEN_INPUT_ID}>
        Server access token
      </label>
      <div className={styles.tokenRow}>
        <input
          id={SERVER_TOKEN_INPUT_ID}
          ref={inputRef}
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
      <div className={styles.tokenRow}>
        <button
          type="button"
          className={styles.reset}
          disabled={token === ''}
          onClick={copyLink}
        >
          Copy link for another device
        </button>
      </div>
      {linkCopied !== null && (
        <p className={styles.help} role="status" data-testid="setup-link-warning">
          {linkCopied === 'copied' ? 'Link copied. ' : 'Could not copy the link. '}
          {SETUP_LINK_WARNING}
        </p>
      )}
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

      {isNativeApp() && (
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={s.haptics}
            onChange={(e) => s.set({ haptics: e.target.checked })}
          />
          Haptic feedback
        </label>
      )}

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={s.autoReview}
          onChange={(e) => s.set({ autoReview: e.target.checked })}
        />
        Analyse games automatically after loading
      </label>

      <label className={styles.check}>
        <input
          type="checkbox"
          checked={s.reviewTour}
          onChange={(e) => s.set({ reviewTour: e.target.checked })}
        />
        Guided tour after a review
      </label>

      <label className={styles.field}>
        Premoves
        <select
          value={s.premoves}
          onChange={(e) => s.set({ premoves: e.target.value as PremoveMode })}
          aria-describedby="premoves-note"
        >
          {PREMOVE_MODES.map((m) => (
            <option key={m} value={m}>
              {PREMOVE_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      <p id="premoves-note" className={styles.help}>
        Moves entered on the opponent’s turn in live lichess games. Queue: several premoves, played
        one per turn while each is legal; Esc or a right-click clears them.
      </p>

      <button type="button" className={styles.reset} onClick={() => s.reset()}>
        Reset to defaults
      </button>

      <ServerTokenField />
      <ReviewEngineField />
      <MaiaHintsField />
      <ReviewCacheField />
      <AboutField />
    </div>
  );
}
