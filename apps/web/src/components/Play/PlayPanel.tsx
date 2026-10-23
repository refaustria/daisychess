import { useId, useState } from 'react';
import {
  CUSTOM_INCREMENT,
  CUSTOM_MINUTES,
  customSetting,
  groupedTimeControls,
  LOCAL_TIME_CONTROLS,
  presetOf,
  timeControlLabel,
  toSetting,
  type ClockSetting,
} from '../../clock/timeControls';
import { lockText, useHumanGameLockReason } from '../../live/lock';
import { REASON_TEXT, type EndReason, type GameResult } from '../../play/outcome';
import {
  takeBackPlies,
  usePlayStore,
  type ColorChoice,
  type PlaySetup,
} from '../../play/playStore';
import { findStrength, MOVE_TIMES, STRENGTH_PRESETS } from '../../play/strength';
import { useGameStore, type Orientation } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import styles from './PlayPanel.module.css';

const COLORS: { id: ColorChoice; label: string }[] = [
  { id: 'white', label: 'White' },
  { id: 'black', label: 'Black' },
  { id: 'random', label: 'Random' },
];

const colorName = (c: Orientation) => (c === 'white' ? 'White' : 'Black');

function verdict(result: GameResult | undefined, player: Orientation, reason?: EndReason): string {
  if (!result) return 'Game aborted';
  if (reason === 'timeout') {
    const won = (result === '1-0') === (player === 'white');
    return won ? 'Engine lost on time' : 'You lost on time';
  }
  if (result === '½-½') return 'Draw';
  const won = (result === '1-0') === (player === 'white');
  return won ? 'You won' : 'You lost';
}

async function reviewThisGame(setTab: (t: 'review') => void): Promise<void> {
  const { REVIEW_PRESETS, useReviewStore } = await import('../../review/reviewStore');
  setTab('review');
  const review = useReviewStore.getState();
  review.reset();
  void review.start({ ...REVIEW_PRESETS.deep });
}

const NO_CLOCK = 'none';
const CUSTOM = 'custom';
const GROUPS = groupedTimeControls(LOCAL_TIME_CONTROLS);

/**
 * A number input that keeps what is typed (an empty field or "0." mid-edit) and commits only
 * valid numbers; the committed (clamped) value is shown again on blur.
 */
function NumberField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit(v: number): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className={styles.number}>
      <span>{props.label}</span>
      <input
        type="number"
        inputMode="decimal"
        min={props.min}
        max={props.max}
        step={props.step}
        value={draft ?? String(props.value)}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v) && v >= props.min && v <= props.max) props.onCommit(v);
        }}
        onBlur={(e) => {
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v)) props.onCommit(v);
          setDraft(null);
        }}
      />
    </label>
  );
}

