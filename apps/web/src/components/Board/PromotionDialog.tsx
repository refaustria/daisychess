import { useEffect, useRef } from 'react';
import type { Orientation } from '../../store/gameStore';
import { useBackHandler } from '../../platform/backButton';
import styles from './PromotionDialog.module.css';

export type PromotionPiece = 'q' | 'n' | 'r' | 'b';

/** Edge of the board first, like chessground/lichess. */
const PIECES: { piece: PromotionPiece; role: string; key: string }[] = [
  { piece: 'q', role: 'queen', key: 'Q' },
  { piece: 'n', role: 'knight', key: 'N' },
  { piece: 'r', role: 'rook', key: 'R' },
  { piece: 'b', role: 'bishop', key: 'B' },
];

const KEYS: Record<string, PromotionPiece> = { q: 'q', r: 'r', b: 'b', n: 'n' };

export interface PromotionDialogProps {
  /** Destination square, e.g. `e8`. */
  to: string;
  color: Orientation;
  orientation: Orientation;
  pieceSet: string;
  onSelect(piece: PromotionPiece): void;
  onCancel(): void;
}

/**
 * `<piece>` element styled by the active piece-set CSS (`.cg-wrap piece.queen.white`). Created
 * through the DOM because React warns about the unknown `piece` tag.
 */
function PieceIcon({ role, color }: { role: string; color: Orientation }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const el = document.createElement('piece');
    el.className = `${role} ${color}`;
    host.appendChild(el);
    return () => el.remove();
  }, [role, color]);
  return <span ref={ref} className={styles.icon} aria-hidden="true" />;
}

/**
 * In-board promotion chooser: four pieces stacked on the destination file from the promotion
 * rank inwards. Keyboard: Q/R/B/N choose, Escape (or a click outside) cancels.
 */
export function PromotionDialog({
  to,
  color,
  orientation,
  pieceSet,
  onSelect,
  onCancel,
}: PromotionDialogProps) {
  const first = useRef<HTMLButtonElement>(null);
  const file = to.charCodeAt(0) - 97;
  const rank = Number(to[1]);
  const col = orientation === 'white' ? file : 7 - file;
  const row = orientation === 'white' ? 8 - rank : rank - 1;
  const down = row === 0;

  // Android back button cancels the chooser (M26-4).
  useBackHandler(true, onCancel);

  useEffect(() => {
    first.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      const piece = KEYS[e.key.toLowerCase()];
      if (piece) {
        e.preventDefault();
        onSelect(piece);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelect, onCancel]);

  return (
    <div
      className={`cg-wrap piece-set-${pieceSet} ${styles.overlay}`}
      role="dialog"
      aria-modal="true"
      aria-label="Choose promotion piece"
      data-testid="promotion-dialog"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      {PIECES.map((p, i) => (
        <button
          key={p.piece}
          ref={i === 0 ? first : undefined}
          type="button"
          className={styles.choice}
          style={{
            left: `${col * 12.5}%`,
            top: `${(down ? row + i : row - i) * 12.5}%`,
          }}
          aria-label={`Promote to ${p.role} (${p.key})`}
          aria-keyshortcuts={p.key}
          data-piece={p.piece}
          onClick={() => onSelect(p.piece)}
        >
          <PieceIcon role={p.role} color={color} />
        </button>
      ))}
    </div>
  );
}
