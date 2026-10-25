import '@daisychess/ui-theme/base.css';
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { AnalysisPanel } from './components/Analysis/AnalysisPanel';
import { PreviewBanner } from './components/Analysis/PreviewBanner';
import { analysisShapes, reviewShapes } from './components/Analysis/shapes';
import { Board } from './components/Board/Board';
import { Controls } from './components/Controls/Controls';
import { EngineToggle } from './components/EngineToggle/EngineToggle';
import { ConnectedEvalBar } from './components/EvalBar/EvalBar';
import { ImportPanel } from './components/Import/ImportPanel';
import { AccountChip } from './components/LichessAccount/AccountChip';
import { ThemeToggle } from './components/ThemeToggle/ThemeToggle';
import { MoveList } from './components/MoveList/MoveList';
import { PlayIndicator } from './components/Play/PlayIndicator';
import { PlayerBar, useBoardPlayers } from './components/PlayerBar/PlayerBar';
import { usePlayMovableColor } from './components/Play/usePlayBoard';
import { installAutoReview } from './review/autoReview';
import { installReviewTour } from './review/tourStore';
import { installRoomRoute } from './room/roomStore';
import { useRoomStatus } from './room/useRoomStatus';
import { useReviewStore } from './review/reviewStore';
import { selectPrimary, useAnalysisStore } from './store/analysisStore';
import { usePreviewStore } from './store/previewStore';
import { useDrillArrows, useDrillMovableColor } from './components/Openings/useDrillBoard';
import { useUiStore, type TabId } from './store/uiStore';
import {
  currentFen,
  gameStatus,
  isCheck,
  turn,
  useGameStore,
  type GameState,
} from './store/gameStore';
import styles from './App.module.css';

const PlayPanel = lazy(() =>
  import('./components/Play/PlayPanel').then((m) => ({ default: m.PlayPanel })),
);
const OpeningsPanel = lazy(() =>
  import('./components/Openings/OpeningsPanel').then((m) => ({ default: m.OpeningsPanel })),
);
const LivePanel = lazy(() =>
  import('./components/Live/LivePanel').then((m) => ({ default: m.LivePanel })),
);
const FriendPanel = lazy(() =>
  import('./components/Room/FriendPanel').then((m) => ({ default: m.FriendPanel })),
);
const ReviewPanel = lazy(() =>
  import('./components/Review/ReviewPanel').then((m) => ({ default: m.ReviewPanel })),
);
const ExplorerPanel = lazy(() =>
  import('./components/Explorer/ExplorerPanel').then((m) => ({ default: m.ExplorerPanel })),
);
const SettingsPanel = lazy(() =>
  import('./components/Settings/SettingsPanel').then((m) => ({ default: m.SettingsPanel })),
);

const TABS: { id: TabId; label: string }[] = [
  { id: 'moves', label: 'Moves' },
  { id: 'play', label: 'Play' },
  { id: 'openings', label: 'Openings' },
  { id: 'live', label: 'Live' },
  { id: 'friend', label: 'Friend' },
  { id: 'import', label: 'Import' },
  { id: 'review', label: 'Review' },
  { id: 'explorer', label: 'Explorer' },
  { id: 'settings', label: 'Settings' },
];

/** Scrolls the tab row horizontally so that the tab `id` is fully visible. */
function revealTab(row: HTMLElement | null, id: TabId): void {
  const el = row?.querySelector<HTMLElement>(`#tab-${id}`);
  if (!row || !el) return;
  // The row is `position: relative`, so offsetLeft is relative to it.
  const left = el.offsetLeft;
  const right = left + el.offsetWidth;
  if (left < row.scrollLeft) row.scrollLeft = left;
  else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth;
}

