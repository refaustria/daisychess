/**
 * Phone portrait chrome (M29-6): the bottom tab bar with its "More" sheet and the header's "⋯"
 * options menu (copy FEN/PGN, new game, flip, undo, engine). Both layers close with Escape, a tap
 * outside and the Android back button ({@link useBackHandler}).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useBackHandler } from '../../platform/backButton';
import { annotatePgn } from '../../review/annotatePgn';
import { currentFen, useGameStore } from '../../store/gameStore';
import { useUiStore, type TabId } from '../../store/uiStore';
import { EngineToggle } from '../EngineToggle/EngineToggle';
import styles from './PhoneLayout.module.css';

type Icon = 'board' | 'play' | 'puzzle' | 'review' | 'book' | 'more';

export const PRIMARY_TABS: { id: TabId; label: string; icon: Icon }[] = [
  { id: 'moves', label: 'Analysis', icon: 'board' },
  { id: 'play', label: 'Play', icon: 'play' },
  { id: 'puzzles', label: 'Puzzles', icon: 'puzzle' },
  { id: 'review', label: 'Review', icon: 'review' },
  { id: 'openings', label: 'Openings', icon: 'book' },
];

export const MORE_TABS: { id: TabId; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'friend', label: 'Friend' },
  { id: 'import', label: 'Import' },
  { id: 'explorer', label: 'Explorer' },
  { id: 'settings', label: 'Settings' },
];

/** Id of the element that labels the tab panel on phones (a tab, or the More button). */
export function phoneTabLabelId(tab: TabId): string {
  return PRIMARY_TABS.some((t) => t.id === tab) ? `tab-${tab}` : 'tab-more';
}

const PATHS: Record<Icon, ReactNode> = {
  board: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M4 12h16M12 4v16" />
    </>
  ),
  play: <path d="M8 5v14l11-7z" />,
  puzzle: (
    <path d="M10 4a2 2 0 1 1 4 0v2h4v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4h2a2 2 0 1 0 0-4H6V6h4z" />
  ),
  review: <path d="M4 19V5M4 19h16M8 15l4-5 3 3 5-7" />,
  book: <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 21V5M19 19v2H6" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </>
  ),
};

function TabIcon({ icon }: { icon: Icon }) {
  return (
    <svg
      className={styles.tabIcon}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[icon]}
    </svg>
  );
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select, [href], [tabindex="0"]';

/**
 * Focus handling of a small modal layer: focus moves into it, Tab cycles inside, Escape and the
 * back button close it, focus returns to the opener.
 */
function useLayer(
  open: boolean,
  close: () => void,
  panel: RefObject<HTMLElement | null>,
  opener: RefObject<HTMLElement | null>,
) {
  useBackHandler(open, close);
  useEffect(() => {
    if (!open) return;
    const back = opener.current;
    const el = panel.current;
    el?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      // Back to the opener unless focus has moved elsewhere on purpose.
      const active = document.activeElement;
      if (back && (!active || active === document.body || el?.contains(active))) back.focus();
    };
  }, [open, panel, opener]);
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}

/** WAI-ARIA tabs on the five primary tabs: arrows/Home/End move and activate, roving tabindex. */
function onTabKeyDown(e: KeyboardEvent<HTMLElement>, tab: TabId, setTab: (t: TabId) => void) {
  const n = PRIMARY_TABS.length;
  const i = PRIMARY_TABS.findIndex((t) => t.id === tab);
  let next: number;
  switch (e.key) {
    case 'ArrowRight':
      next = (i + 1) % n;
      break;
    case 'ArrowLeft':
      next = i < 0 ? n - 1 : (i - 1 + n) % n;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = n - 1;
      break;
    default:
      return;
  }
  e.preventDefault();
  const id = PRIMARY_TABS[next]!.id;
  setTab(id);
  document.getElementById(`tab-${id}`)?.focus();
}

