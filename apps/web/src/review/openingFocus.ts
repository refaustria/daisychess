import type { BookMove, BookOpening, Opening } from '../openings';
import type { MoveDetails } from './details';

/**
 * Opening focus of a reviewed game (M18-3): which opening was played, how long the game followed
 * the book, who left it with which move, what the book would have played instead and what the
 * deviation cost according to the review. Pure (the book and the position lookup are passed in).
 */

/** The subset of the book the focus needs (`Book` of `openings/book.ts`). */
export interface FocusBook {
  inBook(prefix: readonly string[]): boolean;
  bookMoves(prefix: readonly string[]): BookMove[];
  openingAt(prefix: readonly string[]): BookOpening | undefined;
}

export interface BookAlternative {
  san: string;
  /** Name of the variation this move leads to (if any). */
  name?: string;
}

export interface OpeningFocus {
  /** Deepest named opening of the in-book part (position based, so transpositions count). */
  openingName?: string;
  eco?: string;
  /** Last ply (1-based) that was still in book; 0 = the first move already left the book. */
  lastBookPly: number;
  /** Who played the first non-book move; null when the whole game stayed in book. */
  leftBy: 'white' | 'black' | null;
  /** Ply of the first non-book move (`lastBookPly + 1`), when the book was left. */
  leavePly?: number;
  /** The book continuations at the leave position (most popular first, at most 3). */
  bookMoveInstead?: BookAlternative[];
  /**
   * True when the book line had simply ended at the leave position (no book continuation), so
   * the "leave" move was the first move after the theory rather than a deviation from it.
   */
  endOfBook?: boolean;
  /**
   * Eval change of the leave move in pawns, White POV (after − before), from the review's move
   * details; undefined without details or with a mate score. Shown from the mover's POV.
   */
  evalSwingAtLeave?: number;
}

/** Book alternatives listed at most. */
export const MAX_ALTERNATIVES = 3;

export interface OpeningFocusInput {
  /** SAN moves of the game (from the standard start position). */
  sans: readonly string[];
  /** EPDs of every position, index = ply (0 = start); `epds.length === sans.length + 1`. */
  epds: readonly string[];
  book: FocusBook;
  /** Position lookup of the openings table (`findOpening` of `openings/index.ts`). */
  findOpening(positions: string[]): Opening | null;
  /** The review's per-move details (for the eval swing at the leave ply). */
  details?: MoveDetails;
}

/**
 * Walks the game along the book. A move is in book when the book line so far plus the move is a
 * prefix of some named line. A move that breaks the book order but reaches a named book position
 * (a transposition) is still in book: the walk continues from that variation's own line, so the
 * position, not the move order, decides here. The first move that is neither leaves the book.
 */
export function computeOpeningFocus(input: OpeningFocusInput): OpeningFocus {
  const { sans, epds, book, findOpening, details } = input;
  let prefix: readonly string[] = [];
  let lastBookPly = 0;
  let leavePly: number | undefined;
  for (let i = 0; i < sans.length; i++) {
    const next = [...prefix, sans[i]!];
    if (book.inBook(next)) {
      prefix = next;
      lastBookPly = i + 1;
      continue;
    }
    const epd = epds[i + 1];
    const named = epd !== undefined ? findOpening([epd]) : null;
    if (named && named.moves.length > 0 && book.inBook(named.moves)) {
      prefix = named.moves;
      lastBookPly = i + 1;
      continue;
    }
    leavePly = i + 1;
    break;
  }

  const named = lastBookPly > 0 ? findOpening(epds.slice(0, lastBookPly + 1)) : null;
  const byMoves = named ? undefined : book.openingAt(prefix);
  const opening = named ?? byMoves;
  const focus: OpeningFocus = {
    ...(opening ? { openingName: opening.name, eco: opening.eco } : {}),
    lastBookPly,
    leftBy: leavePly === undefined ? null : leavePly % 2 === 1 ? 'white' : 'black',
  };
  if (leavePly === undefined) return focus;
  focus.leavePly = leavePly;
  const alternatives = book
    .bookMoves(prefix)
    .slice(0, MAX_ALTERNATIVES)
    .map((m): BookAlternative => {
      const name = m.opening?.name ?? m.names[0];
      return name ? { san: m.san, name } : { san: m.san };
    });
  if (alternatives.length > 0) focus.bookMoveInstead = alternatives;
  else focus.endOfBook = true;
  const d = details?.[leavePly];
  if (d && 'cp' in d.evalBeforeWhite && 'cp' in d.evalAfterWhite) {
    focus.evalSwingAtLeave = (d.evalAfterWhite.cp - d.evalBeforeWhite.cp) / 100;
  }
  return focus;
}

const MINUS = '−';

/** `5. Nf3` / `5... Nf6` for the move at `ply` (1-based, standard start). */
export function plyLabel(ply: number, san: string): string {
  const n = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${n}. ${san}` : `${n}... ${san}`;
}

/** The part of a variation name after the family when it shares `family`, else the whole name. */
export function shortName(name: string, family?: string): string {
  const fam = family?.split(':')[0]?.trim();
  const i = name.indexOf(':');
  if (fam && i > 0 && name.slice(0, i).trim() === fam) return name.slice(i + 1).trim();
  return name;
}

/** `d3 (Giuoco Pianissimo), c3 (Giuoco Piano)`. */
export function alternativesText(alts: readonly BookAlternative[], family?: string): string {
  return alts.map((a) => (a.name ? `${a.san} (${shortName(a.name, family)})` : a.san)).join(', ');
}

/** The eval swing from the mover's point of view, one decimal: `−0.4`, `+1.2`, `0.0`. */
export function moverSwingText(swingWhite: number, mover: 'white' | 'black'): string {
  const v = mover === 'white' ? swingWhite : -swingWhite;
  const s = Math.abs(v).toFixed(1);
  if (s === '0.0') return '0.0';
  return `${v > 0 ? '+' : MINUS}${s}`;
}
