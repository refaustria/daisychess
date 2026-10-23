export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q';
export type Colour = 'white' | 'black';

/**
 * Material values for the advantage number. The usual queen value is 9; the owner asked for 7.
 */
export const PIECE_VALUES: Readonly<Record<PieceType, number>> = { p: 1, n: 3, b: 3, r: 5, q: 7 };

/** Display order of captured pieces: queen first. */
export const PIECE_ORDER: readonly PieceType[] = ['q', 'r', 'b', 'n', 'p'];

export const PIECE_ROLE: Readonly<Record<PieceType, string>> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
};

export type Counts = Record<PieceType, number>;

export interface Material {
  /** Pieces each colour has lost (start count minus current count, never negative). */
  lost: Record<Colour, Counts>;
  /** Value of white's pieces on the board minus black's; positive = white is ahead. */
  advantage: number;
}

const empty = (): Counts => ({ p: 0, n: 0, b: 0, r: 0, q: 0 });

function count(fen: string): Record<Colour, Counts> {
  const out = { white: empty(), black: empty() };
  for (const ch of fen.split(' ')[0] ?? '') {
    const lower = ch.toLowerCase();
    if (lower === ch.toUpperCase() || !(lower in PIECE_VALUES)) continue;
    out[ch === lower ? 'black' : 'white'][lower as PieceType] += 1;
  }
  return out;
}

const value = (c: Counts): number =>
  PIECE_ORDER.reduce((sum, t) => sum + c[t] * PIECE_VALUES[t], 0);

export function material(startFen: string, currentFen: string): Material {
  const start = count(startFen);
  const now = count(currentFen);
  const lost = { white: empty(), black: empty() };
  for (const colour of ['white', 'black'] as const) {
    for (const t of PIECE_ORDER) lost[colour][t] = Math.max(0, start[colour][t] - now[colour][t]);
  }
  return { lost, advantage: value(now.white) - value(now.black) };
}
