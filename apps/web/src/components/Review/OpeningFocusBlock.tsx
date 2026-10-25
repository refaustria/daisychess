import type { ReactNode } from 'react';
import type { OpeningFocus } from '../../review/openingFocus';
import { alternativesText, moverSwingText, plyLabel } from '../../review/openingFocus';
import { useOpeningFocus } from '../../review/useOpeningFocus';
import { useGameStore } from '../../store/gameStore';
import styles from './ReviewPanel.module.css';

const sideName = (c: 'white' | 'black'): string => (c === 'white' ? 'White' : 'Black');

/** `move 5 (…Nf6)` / `move 5 (Nf3)` for the last book ply. */
function untilText(ply: number, san: string): string {
  const n = Math.ceil(ply / 2);
  return `move ${n} (${ply % 2 === 0 ? '…' : ''}${san})`;
}

/**
 * "Opening" block of the review: "Italian Game (C50) · book until move 5 (…Nf6) · White left the
 * book with 6. Nc3 (book: d3 (Giuoco Pianissimo), c3 (Giuoco Piano)) · eval −0.4 for White".
 * The leave move jumps to its ply.
 */
export function OpeningFocusView({ focus }: { focus: OpeningFocus }) {
  const moves = useGameStore((s) => s.moves);
  const goTo = useGameStore((s) => s.goTo);
  const parts: ReactNode[] = [];
  const name = focus.openingName ? (
    <strong key="name" data-testid="opening-focus-name">
      {focus.openingName}
      {focus.eco ? ` (${focus.eco})` : ''}
    </strong>
  ) : null;
  if (name) parts.push(name);
  if (focus.lastBookPly === 0) parts.push('No book moves');
  else {
    const san = moves[focus.lastBookPly - 1]?.san ?? '';
    parts.push(`book until ${untilText(focus.lastBookPly, san)}`);
  }
  const leave = focus.leavePly !== undefined ? moves[focus.leavePly - 1] : undefined;
  if (focus.leftBy && focus.leavePly !== undefined && leave) {
    const ply = focus.leavePly;
    const who = sideName(focus.leftBy);
    const button = (
      <button
        type="button"
        className={styles.linkBtn}
        data-testid="opening-focus-leave"
        title="Show this move on the board"
        onClick={() => goTo(ply)}
      >
        {plyLabel(ply, leave.san)}
      </button>
    );
    parts.push(
      focus.endOfBook ? (
        <span key="leave">
          the book line ends; {who} continued with {button}
        </span>
      ) : (
        <span key="leave">
          {who} left the book with {button}
          {focus.bookMoveInstead && (
            <> (book: {alternativesText(focus.bookMoveInstead, focus.openingName)})</>
          )}
        </span>
      ),
    );
    if (focus.evalSwingAtLeave !== undefined) {
      parts.push(
        <span key="eval" title={`Eval change of ${plyLabel(ply, leave.san)} for ${who}`}>
          eval {moverSwingText(focus.evalSwingAtLeave, focus.leftBy)} for {who}
        </span>,
      );
    }
  } else if (focus.lastBookPly > 0) {
    parts.push('the whole game stayed in book');
  }
  return (
    <section className={styles.opening} aria-label="Opening" data-testid="opening-focus">
      <span className={styles.openingLabel}>Opening</span>
      <p>
        {parts.map((p, i) => (
          <span key={i}>
            {i > 0 && ' · '}
            {p}
          </span>
        ))}
      </p>
    </section>
  );
}

/** The opening block for the game on the board (nothing for custom positions or while loading). */
export function OpeningFocusBlock() {
  const focus = useOpeningFocus();
  return focus ? <OpeningFocusView focus={focus} /> : null;
}
