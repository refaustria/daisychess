import { MOVE_CLASSES, type ReviewedMove, type ReviewSummary } from '@daisychess/engine-core';
import { ShareButton } from '../Share/ShareButton';
import { isNativeApp } from '../../platform';
import { useUiStore } from '../../store/uiStore';
import { useEffect, useMemo, useState } from 'react';
import { annotatePgn } from '../../review/annotatePgn';
import { reviewHighlights } from '../../review/details';
import { CLASS_INFO, bestMoveSan, moveNumberLabel } from '../../review/format';
import { useHumanGameLockReason } from '../../live/lock';
import { cachedReviewLabel, covers } from '../../review/reviewCache';
import { REVIEW_PRESETS, useReviewStore, type ReviewEngineInfo } from '../../review/reviewStore';
import { hasClockData } from '../../clock/gameTimes';
import { formatDuration, isTimeTrouble, sideTimeStats } from '../../review/timeUsage';
import { START_FEN, useGameStore } from '../../store/gameStore';
import { useSettingsStore } from '../../store/settingsStore';
import { requestMaiaHints, useGameHints } from '../../maia/hintStore';
import { requestEloEstimate } from '../../maia/eloEstimate';
import { activeGameSources } from '../../puzzles/installLedger';
import { useOpeningFocus } from '../../review/useOpeningFocus';
import { EloLine } from './EloLine';
import { levelSource, levelText, typicalMistakes } from '../../maia/hintText';
import { EvalGraph } from './EvalGraph';
import { TimeGraph } from './TimeGraph';
import { TimeTroubleBadge } from './TimeTroubleBadge';
import { MoveCommentary } from './MoveCommentary';
import { OpeningFocusBlock } from './OpeningFocusBlock';
import { ReviewTour } from './ReviewTour';
import { authHintsNote } from '../../server/tokenMessages';
import { OpenSettingsButton } from '../Settings/OpenSettingsButton';
import styles from './ReviewPanel.module.css';

type PresetKey = keyof typeof REVIEW_PRESETS;
const PRESET_LABELS: Record<PresetKey, string> = {
  fast: 'Fast (0.3 s/move)',
  deep: 'Deep (depth 18)',
};

/**
 * "Reviewing on server (Stockfish 19, 8 threads)…" / "Reviewing in browser…" / "Reviewing…"
 * (engine not chosen yet); with `done` "Reviewed on server (…)." / "Reviewed in browser.".
 */
export function reviewingLabel(runsOn: ReviewEngineInfo | undefined, done = false): string {
  const verb = done ? 'Reviewed' : 'Reviewing';
  const end = done ? '.' : '…';
  if (!runsOn) return `${verb}${end}`;
  if (runsOn.kind === 'browser') return `${verb} in browser${end}`;
  const details = [
    runsOn.name,
    runsOn.threads !== undefined
      ? `${runsOn.threads} thread${runsOn.threads === 1 ? '' : 's'}`
      : undefined,
  ].filter(Boolean);
  return `${verb} on server${details.length > 0 ? ` (${details.join(', ')})` : ''}${end}`;
}

