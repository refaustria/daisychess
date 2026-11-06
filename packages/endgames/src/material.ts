/**
 * Material signatures, Syzygy material keys and the endgame family classification
 * (ADR-025 §5). Everything works on the piece placement of a FEN only (field 1); the FEN is not
 * validated beyond that, so callers can pass any position string a board produced.
 */

export type Side = 'white' | 'black';

/** Piece letters of one side, kings excluded, counted from the FEN placement. */
export interface SideMaterial {
  q: number;
  r: number;
  b: number;
  n: number;
  p: number;
  /** Square colours of this side's bishops (`light` = a light square such as h1). */
  bishopColors: Array<'light' | 'dark'>;
}

export interface MaterialSignature {
  /** e.g. `R+3P`, `Q+R`, `K` for a bare king. */
  white: string;
  black: string;
  /** `R+3P vs R+2P` (White first). */
  text: string;
}

/**
 * The 21 endgame families of ADR-025 §5 plus `other`. Note: the ADR names 20 families while
 * counting 21; the 21st here is `rook_minor_v_rook` (rook and minor piece against a rook,
 * e.g. R+B vs R), the most frequent material class the listed names leave to `other`.
 */
export const ENDGAME_FAMILIES = [
  'basic_mate',
  'kp_v_k',
  'pawn',
  'rook',
  'double_rook',
  'rook_v_pawns',
  'rook_v_minor',
  'rook_minor',
  'rook_minor_v_rook',
  'queen',
  'queen_v_rook',
  'queen_v_pawns',
  'queen_v_minor',
  'queen_rook',
  'queen_v_pieces',
  'same_bishops',
  'opposite_bishops',
  'knight',
  'bishop_v_knight',
  'minor_v_pawns',
  'two_minors',
  'other',
] as const;

export type EndgameFamily = (typeof ENDGAME_FAMILIES)[number];

export interface EndgameClass {
  family: EndgameFamily;
  /** No pawns on the board. */
  pawnless: boolean;
  /** White's pawns minus Black's pawns (positive: White is pawns up). */
  pawnsUp: number;
}

/** Lichess puzzle themes of the endgame types (ADR-025 §7). */
export type EndgameTheme =
  | 'endgame'
  | 'pawnEndgame'
  | 'knightEndgame'
  | 'bishopEndgame'
  | 'rookEndgame'
  | 'queenEndgame'
  | 'queenRookEndgame';

/** Lesson groups of the trainer (ADR-025 §6). */
export const LESSON_GROUPS = ['basic_mates', 'king_pawn', 'queen_pawn', 'rook_pawn'] as const;
export type LessonGroup = (typeof LESSON_GROUPS)[number];

function placement(fen: string): string {
  return fen.trim().split(/\s+/)[0] ?? '';
}

function emptySide(): SideMaterial {
  return { q: 0, r: 0, b: 0, n: 0, p: 0, bishopColors: [] };
}

/** Counts the material of both sides from the FEN placement (kings excluded). */
export function sideMaterial(fen: string): { white: SideMaterial; black: SideMaterial } {
  const white = emptySide();
  const black = emptySide();
  const ranks = placement(fen).split('/');
  ranks.forEach((rank, i) => {
    const rankNo = 8 - i; // 8 … 1
    let file = 0; // 0 = a
    for (const ch of rank) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      const side = ch === ch.toUpperCase() ? white : black;
      switch (ch.toLowerCase()) {
        case 'q':
          side.q++;
          break;
        case 'r':
          side.r++;
          break;
        case 'b':
          side.b++;
          // a1 (file 0, rank 1) is dark: (file + rank) even ⇒ dark with rank 1-based.
          side.bishopColors.push((file + rankNo) % 2 === 0 ? 'light' : 'dark');
          break;
        case 'n':
          side.n++;
          break;
        case 'p':
          side.p++;
          break;
        default:
          break; // kings and junk
      }
      file++;
    }
  });
  return { white, black };
}

