import { Chess } from 'chess.js';
import type { FamilyText } from '../openings/familyTexts';
import { alternativesText, moverSwingText, plyLabel, type OpeningFocus } from './openingFocus';

/**
 * Content of the opening stop of the guided review (M31-4, ADR-024 section 3). Pure.
 * The tour's `TourCard` (`review/tour.ts`) is the union of this card and the mistake card.
 */
export interface OpeningCard {
  kind: 'opening';
  /** `Opening: Italian Game (C50)` */
  title: string;
  /** The hand-written family text, when there is one (never a placeholder). */
  familyText?: string;
  /** The automatic sentences from the opening focus. */
  sentences: string[];
  /** "Show book move": the position where the book ended and the first book alternative. */
  preview?: { fen: string; sans: string[] };
}

const sideName = (s: 'white' | 'black'): string => (s === 'white' ? 'White' : 'Black');

function openingTitle(focus: OpeningFocus): string {
  const { openingName: name, eco } = focus;
  if (name && eco) return `Opening: ${name} (${eco})`;
  if (name) return `Opening: ${name}`;
  if (eco) return `Opening (${eco})`;
  return 'Opening';
}

/** `a, b, c` to `a, b or c`. */
function orList(items: string): string {
  const parts = items.split(', ');
  if (parts.length < 2) return items;
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/** FEN after the first `ply` moves of `sans`, or undefined when a move is illegal. */
function fenAfter(sans: readonly string[], ply: number): string | undefined {
  const chess = new Chess();
  try {
    for (let i = 0; i < ply; i++) chess.move(sans[i]!);
  } catch {
    return undefined;
  }
  return chess.fen();
}

/**
 * @param focus opening focus of the game
 * @param moves SAN moves of the game from the standard start position
 * @param family hand-written text of the opening's family, if one matched
 */
export function openingStopCard(
  focus: OpeningFocus,
  moves: readonly string[],
  family?: Pick<FamilyText, 'text'>,
): OpeningCard {
  const sentences: string[] = [];
  const last = focus.lastBookPly;
  const lastSan = last > 0 ? moves[last - 1] : undefined;
  if (lastSan) {
    sentences.push(
      `Book until move ${Math.ceil(last / 2)} (${last % 2 === 1 ? lastSan : `…${lastSan}`}).`,
    );
  }
  const card: OpeningCard = {
    kind: 'opening',
    title: openingTitle(focus),
    sentences,
    ...(family ? { familyText: family.text } : {}),
  };

  const leavePly = focus.leavePly;
  if (focus.leftBy === null || leavePly === undefined) {
    sentences.push('The whole game stayed in book.');
    return card;
  }
  const mover = sideName(focus.leftBy);
  const played = moves[leavePly - 1];
  const label = played ? plyLabel(leavePly, played) : undefined;
  const alternatives = focus.bookMoveInstead;
  if (alternatives && alternatives.length > 0) {
    const alts = orList(alternativesText(alternatives, focus.openingName));
    let s = `${mover} left the book${label ? ` with ${label}` : ''}; the book plays ${alts}.`;
    const swing = focus.evalSwingAtLeave;
    if (swing !== undefined) {
      const v = focus.leftBy === 'white' ? swing : -swing;
      if (Math.abs(v) >= 0.1) {
        const amount = moverSwingText(swing, focus.leftBy).replace(/^[+−]/, '');
        s += ` The deviation ${v < 0 ? 'cost' : 'gained'} ${amount}.`;
      }
    }
    sentences.push(s);
    const fen = fenAfter(moves, last);
    if (fen) card.preview = { fen, sans: [alternatives[0]!.san] };
  } else {
    sentences.push(`The book line ends here; ${mover} continued with ${label ?? 'a new move'}.`);
  }
  return card;
}