/** WAI-ARIA tabs: arrows/Home/End move focus and activate (automatic activation), roving tabindex. */
function onTabKeyDown(e: KeyboardEvent<HTMLElement>, tab: TabId, setTab: (t: TabId) => void) {
  const i = TABS.findIndex((t) => t.id === tab);
  let next: number;
  switch (e.key) {
    case 'ArrowRight':
      next = (i + 1) % TABS.length;
      break;
    case 'ArrowLeft':
      next = (i - 1 + TABS.length) % TABS.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = TABS.length - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  const id = TABS[next]!.id;
  setTab(id);
  document.getElementById(`tab-${id}`)?.focus();
}

export function statusText(s: GameState): string {
  const side = turn(s);
  switch (gameStatus(s)) {
    case 'checkmate':
      return `Checkmate — ${side === 'white' ? 'Black' : 'White'} wins`;
    case 'stalemate':
      return 'Stalemate — draw';
    case 'draw':
      return 'Draw';
    default:
      if (isCheck(s)) return 'Check!';
      return `${side === 'white' ? 'White' : 'Black'} to move`;
  }
}

/**
 * Board wired to the preview store and the arrows: the live engine's best move, or, while the
 * Review tab shows a review, the played and the best move of the displayed ply.
 */
function ConnectedBoard() {
  const previewFen = usePreviewStore((s) => s.fen);
  const hover = usePreviewStore((s) => s.hover);
  const gameFen = useGameStore(currentFen);
  const enabled = useAnalysisStore((s) => s.enabled);
  const terminal = useAnalysisStore((s) => s.terminal);
  const analysisFen = useAnalysisStore((s) => s.fen);
  // The best-move arrow comes from the primary (first enabled) engine.
  const best = useAnalysisStore((s) => selectPrimary(s).lines[0]?.pv[0]);
  const reviewing = useUiStore((s) => s.activeTab === 'review');
  const hasReview = useReviewStore((s) => s.summary !== undefined);
  const ply = useGameStore((s) => s.ply);
  // Only the details of the move that led to the displayed position (not of a stale game).
  const reviewed = useReviewStore((s) => {
    const d = s.moveDetails[ply];
    return d && d.fenAfter === gameFen ? d : undefined;
  });
  const drillArrows = useDrillArrows();
  const shapes = useMemo(
    () =>
      drillArrows.length > 0
        ? drillArrows
        : reviewing && hasReview
          ? reviewShapes({ previewing: previewFen !== null, move: reviewed })
          : analysisShapes({
              enabled,
              terminal: terminal !== null,
              previewing: previewFen !== null,
              inSync: analysisFen === gameFen,
              best,
              hover,
            }),
    [
      drillArrows,
      reviewing,
      hasReview,
      reviewed,
      enabled,
      terminal,
      previewFen,
      analysisFen,
      gameFen,
      best,
      hover,
    ],
  );
  const playMovable = usePlayMovableColor();
  const drillMovable = useDrillMovableColor();
  const movableColor = drillMovable !== undefined ? drillMovable : playMovable;
  return <Board shapes={shapes} previewFen={previewFen} movableColor={movableColor} />;
}

/**
 * The board between the two player bars: the bottom bar is the side the board is oriented for,
 * flipping swaps them. Only this column re-renders while a live clock ticks (`children` keep
 * their identity).
 */
function BoardColumn({ children }: { children: ReactNode }) {
  const players = useBoardPlayers();
  const bottom = players.orientation;
  const top = bottom === 'white' ? 'black' : 'white';
  return (
    <div className={styles.boardCol}>
      <PlayerBar side={top} player={players[top]} position="top" />
      <div className={styles.boardRow}>{children}</div>
      <PlayerBar side={bottom} player={players[bottom]} position="bottom" />
    </div>
  );
}

export function App() {
  const state = useGameStore();
  const tab = useUiStore((s) => s.activeTab);
  const setTab = useUiStore((s) => s.setActiveTab);
  const roomStatus = useRoomStatus();
  const alert = roomStatus === null && (gameStatus(state) === 'checkmate' || isCheck(state));
  // Loading a game starts a fast review (settings.autoReview) and opens the Review tab.
  useEffect(() => installAutoReview(), []);
  // Guided tour through the moves once a review is done (settings.reviewTour).
  useEffect(() => installReviewTour(), []);
  // `#/room/<id>` links open the Friend tab (on load and on hash changes).
  useEffect(() => installRoomRoute(), []);
  const tabsRef = useRef<HTMLDivElement>(null);
  // The tab row scrolls horizontally on narrow panels: keep the active tab visible (only the row
  // scrolls, never the page, unlike scrollIntoView).
  useEffect(() => revealTab(tabsRef.current, tab), [tab]);
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <h1 className={styles.title}>
          <img className={styles.logo} src="/brand/daisy.svg" alt="" width={28} height={28} />
          DaisyChess
        </h1>
        <div className={styles.headerActions}>
          <AccountChip />
          <ThemeToggle />
        </div>
      </header>
      <main className={styles.main}>
        <BoardColumn>
          <ConnectedEvalBar />
          <div className={styles.boardWrap}>
            <p id="board-note" className={styles.srOnly}>
              The board is operated with the mouse or touch. Keyboard users: step through the game
              with the arrow keys, use the move list, the FEN field or the Import tab.
            </p>
            <ConnectedBoard />
            <PreviewBanner />
            <PlayIndicator />
          </div>
        </BoardColumn>
        <section className={styles.side}>
          <EngineToggle />
          <p
            className={alert ? `${styles.status} ${styles.statusAlert}` : styles.status}
            data-testid="status"
            role="status"
            aria-live="polite"
          >
            {roomStatus ?? statusText(state)}
          </p>
          <Controls />
          <AnalysisPanel />
          <div ref={tabsRef} className={styles.tabs} role="tablist" aria-label="Game panels">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`tab-${t.id}`}
                aria-selected={tab === t.id}
                aria-controls="tabpanel-main"
                tabIndex={tab === t.id ? 0 : -1}
                className={tab === t.id ? styles.tabActive : styles.tab}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onTabKeyDown(e, tab, setTab)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div
            className={styles.content}
            role="tabpanel"
            id="tabpanel-main"
            aria-labelledby={`tab-${tab}`}
          >
            {tab === 'moves' && <MoveList />}
            {tab === 'import' && (
              <ImportPanel
                onLoaded={() => {
                  // The auto review may already have switched to the Review tab.
                  if (useUiStore.getState().activeTab === 'import') setTab('moves');
                }}
              />
            )}
            <Suspense fallback={<p className={styles.loading}>Loading…</p>}>
              {tab === 'play' && <PlayPanel />}
              {tab === 'openings' && <OpeningsPanel />}
              {tab === 'live' && <LivePanel />}
              {tab === 'friend' && <FriendPanel />}
              {tab === 'review' && <ReviewPanel />}
              {tab === 'explorer' && <ExplorerPanel />}
              {tab === 'settings' && <SettingsPanel />}
            </Suspense>
          </div>
        </section>
      </main>
    </div>
  );
}