/** "Time control" select (presets by category, Custom, No clock) with the custom inputs. */
function TimeControlField({
  value,
  onChange,
}: {
  value: ClockSetting | null;
  onChange(v: ClockSetting | null): void;
}) {
  const preset = presetOf(value);
  const [custom, setCustom] = useState(value !== null && preset === undefined);
  const selected = value === null ? NO_CLOCK : custom || !preset ? CUSTOM : preset.id;
  const current = value ?? toSetting({ minutes: 5, increment: 0 });
  const minutes = current.initialMs / 60_000;
  const increment = current.incrementMs / 1000;
  return (
    <>
      <label className={styles.field}>
        <span>Time control</span>
        <select
          value={selected}
          onChange={(e) => {
            const v = e.target.value;
            setCustom(v === CUSTOM);
            if (v === NO_CLOCK) onChange(null);
            else if (v === CUSTOM) onChange(current);
            else {
              const t = LOCAL_TIME_CONTROLS.find((x) => x.id === v);
              if (t) onChange(toSetting(t));
            }
          }}
        >
          {GROUPS.map((g) => (
            <optgroup key={g.category} label={g.category}>
              {g.list.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={CUSTOM}>Custom…</option>
          <option value={NO_CLOCK}>No clock</option>
        </select>
      </label>
      {selected === CUSTOM && (
        <div className={styles.custom}>
          <NumberField
            label="Minutes"
            value={minutes}
            min={CUSTOM_MINUTES.min}
            max={CUSTOM_MINUTES.max}
            step={0.25}
            onCommit={(m) => onChange(customSetting(m, increment))}
          />
          <NumberField
            label="Increment (s)"
            value={increment}
            min={CUSTOM_INCREMENT.min}
            max={CUSTOM_INCREMENT.max}
            step={1}
            onCommit={(i) => onChange(customSetting(minutes, i))}
          />
          <span className={styles.note}>{timeControlLabel(current)}</span>
        </div>
      )}
    </>
  );
}

const summaryOf = (playerColor: Orientation, setup: PlaySetup): string =>
  [
    colorName(playerColor),
    findStrength(setup.strength).label,
    setup.timeControl ? timeControlLabel(setup.timeControl) : 'No clock',
    `${setup.timeControl ? 'up to ' : ''}${MOVE_TIMES.find((t) => t.ms === setup.moveTime)?.label ?? ''}`,
  ].join(' · ');

/** "Play vs Engine": setup, running game controls and the result. */
export function PlayPanel() {
  const play = usePlayStore();
  const plies = useGameStore((g) => takeBackPlies(g, play.playerColor));
  const atTip = useGameStore((g) => g.ply === g.moves.length);
  const setTab = useUiStore((s) => s.setActiveTab);
  const id = useId();
  const lock = useHumanGameLockReason();
  const { setup } = play;
  const summary = summaryOf(play.playerColor, setup);

  if (play.mode === 'idle') {
    return (
      <form
        className={styles.panel}
        aria-label="New game against the engine"
        onSubmit={(e) => {
          e.preventDefault();
          play.start();
        }}
      >
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Your colour</legend>
          <div className={styles.segmented}>
            {COLORS.map((c) => (
              <label key={c.id} className={styles.segment}>
                <input
                  type="radio"
                  name={`${id}-color`}
                  value={c.id}
                  checked={setup.color === c.id}
                  onChange={() => play.setSetup({ color: c.id })}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className={styles.field}>
          <span>Strength</span>
          <select
            value={setup.strength}
            onChange={(e) => play.setSetup({ strength: e.target.value })}
          >
            {STRENGTH_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>Thinking time</span>
          <select
            value={setup.moveTime}
            onChange={(e) => play.setSetup({ moveTime: Number(e.target.value) })}
          >
            {MOVE_TIMES.map((t) => (
              <option key={t.ms} value={t.ms}>
                {t.label} per move
              </option>
            ))}
          </select>
        </label>
        <TimeControlField
          value={setup.timeControl ?? null}
          onChange={(timeControl) => play.setSetup({ timeControl })}
        />
        <p className={styles.note}>
          Live analysis is paused during the game and resumes afterwards.
          {setup.timeControl
            ? ' With a clock the engine thinks at most the chosen time, less when its time runs low.'
            : ''}
        </p>
        {lock === 'live' && (
          <p className={styles.error} id={`${id}-locked`}>
            A live game is running. {lockText(lock)}
          </p>
        )}
        {play.message && <p className={styles.error}>{play.message}</p>}
        <button
          type="submit"
          className={styles.primary}
          disabled={lock === 'live'}
          aria-describedby={lock === 'live' ? `${id}-locked` : undefined}
        >
          Start
        </button>
      </form>
    );
  }

  if (play.mode === 'playing') {
    const status = play.thinking
      ? 'Engine thinking…'
      : atTip
        ? 'Your move'
        : 'Your move (go to the last move to play)';
    return (
      <div className={styles.panel}>
        <p className={styles.meta}>{summary}</p>
        <p
          className={play.thinking ? styles.status : `${styles.status} ${styles.statusYou}`}
          data-testid="play-status"
          role="status"
          aria-live="polite"
        >
          {status}
        </p>
        <div className={styles.row}>
          <button type="button" onClick={play.takeBack} disabled={play.thinking || plies === 0}>
            Take back
          </button>
          <button type="button" onClick={play.resign}>
            Resign
          </button>
          <button type="button" onClick={play.stop}>
            Stop
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.panel}>
      <p className={styles.meta}>{summary}</p>
      <div className={styles.result} role="status" aria-live="polite">
        <span className={styles.score} data-testid="play-result">
          {play.result ?? '*'}
        </span>
        <span>
          <strong data-testid="play-verdict">
            {verdict(play.result, play.playerColor, play.reason)}
          </strong>
          {play.reason && play.reason !== 'timeout' && <> — {REASON_TEXT[play.reason]}</>}
        </span>
      </div>
      {play.message && (
        <p className={styles.error} role="alert">
          {play.message}
        </p>
      )}
      <div className={styles.row}>
        <button type="button" className={styles.primary} onClick={play.rematch}>
          Rematch
        </button>
        <button type="button" onClick={() => void reviewThisGame(setTab)}>
          Review this game
        </button>
        <button type="button" onClick={play.stop}>
          New setup
        </button>
      </div>
    </div>
  );
}
