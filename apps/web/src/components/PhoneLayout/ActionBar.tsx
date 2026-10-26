/**
 * Phone action bar (M29-6): the main controls of the active tab/mode, always visible directly
 * under the board. Every button calls the same store action as the panel button it duplicates;
 * those panel buttons carry `data-phone-bar` and are hidden on phones (App.module.css), so each
 * control exists once in the accessibility tree.
 */
import type { ReactNode } from 'react';
import { formatClock, isLowTime } from '../../clock/format';
import type { LiveGame } from '../../live/LiveGameController';
import { useHumanGameLockReason, lockText } from '../../live/lock';
import { useLiveStore } from '../../live/liveStore';
import { setResignConfirm, useResignConfirm } from '../../live/resignConfirm';
import { reviewThisGame } from '../../play/reviewThisGame';
import { takeBackPlies, usePlayStore } from '../../play/playStore';
import { useMistakeSession } from '../../puzzles/mistakeSession';
import { endMistakeTraining, nextDueMistake } from '../../puzzles/mistakeTraining';
import { usePuzzleStore } from '../../puzzles/puzzleStore';
import { RUSH_STRIKES, useRushStore } from '../../puzzles/rushStore';
import { findJump } from '../../review/details';
import { useReviewStore } from '../../review/reviewStore';
import { useAnalysisStore } from '../../store/analysisStore';
import { useGameStore } from '../../store/gameStore';
import { useUiStore, type PuzzleMode, type TabId } from '../../store/uiStore';
import { useDrillStore } from '../../trainer/drillStore';
import { useTicker } from '../Live/LiveClock';
import { HINT_TITLE } from '../Puzzles/PuzzlesPanel';
import { usePuzzleActions } from '../Puzzles/usePuzzleActions';
import styles from './PhoneLayout.module.css';

export type BarKind =
  'analysis' | 'puzzles' | 'rush' | 'mistakes' | 'review' | 'play' | 'live' | 'drill';

export interface BarInput {
  tab: TabId;
  puzzleMode: PuzzleMode;
  rushRunning: boolean;
  mistakeSession: boolean;
  hasReview: boolean;
  drillShown: boolean;
  playMode: 'idle' | 'playing' | 'finished';
  /** A live game is shown by the Live panel (running, or finished with its result). */
  liveGame: 'none' | 'playing' | 'finished';
}

/**
 * Which controls the bar shows. It mirrors what the panel of `tab` shows (its duplicated buttons
 * are hidden on phones): a running game also drives the bar of the Moves and other plain tabs.
 */
export function barKind(s: BarInput): BarKind {
  switch (s.tab) {
    case 'puzzles':
      if (s.puzzleMode === 'rush') return s.rushRunning ? 'rush' : 'analysis';
      if (s.puzzleMode === 'mistakes') return s.mistakeSession ? 'mistakes' : 'analysis';
      return 'puzzles';
    case 'review':
      return s.hasReview ? 'review' : 'analysis';
    case 'openings':
      return s.drillShown ? 'drill' : 'analysis';
    case 'live':
      return s.liveGame !== 'none' ? 'live' : 'analysis';
    case 'play':
      return s.playMode !== 'idle' ? 'play' : 'analysis';
    default:
      if (s.liveGame === 'playing') return 'live';
      if (s.playMode === 'playing') return 'play';
      return 'analysis';
  }
}

