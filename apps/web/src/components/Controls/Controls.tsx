import { useEffect, useState } from 'react';
import { currentFen, useGameStore } from '../../store/gameStore';
import styles from './Controls.module.css';

/**
 * Arrow keys / Home / End step through the game (window-wide). Installed by the App on every
 * layout (the phone layout has no Controls block, M29-6).
 */
export function useBoardKeys(): void {
  const first = useGameStore((s) => s.first);
  const prev = useGameStore((s) => s.prev);
  const next = useGameStore((s) => s.next);
  const last = useGameStore((s) => s.last);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Widgets that own the arrow keys (tabs, selects, inputs) call preventDefault or are skipped.
      if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable ||
          t.getAttribute('role') === 'tab' ||
          t.getAttribute('role') === 'radio')
      )
        return;
      if (e.key === 'ArrowLeft') prev();
      else if (e.key === 'ArrowRight') next();
      else if (e.key === 'Home') first();
      else if (e.key === 'End') last();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [first, prev, next, last]);
}

export function Controls() {
  const store = useGameStore();
  const fen = currentFen(store);
  const [copied, setCopied] = useState(false);
  const { first, prev, next, last } = store;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(fen);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable; the FEN field stays selectable */
    }
  };

  return (
    <div className={styles.controls}>
      <div className={styles.row}>
        <button onClick={store.reset}>New game</button>
        <button onClick={store.flip}>Flip</button>
        <button onClick={store.undo} disabled={store.ply === 0}>
          Undo
        </button>
      </div>
      <div className={styles.row}>
        <button aria-label="First move" onClick={first} disabled={store.ply === 0}>
          ⏮
        </button>
        <button aria-label="Previous move" onClick={prev} disabled={store.ply === 0}>
          ◀
        </button>
        <button aria-label="Next move" onClick={next} disabled={store.ply >= store.moves.length}>
          ▶
        </button>
        <button aria-label="Last move" onClick={last} disabled={store.ply >= store.moves.length}>
          ⏭
        </button>
      </div>
      <div className={styles.row}>
        <input
          className={styles.fen}
          readOnly
          value={fen}
          aria-label="FEN"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}