function sideText(m: SideMaterial): string {
  const parts: string[] = [
    ...Array<string>(m.q).fill('Q'),
    ...Array<string>(m.r).fill('R'),
    ...Array<string>(m.b).fill('B'),
    ...Array<string>(m.n).fill('N'),
  ];
  if (m.p === 1) parts.push('P');
  else if (m.p > 1) parts.push(`${m.p}P`);
  return parts.length === 0 ? 'K' : parts.join('+');
}

/**
 * Material of both sides as text: pieces in the order Q R B N, each piece listed once per
 * piece, then the pawn count (`P` for one, `3P` for three); `K` for a bare king. White first.
 */
export function materialSignature(fen: string): MaterialSignature {
  const { white, black } = sideMaterial(fen);
  const w = sideText(white);
  const b = sideText(black);
  return { white: w, black: b, text: `${w} vs ${b}` };
}

const PCHR = ['K', 'Q', 'R', 'B', 'N', 'P'];

function sideLetters(m: SideMaterial): string {
  return `K${'Q'.repeat(m.q)}${'R'.repeat(m.r)}${'B'.repeat(m.b)}${'N'.repeat(m.n)}${'P'.repeat(m.p)}`;
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return a.length < b.length;
}

/**
 * Normalises a Syzygy table name such as `KPvKR` to the canonical file name (`KRvKP`): the side
 * with more pieces first, on equal counts the stronger piece list first (python-chess's
 * `normalize_tablename`).
 */
export function normalizeMaterialKey(key: string): string {
  const [w = '', b = ''] = key.toUpperCase().split('V');
  const order = (s: string): string =>
    [...s].sort((x, y) => PCHR.indexOf(x) - PCHR.indexOf(y)).join('');
  const ws = order(w);
  const bs = order(b);
  const idx = (s: string): number[] => [...s].map((c) => PCHR.indexOf(c));
  const swap = ws.length !== bs.length ? ws.length < bs.length : lexLess(idx(bs), idx(ws));
  return swap ? `${bs}v${ws}` : `${ws}v${bs}`;
}

/** Syzygy material key of a position, e.g. `KRPvKR` (stronger side first; pieces Q R B N P). */
export function materialKey(fen: string): string {
  const { white, black } = sideMaterial(fen);
  return normalizeMaterialKey(`${sideLetters(white)}v${sideLetters(black)}`);
}

const pieces = (m: SideMaterial): number => m.q + m.r + m.b + m.n;
const minors = (m: SideMaterial): number => m.b + m.n;
const only = (m: SideMaterial, want: Partial<Record<'q' | 'r' | 'b' | 'n', number>>): boolean =>
  m.q === (want.q ?? 0) && m.r === (want.r ?? 0) && m.b === (want.b ?? 0) && m.n === (want.n ?? 0);