function Btn({
  label,
  children,
  onClick,
  disabled,
  primary,
  icon,
  title,
  pressed,
}: {
  /** Accessible name; it starts with/contains the visible text (WCAG 2.5.3). */
  label?: string;
  children: ReactNode;
  onClick(): void;
  disabled?: boolean;
  primary?: boolean;
  icon?: boolean;
  title?: string;
  pressed?: boolean;
}) {
  const cls = [styles.barBtn, primary ? styles.barPrimary : '', icon ? styles.barIcon : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={cls}
      aria-label={label}
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PrevNext() {
  const ply = useGameStore((s) => s.ply);
  const total = useGameStore((s) => s.moves.length);
  const { prev, next } = useGameStore.getState();
  return (
    <>
      <Btn icon label="Previous move" onClick={prev} disabled={ply === 0}>
        ◀
      </Btn>
      <Btn icon label="Next move" onClick={next} disabled={ply >= total}>
        ▶
      </Btn>
    </>
  );
}

function AnalysisBar() {
  const ply = useGameStore((s) => s.ply);
  const total = useGameStore((s) => s.moves.length);
  const { first, last } = useGameStore.getState();
  const enabled = useAnalysisStore((s) => s.enabled);
  const lock = useHumanGameLockReason();
  const locked = lock !== null;
  return (
    <>
      <Btn icon label="First move" onClick={first} disabled={ply === 0}>
        ⏮
      </Btn>
      <PrevNext />
      <Btn icon label="Last move" onClick={last} disabled={ply >= total}>
        ⏭
      </Btn>
      <Btn
        label="Engine"
        pressed={enabled && !locked}
        disabled={locked}
        title={lockText(lock)}
        onClick={() => useAnalysisStore.getState().setEnabled(!enabled)}
      >
        <span className={styles.engineDot} data-on={enabled && !locked} aria-hidden="true" />
        Engine
      </Btn>
    </>
  );
}

function PuzzleBar() {
  const a = usePuzzleActions();
  const store = usePuzzleStore.getState;
  return (
    <>
      {a.wrong && <Btn onClick={() => store().retry()}>Try again</Btn>}
      {a.started && !a.finished && (
        <>
          <Btn disabled={!a.canHint} title={HINT_TITLE} onClick={() => store().hint()}>
            Hint
          </Btn>
          <Btn label="Show solution" disabled={!a.canShow} onClick={() => store().showSolution()}>
            Solution
          </Btn>
        </>
      )}
      {a.finished && <Btn onClick={() => store().analyse()}>Analyse</Btn>}
      <Btn
        primary
        label={a.nextLabel}
        disabled={a.nextDisabled}
        onClick={() => void store().next()}
      >
        {a.started ? 'Next' : 'Start'}
      </Btn>
    </>
  );
}

function RushBar() {
  const remainingMs = useRushStore((s) => s.remainingMs);
  const duration = useRushStore((s) => s.duration);
  const score = useRushStore((s) => s.score);
  const strikes = useRushStore((s) => s.strikes);
  return (
    <>
      <span
        className={`${styles.barTimer} ${isLowTime(remainingMs, duration * 60_000) ? styles.barLow : ''}`}
        role="timer"
        aria-live="off"
        aria-label={`Time left ${formatClock(remainingMs)}`}
        data-testid="bar-rush-timer"
      >
        {formatClock(remainingMs)}
      </span>
      <span className={styles.barText} data-testid="bar-rush-score">
        Score <strong>{score}</strong>
      </span>
      <span
        className={styles.barText}
        aria-label={`${strikes} of ${RUSH_STRIKES} strikes`}
        data-testid="bar-rush-strikes"
      >
        {Array.from({ length: RUSH_STRIKES }, (_, i) => (
          <span key={i} className={i < strikes ? styles.strikeOn : styles.strikeOff} aria-hidden>
            ✗
          </span>
        ))}
      </span>
      <Btn label="End run" onClick={() => useRushStore.getState().end()}>
        End
      </Btn>
    </>
  );
}

function MistakesBar() {
  const status = usePuzzleStore((s) => s.status);
  const userTurn = usePuzzleStore((s) => s.status === 'running' && s.solver?.phase === 'user');
  const lock = useHumanGameLockReason();
  return (
    <>
      <Btn disabled={!userTurn} onClick={() => usePuzzleStore.getState().hint()}>
        Hint
      </Btn>
      <Btn primary disabled={status !== 'done'} onClick={() => nextDueMistake(lock)}>
        Next due
      </Btn>
      <Btn label="End training" onClick={endMistakeTraining}>
        End
      </Btn>
    </>
  );
}

function ReviewBar() {
  const ply = useGameStore((s) => s.ply);
  const summary = useReviewStore((s) => s.summary);
  const next = summary ? findJump(summary, ply, 1) : undefined;
  return (
    <>
      <PrevNext />
      <Btn
        primary
        disabled={next === undefined}
        onClick={() => next !== undefined && useGameStore.getState().goTo(next)}
      >
        Next mistake
      </Btn>
    </>
  );
}

function PlayBar() {
  const play = usePlayStore();
  const plies = useGameStore((g) => takeBackPlies(g, play.playerColor, play.fromPly));
  const setTab = useUiStore((s) => s.setActiveTab);
  if (play.mode === 'playing') {
    return (
      <>
        <PrevNext />
        <Btn onClick={play.takeBack} disabled={play.thinking || plies === 0}>
          Take back
        </Btn>
        <Btn onClick={play.resign}>Resign</Btn>
        <Btn onClick={play.stop}>Stop</Btn>
      </>
    );
  }
  return (
    <>
      <Btn primary onClick={play.rematch}>
        Rematch
      </Btn>
      <Btn label="Review this game" onClick={() => void reviewThisGame(setTab)}>
        Review
      </Btn>
      <Btn onClick={play.stop}>New setup</Btn>
    </>
  );
}

function LivePlayingBar({ game }: { game: LiveGame }) {
  const live = useLiveStore.getState();
  const confirm = useResignConfirm((s) => s.open);
  const claimAt = game.opponentGone?.claimAt;
  const now = useTicker(claimAt !== undefined, Date.now, 500);
  const canAbort = game.moves.length < 2;
  const canClaim = claimAt !== undefined && now >= claimAt;
  if (confirm) {
    return (
      <>
        <span className={styles.barText}>Resign?</span>
        <Btn
          primary
          onClick={() => {
            setResignConfirm(false);
            void live.resign();
          }}
        >
          Yes, resign
        </Btn>
        <Btn onClick={() => setResignConfirm(false)}>No</Btn>
      </>
    );
  }
  return (
    <>
      <PrevNext />
      <Btn onClick={() => void live.offerDraw()} disabled={game.drawOffer !== undefined}>
        {game.drawOffer === 'mine' ? 'Draw offered' : 'Offer draw'}
      </Btn>
      {canAbort ? (
        <Btn onClick={() => void live.abort()}>Abort</Btn>
      ) : (
        <Btn onClick={() => setResignConfirm(true)}>Resign</Btn>
      )}
      {canClaim && (
        <Btn primary onClick={() => void live.claimVictory()}>
          Claim victory
        </Btn>
      )}
    </>
  );
}

function LiveBar() {
  const status = useLiveStore((s) => s.status);
  const game = useLiveStore((s) => s.game);
  const setTab = useUiStore((s) => s.setActiveTab);
  if (!game) return <AnalysisBar />;
  // Same condition as the Live panel's game view (its buttons are hidden on phones).
  if (status === 'playing') return <LivePlayingBar game={game} />;
  return (
    <>
      <Btn primary onClick={() => useLiveStore.getState().leave()}>
        New game
      </Btn>
      <Btn label="Review this game" onClick={() => setTab('review')}>
        Review
      </Btn>
    </>
  );
}

function DrillBar() {
  const status = useDrillStore((s) => s.status);
  const phase = useDrillStore((s) => s.phase);
  const lock = useHumanGameLockReason();
  const s = useDrillStore.getState();
  if (status === 'running') {
    return (
      <>
        <PrevNext />
        {phase === 'retry' && (
          <Btn primary onClick={s.retry}>
            Try again
          </Btn>
        )}
        <Btn onClick={() => s.stop()}>Stop drill</Btn>
      </>
    );
  }
  return (
    <>
      <Btn primary disabled={lock !== null} onClick={s.repeat}>
        Repeat
      </Btn>
      <Btn disabled={lock !== null} onClick={s.next}>
        Next variation
      </Btn>
      <Btn label="Play on vs engine" onClick={s.playOn}>
        Play on
      </Btn>
    </>
  );
}

const BARS: Record<BarKind, () => ReactNode> = {
  analysis: () => <AnalysisBar />,
  puzzles: () => <PuzzleBar />,
  rush: () => <RushBar />,
  mistakes: () => <MistakesBar />,
  review: () => <ReviewBar />,
  play: () => <PlayBar />,
  live: () => <LiveBar />,
  drill: () => <DrillBar />,
};

/** The bar's current kind from the stores. */
export function useBarKind(): BarKind {
  const tab = useUiStore((s) => s.activeTab);
  const puzzleMode = useUiStore((s) => s.puzzleMode);
  const rushRunning = useRushStore((s) => s.status === 'running');
  const mistakeSession = useMistakeSession((s) => s.active);
  // Same condition as the Review panel's move card (its "Next mistake" is hidden on phones).
  const hasReview = useReviewStore(
    (s) => s.summary !== undefined && (s.status === 'running' || s.status === 'done'),
  );
  const drillShown = useDrillStore(
    (s) => s.status === 'running' || (s.status === 'done' && s.summary !== undefined),
  );
  const playMode = usePlayStore((s) => s.mode);
  const liveGame = useLiveStore((s) =>
    !s.game
      ? 'none'
      : s.status === 'playing'
        ? 'playing'
        : s.status === 'finished'
          ? 'finished'
          : 'none',
  );
  return barKind({
    tab,
    puzzleMode,
    rushRunning,
    mistakeSession,
    hasReview,
    drillShown,
    playMode,
    liveGame,
  });
}

export function ActionBar() {
  const kind = useBarKind();
  return (
    <div
      className={styles.actionBar}
      role="toolbar"
      aria-label="Actions"
      data-testid="action-bar"
      data-kind={kind}
    >
      {BARS[kind]()}
    </div>
  );
}