function download(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-chess-pgn' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'daisychess-review.pgn';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Player name from the PGN headers (`?` = unknown) or the colour. */
function playerName(headers: Record<string, string>, color: 'white' | 'black'): string {
  const key = color === 'white' ? 'White' : 'Black';
  const v = headers[key]?.trim();
  return v && v !== '?' ? v : key;
}

function MoveItem({ move, showBest }: { move: ReviewedMove; showBest: boolean }) {
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const timeControl = useGameStore((s) => s.timeControl);
  const goTo = useGameStore((s) => s.goTo);
  const info = CLASS_INFO[move.classification];
  const best = showBest ? bestMoveSan(startFen, moves, move) : undefined;
  const trouble = isTimeTrouble({ startFen, moves, timeControl }, move);
  const loss = Math.round(move.winProbLoss);
  return (
    <li>
      <button type="button" className={styles.moment} onClick={() => goTo(move.ply)}>
        <span className={styles.momentMain}>
          <span className={styles.dot} style={{ background: info.color }} aria-hidden />
          <span>
            {moveNumberLabel(startFen, move.ply)} {move.san ?? move.uci}
            {info.glyph}
            {loss >= 1 && ` (\u2212${loss}%)`}
          </span>
          {trouble && <TimeTroubleBadge />}
        </span>
        {best && <span className={styles.best}>best was {best}</span>}
      </button>
    </li>
  );
}

/** "Good moves" and "Moves to improve" per side (replaces the former key-moments list). */
function Highlights({ summary }: { summary: ReviewSummary }) {
  const headers = useGameStore((s) => s.headers);
  const h = useMemo(() => reviewHighlights(summary), [summary]);
  return (
    <div className={styles.highlights}>
      {(['white', 'black'] as const).map((color) => {
        const name = color === 'white' ? 'White' : 'Black';
        const { good, improve } = h[color];
        return (
          <section key={color} className={styles.side} aria-label={`${name} highlights`}>
            <h3 className={styles.h3}>{playerName(headers, color)}</h3>
            <h4 className={styles.h4}>Good moves</h4>
            {good.length > 0 ? (
              <ul className={styles.moments}>
                {good.map((m) => (
                  <MoveItem key={m.ply} move={m} showBest={false} />
                ))}
              </ul>
            ) : (
              <p className={styles.muted}>None.</p>
            )}
            <h4 className={styles.h4}>Moves to improve</h4>
            {improve.length > 0 ? (
              <ul className={styles.moments}>
                {improve.map((m) => (
                  <MoveItem key={m.ply} move={m} showBest />
                ))}
              </ul>
            ) : (
              <p className={styles.muted}>No inaccuracies, mistakes or blunders.</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Per player: average time per move, longest think (jumps there), mistakes in time trouble. */
function TimeSummary({ summary }: { summary: ReviewSummary }) {
  const headers = useGameStore((s) => s.headers);
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const timeControl = useGameStore((s) => s.timeControl);
  const goTo = useGameStore((s) => s.goTo);
  const stats = useMemo(
    () => sideTimeStats({ startFen, moves, timeControl }, summary),
    [startFen, moves, timeControl, summary],
  );
  const colors = ['white', 'black'] as const;
  return (
    <table className={styles.timeStats} data-testid="time-summary">
      <caption className={styles.muted}>Time usage</caption>
      <thead>
        <tr>
          <th scope="col">Clock</th>
          {colors.map((c) => (
            <th key={c} scope="col">
              {playerName(headers, c)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <th scope="row">Average per move</th>
          {colors.map((c) => {
            const avg = stats[c].avgMs;
            return (
              <td key={c} data-testid={`time-avg-${c}`}>
                {avg !== undefined ? formatDuration(avg) : '–'}
              </td>
            );
          })}
        </tr>
        <tr>
          <th scope="row">Longest think</th>
          {colors.map((c) => {
            const l = stats[c].longest;
            return (
              <td key={c} data-testid={`time-longest-${c}`}>
                {l ? (
                  <button
                    type="button"
                    onClick={() => goTo(l.ply)}
                    aria-label={`Longest think of ${c === 'white' ? 'White' : 'Black'}: ${formatDuration(l.ms)} on ${moveNumberLabel(startFen, l.ply)} ${moves[l.ply - 1]?.san ?? ''}, go to move`}
                  >
                    {formatDuration(l.ms)} ({moveNumberLabel(startFen, l.ply)}{' '}
                    {moves[l.ply - 1]?.san})
                  </button>
                ) : (
                  '–'
                )}
              </td>
            );
          })}
        </tr>
        <tr>
          <th scope="row">Mistakes in time trouble</th>
          {colors.map((c) => (
            <td key={c} data-testid={`time-trouble-${c}`}>
              {stats[c].timeTroubleMistakes}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

/**
 * Requests the Maia hints (M23-3) once the review of the game on the board is done (computed or
 * loaded from a cache); again when the level setting, the toggle or the token change. Then the Elo
 * estimate (ADR-024 §5): its fallback at once, its Maia run after the hints run, once the opening
 * book told where the book ends.
 */
function useMaiaHintRequest(): void {
  const status = useReviewStore((s) => s.status);
  const summary = useReviewStore((s) => s.summary);
  const details = useReviewStore((s) => s.moveDetails);
  const reviewed = useReviewStore((s) => s.reviewed);
  const storedElo = useReviewStore((s) => s.stored?.elo);
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const headers = useGameStore((s) => s.headers);
  const enabled = useSettingsStore((s) => s.maiaHints);
  const rating = useSettingsStore((s) => s.maiaRating);
  const token = useSettingsStore((s) => s.serverToken);
  const reviewEngine = useSettingsStore((s) => s.reviewEngine);
  const focus = useOpeningFocus();
  // A custom start has no book; otherwise wait for the lazily loaded book.
  const lastBookPly = startFen !== START_FEN ? 0 : focus?.lastBookPly;
  useEffect(() => {
    if (status !== 'done' || !summary || reviewed !== moves) return;
    if (moves.length === 0 || summary.moves.length !== moves.length) return;
    const hintsRun = requestMaiaHints({
      startFen,
      moves,
      headers,
      details,
      enabled,
      fallbackRating: rating,
    });
    if (lastBookPly === undefined) return;
    const player = activeGameSources(headers).play;
    void requestEloEstimate({
      startFen,
      moves,
      summary,
      details,
      lastBookPly,
      ...(headers.TimeControl ? { timeControl: headers.TimeControl } : {}),
      enabled,
      reviewEngine,
      ...(storedElo ? { storedElo } : {}),
      ...(player ? { engineSide: player === 'white' ? 'black' : 'white' } : {}),
      after: hintsRun,
    });
  }, [
    status,
    summary,
    details,
    reviewed,
    startFen,
    moves,
    headers,
    enabled,
    rating,
    token,
    reviewEngine,
    storedElo,
    lastBookPly,
  ]);
}

/**
 * "Typical mistakes (Maia predicted)" per player: mistakes/blunders that were Maia's most likely
 * move at the player's level vs. unusual ones; or the one muted line when the token is missing.
 */
function MaiaSummary({ summary }: { summary: ReviewSummary }) {
  const headers = useGameStore((s) => s.headers);
  const state = useGameHints();
  const counts = useMemo(
    () => (state ? typicalMistakes(summary, state.hints) : undefined),
    [summary, state],
  );
  if (!state) return null;
  if (state.status === 'unauthorized') {
    return (
      <>
        <p className={styles.muted} data-testid="maia-token-note">
          {authHintsNote()}
        </p>
        <OpenSettingsButton className={styles.settingsLink} />
      </>
    );
  }
  if (!counts || !state.levels || state.status === 'off') return null;
  const levels = state.levels;
  const sides = (['white', 'black'] as const).filter(
    (c) => counts[c].typical + counts[c].unusual > 0,
  );
  if (sides.length === 0) return null;
  return (
    <section
      className={styles.maiaSummary}
      data-testid="maia-summary"
      aria-label="Typical mistakes"
    >
      <h3 className={styles.h3}>Typical mistakes (Maia predicted)</h3>
      <ul>
        {sides.map((c) => {
          const n = counts[c];
          return (
            <li key={c} data-testid={`maia-summary-${c}`} title={levelSource(levels[c])}>
              {playerName(headers, c)} at {levelText(levels[c])}: {n.typical} typical, {n.unusual}{' '}
              unusual
              {n.pending > 0
                ? state.status === 'running'
                  ? ' …'
                  : ` (${n.pending} without a hint)`
                : ''}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Done({ summary }: { summary: ReviewSummary }) {
  const headers = useGameStore((s) => s.headers);
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const ply = useGameStore((s) => s.ply);
  const timeControl = useGameStore((s) => s.timeControl);
  const goTo = useGameStore((s) => s.goTo);
  const timed = hasClockData(moves);
  const [copied, setCopied] = useState(false);
  const pgn = useMemo(
    () => annotatePgn(headers, startFen, moves, summary),
    [headers, startFen, moves, summary],
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pgn);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  const side = (color: 'white' | 'black') => (
    <div className={styles.accuracy}>
      <span className={styles.accName}>{playerName(headers, color)}</span>
      <span className={styles.accValue} data-testid={`accuracy-${color}`}>
        {Math.round(summary[color].accuracy)}%
      </span>
      <span className={styles.muted}>accuracy</span>
      <EloLine side={color} />
    </div>
  );
  return (
    <>
      <div className={styles.accuracies}>
        {side('white')}
        {side('black')}
      </div>
      <table className={styles.counts}>
        <thead>
          <tr>
            <th scope="col">Move type</th>
            <th scope="col">White</th>
            <th scope="col">Black</th>
          </tr>
        </thead>
        <tbody>
          {MOVE_CLASSES.map((c) => (
            <tr key={c}>
              <th scope="row">
                <span
                  className={styles.dot}
                  style={{ background: CLASS_INFO[c].color }}
                  aria-hidden
                />
                {CLASS_INFO[c].label}
              </th>
              <td>{summary.white.counts[c]}</td>
              <td>{summary.black.counts[c]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MaiaSummary summary={summary} />
      <EvalGraph summary={summary} ply={ply} onSeek={goTo} />
      {timed && (
        <>
          <TimeGraph game={{ startFen, moves, timeControl }} ply={ply} onSeek={goTo} />
          <TimeSummary summary={summary} />
        </>
      )}
      <h2 className={styles.h}>Highlights</h2>
      <Highlights summary={summary} />
      <div className={styles.row}>
        {!isNativeApp() && (
          <button type="button" className={styles.btn} onClick={() => download(pgn)}>
            Export annotated PGN
          </button>
        )}
        <ShareButton
          className={styles.btn}
          label="Share PGN"
          testId="review-share"
          content={{ title: 'DaisyChess game review', text: pgn }}
          onResult={(r) =>
            r === 'failed' && useUiStore.getState().showNotice('Could not share the PGN')
          }
        />
        <button type="button" className={styles.btn} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </>
  );
}

export function ReviewPanel() {
  const status = useReviewStore((s) => s.status);
  const progress = useReviewStore((s) => s.progress);
  const summary = useReviewStore((s) => s.summary);
  const details = useReviewStore((s) => s.moveDetails);
  const error = useReviewStore((s) => s.error);
  const autoNotice = useReviewStore((s) => s.autoNotice);
  const runsOn = useReviewStore((s) => s.runsOn);
  const engineNotice = useReviewStore((s) => s.engineNotice);
  const start = useReviewStore((s) => s.start);
  const cancel = useReviewStore((s) => s.cancel);
  const reset = useReviewStore((s) => s.reset);
  const dismiss = useReviewStore((s) => s.dismissAutoNotice);
  const hasMoves = useGameStore((s) => s.moves.length > 0);
  // Review cache (ADR-016): the shown review of this game is stored with at least this preset.
  const stored = useReviewStore((s) => s.stored);
  const ofThisGame = useReviewStore((s) => s.reviewed) === useGameStore((s) => s.moves);
  const lock = useHumanGameLockReason();
  const playing = lock !== null;
  useMaiaHintRequest();
  const [preset, setPreset] = useState<PresetKey>('deep');
  const alreadyReviewed =
    status === 'done' && ofThisGame && stored && covers(stored.preset, preset)
      ? stored.preset
      : undefined;

  /** A manual start always (re)starts with the chosen preset, replacing a running review. */
  const run = (key: PresetKey = preset) => {
    if (status === 'running' || status === 'done') reset();
    void start({ ...REVIEW_PRESETS[key] });
  };
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className={styles.wrap} data-testid="review-panel" data-status={status}>
      {status === 'idle' || status === 'cancelled' ? (
        <p>
          Analyse every move of the game with the engine to classify mistakes, compute accuracy and
          find key moments.
          {status === 'cancelled' && ' The previous review was cancelled.'}
        </p>
      ) : null}
      <div className={styles.row} role="radiogroup" aria-label="Review depth">
        {(Object.keys(REVIEW_PRESETS) as PresetKey[]).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={preset === k}
            className={preset === k ? styles.presetActive : styles.preset}
            onClick={() => setPreset(k)}
          >
            {PRESET_LABELS[k]}
          </button>
        ))}
      </div>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.btnPrimary}
          disabled={!hasMoves || playing || alreadyReviewed !== undefined}
          onClick={() => run()}
        >
          Start
        </button>
        {status === 'running' && (
          <button type="button" className={styles.btn} onClick={cancel}>
            Cancel
          </button>
        )}
        {playing ? (
          <span className={styles.muted}>
            {lock === 'live'
              ? 'Review is disabled during a live game (lichess fair play)'
              : lock === 'room'
                ? 'Review is disabled during a game against a friend (fair play)'
                : 'Finish or stop the game first'}
          </span>
        ) : (
          <>
            {!hasMoves && <span className={styles.muted}>Play or import a game first.</span>}
            {alreadyReviewed && (
              <span className={styles.muted} data-testid="review-already">
                Already reviewed ({alreadyReviewed})
              </span>
            )}
          </>
        )}
      </div>
      {/* After a failed auto review the error says it all ("run Deep" would fail the same way). */}
      {autoNotice && status !== 'error' && (
        <div className={styles.notice} data-testid="auto-notice">
          <span>Auto review (fast) — run Deep for more accuracy.</span>
          <button
            type="button"
            className={styles.linkBtn}
            disabled={playing}
            onClick={() => {
              setPreset('deep');
              run('deep');
            }}
          >
            Run Deep
          </button>
          <button
            type="button"
            className={styles.close}
            aria-label="Dismiss auto review notice"
            onClick={dismiss}
          >
            ×
          </button>
        </div>
      )}
      {engineNotice && status !== 'idle' && (
        <p className={styles.muted} data-testid="review-engine-notice" role="status">
          {engineNotice}
        </p>
      )}
      {status === 'running' && (
        <>
          <p data-testid="review-engine" data-engine={runsOn?.kind ?? 'pending'}>
            {reviewingLabel(runsOn)} live analysis is paused.
          </p>
          <div
            className={styles.bar}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-label="Review progress"
          >
            <div className={styles.barFill} style={{ width: `${pct}%` }} />
          </div>
          <p className={styles.muted} role="status" aria-live="polite">
            {progress.done}/{progress.total} ({pct}%)
          </p>
        </>
      )}
      {status === 'error' && (
        <>
          <p role="alert" className={styles.error}>
            Review failed: {error ?? 'unknown error'}
          </p>
          <div className={styles.row}>
            <button type="button" className={styles.btn} onClick={() => run()}>
              Retry
            </button>
          </div>
        </>
      )}
      {/* The review summary starts with the opening focus (M18-3). */}
      {status === 'done' && summary && <OpeningFocusBlock />}
      {status === 'done' && summary && <ReviewTour />}
      {summary && (status === 'running' || status === 'done') && (
        <MoveCommentary summary={summary} details={details} running={status === 'running'} />
      )}
      {status === 'done' && runsOn && (
        <p className={styles.muted} data-testid="review-engine" data-engine={runsOn.kind}>
          {stored?.fromCache ? cachedReviewLabel(stored) : reviewingLabel(runsOn, true)}
        </p>
      )}
      {status === 'done' && summary && <Done summary={summary} />}
    </div>
  );
}