function classifyPieces(
  a: SideMaterial,
  b: SideMaterial,
  totalPawns: number,
): EndgameFamily | undefined {
  // Rules on an ordered pair (a = the side tested as "having" the material); called both ways.
  const bBare = pieces(b) === 0 && b.p === 0;
  if (
    bBare &&
    (only(a, { q: 1 }) || only(a, { r: 1 }) || only(a, { b: 2 }) || only(a, { b: 1, n: 1 }))
  )
    return 'basic_mate';
  if (only(a, { q: 1 }) && only(b, { q: 1 })) return 'queen';
  if (only(a, { q: 1, r: 1 }) && only(b, { q: 1, r: 1 })) return 'queen_rook';
  if (only(a, { q: 1 })) {
    if (only(b, { r: 1 })) return 'queen_v_rook';
    if (pieces(b) === 0 && b.p > 0) return 'queen_v_pawns';
    if (b.q === 0 && b.r === 0 && minors(b) === 1) return 'queen_v_minor';
    if (
      b.q === 0 &&
      ((b.r === 1 && minors(b) === 1) || (b.r === 0 && minors(b) === 2) || only(b, { r: 2 }))
    )
      return 'queen_v_pieces';
  }
  if (only(a, { r: 1 }) && only(b, { r: 1 })) return 'rook';
  if (only(a, { r: 2 }) && only(b, { r: 2 })) return 'double_rook';
  if (only(a, { r: 1 })) {
    if (pieces(b) === 0 && b.p > 0) return 'rook_v_pawns';
    if (b.q === 0 && b.r === 0 && minors(b) === 1) return 'rook_v_minor';
  }
  if (a.q === 0 && a.r === 1 && minors(a) === 1) {
    if (b.q === 0 && b.r === 1 && minors(b) === 1) return 'rook_minor';
    if (only(b, { r: 1 })) return 'rook_minor_v_rook';
  }
  if (only(a, { b: 1 }) && only(b, { b: 1 })) {
    return a.bishopColors[0] === b.bishopColors[0] ? 'same_bishops' : 'opposite_bishops';
  }
  if (only(a, { n: 1 }) && only(b, { n: 1 })) return 'knight';
  if (only(a, { b: 1 }) && only(b, { n: 1 })) return 'bishop_v_knight';
  if (a.q === 0 && a.r === 0 && minors(a) === 1 && pieces(b) === 0 && totalPawns > 0)
    return 'minor_v_pawns';
  if (
    a.q === 0 &&
    a.r === 0 &&
    minors(a) === 2 &&
    b.q === 0 &&
    b.r === 0 &&
    (minors(b) === 1 || minors(b) === 2)
  )
    return 'two_minors';
  return undefined;
}

/** Endgame family of a position (ADR-025 §5) with the pawn flags. */
export function endgameFamily(fen: string): EndgameClass {
  const { white, black } = sideMaterial(fen);
  const totalPawns = white.p + black.p;
  const flags = { pawnless: totalPawns === 0, pawnsUp: white.p - black.p };
  let family: EndgameFamily = 'other';
  if (pieces(white) === 0 && pieces(black) === 0) {
    family = totalPawns === 0 ? 'other' : totalPawns === 1 ? 'kp_v_k' : 'pawn';
  } else {
    family =
      classifyPieces(white, black, totalPawns) ??
      classifyPieces(black, white, totalPawns) ??
      'other';
  }
  return { family, ...flags };
}

/** Lichess puzzle theme of a family (ADR-025 §5); `endgame` when no specific theme fits. */
export function puzzleThemeFor(family: EndgameFamily): EndgameTheme {
  switch (family) {
    case 'rook':
    case 'double_rook':
    case 'rook_v_pawns':
    case 'rook_v_minor':
    case 'rook_minor':
    case 'rook_minor_v_rook':
      return 'rookEndgame';
    case 'pawn':
    case 'kp_v_k':
      return 'pawnEndgame';
    case 'queen':
    case 'queen_v_rook':
    case 'queen_v_pawns':
    case 'queen_v_minor':
    case 'queen_v_pieces':
      return 'queenEndgame';
    case 'queen_rook':
      return 'queenRookEndgame';
    case 'same_bishops':
    case 'opposite_bishops':
      return 'bishopEndgame';
    case 'knight':
      return 'knightEndgame';
    default:
      return 'endgame';
  }
}

/** Lesson group of the trainer that teaches a family, when one exists (ADR-025 §5/§6). */
export function lessonGroupFor(family: EndgameFamily): LessonGroup | undefined {
  switch (family) {
    case 'basic_mate':
      return 'basic_mates';
    case 'kp_v_k':
    case 'pawn':
      return 'king_pawn';
    case 'queen_v_pawns':
      return 'queen_pawn';
    case 'rook':
      return 'rook_pawn';
    default:
      return undefined;
  }
}

/** ADR-025 §5 spells it `lessonFamilyFor`; same function. */
export const lessonFamilyFor = lessonGroupFor;