function MoreSheet({
  close,
  opener,
}: {
  close: () => void;
  opener: RefObject<HTMLButtonElement | null>;
}) {
  const tab = useUiStore((s) => s.activeTab);
  const setTab = useUiStore((s) => s.setActiveTab);
  const panel = useRef<HTMLDivElement>(null);
  const onKeyDown = useLayer(true, close, panel, opener);
  return (
    <div
      className={`${styles.scrim} ${styles.scrimAbove}`}
      onClick={close}
      data-testid="more-scrim"
    >
      <div
        ref={panel}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby="more-sheet-title"
        data-testid="more-sheet"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <h2 id="more-sheet-title" className={styles.sheetTitle}>
          More
        </h2>
        <ul className={styles.sheetList}>
          {MORE_TABS.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={tab === t.id ? styles.sheetItemActive : styles.sheetItem}
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => {
                  setTab(t.id);
                  close();
                }}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Bottom tab bar: five primary tabs (a tablist) and "More" (a sheet with the other panels). */
export function BottomTabs() {
  const tab = useUiStore((s) => s.activeTab);
  const setTab = useUiStore((s) => s.setActiveTab);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const moreRef = useRef<HTMLButtonElement>(null);
  // A tab chosen in the bar (or by a panel) closes the sheet.
  useEffect(() => setOpen(false), [tab]);
  const secondary = MORE_TABS.find((t) => t.id === tab);
  // Roving tabindex: with a "More" panel active, the first tab takes the tab stop.
  const focusable = secondary ? PRIMARY_TABS[0]!.id : tab;
  return (
    <nav className={styles.tabBar} aria-label="Panels" data-testid="bottom-tabs">
      <div className={styles.tabList} role="tablist" aria-label="Game panels">
        {PRIMARY_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="tabpanel-main"
            tabIndex={focusable === t.id ? 0 : -1}
            className={tab === t.id ? styles.tabActive : styles.tab}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKeyDown(e, tab, setTab)}
          >
            <TabIcon icon={t.icon} />
            <span className={styles.tabLabel}>{t.label}</span>
          </button>
        ))}
      </div>
      <button
        ref={moreRef}
        type="button"
        id="tab-more"
        className={secondary ? styles.tabActive : styles.tab}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={secondary ? `More, ${secondary.label} open` : 'More'}
        onClick={() => setOpen((o) => !o)}
      >
        <TabIcon icon="more" />
        <span className={styles.tabLabel}>{secondary ? secondary.label : 'More'}</span>
      </button>
      {open && <MoreSheet close={close} opener={moreRef} />}
    </nav>
  );
}

/** Copies `text`; true on success (no clipboard: false). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** PGN of the current game (headers, start position, moves with imported clock times). */
export function currentPgn(): string {
  const g = useGameStore.getState();
  return annotatePgn(g.headers, g.startFen, g.moves);
}

function OptionsMenu({
  close,
  opener,
}: {
  close: () => void;
  opener: RefObject<HTMLButtonElement | null>;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const onKeyDown = useLayer(true, close, panel, opener);
  const ply = useGameStore((s) => s.ply);
  const [copied, setCopied] = useState<'fen' | 'pgn' | 'failed' | null>(null);
  useEffect(() => {
    if (copied === null) return;
    const t = setTimeout(() => setCopied(null), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async (what: 'fen' | 'pgn') => {
    const g = useGameStore.getState();
    const ok = await copyText(what === 'fen' ? currentFen(g) : currentPgn());
    setCopied(ok ? what : 'failed');
  };
  const act = (fn: () => void) => () => {
    fn();
    close();
  };
  const g = useGameStore.getState();
  return (
    <div className={styles.scrim} onClick={close} data-testid="options-scrim">
      <div
        ref={panel}
        className={styles.menu}
        role="dialog"
        aria-modal="true"
        aria-label="Options"
        data-testid="options-menu"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className={styles.menuGroup}>
          <button type="button" className={styles.menuItem} onClick={() => void copy('fen')}>
            {copied === 'fen' ? 'FEN copied' : 'Copy FEN'}
          </button>
          <button type="button" className={styles.menuItem} onClick={() => void copy('pgn')}>
            {copied === 'pgn' ? 'PGN copied' : 'Copy PGN'}
          </button>
          {copied === 'failed' && (
            <p className={styles.menuNote} role="status">
              Copying is not available here.
            </p>
          )}
        </div>
        <div className={styles.menuGroup}>
          <button type="button" className={styles.menuItem} onClick={act(g.reset)}>
            New game
          </button>
          <button type="button" className={styles.menuItem} onClick={act(g.flip)}>
            Flip board
          </button>
          <button
            type="button"
            className={styles.menuItem}
            disabled={ply === 0}
            onClick={act(g.undo)}
          >
            Undo
          </button>
        </div>
        <div className={styles.menuEngine}>
          <EngineToggle />
        </div>
      </div>
    </div>
  );
}

/** Header "⋯" button with the options menu. */
export function OptionsButton() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={styles.optionsBtn}
        aria-label="Options"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Options"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="12" cy="12" r="2" />
          <circle cx="19" cy="12" r="2" />
        </svg>
      </button>
      {open && <OptionsMenu close={close} opener={ref} />}
    </>
  );
}
