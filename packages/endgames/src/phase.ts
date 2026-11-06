/**
 * The endgame-start rule (ADR-025 §5): lichess's division — the endgame begins once the
 * non-pawn, non-king pieces of both sides together number at most 6 and never exceed 6 again.
 */

/** Maximum number of non-pawn, non-king pieces (both sides) in an endgame. */
export const ENDGAME_MAX_PIECES = 6;
/** Minimum number of game plies inside the endgame for it to count. */
export const ENDGAME_MIN_PLIES = 4;

/** Number of queens, rooks, bishops and knights of both sides in a FEN. */
export function nonPawnPieces(fen: string): number {
  const placement = fen.trim().split(/\s+/)[0] ?? '';
  let n = 0;
  for (const ch of placement) if ('qrbnQRBN'.includes(ch)) n++;
  return n;
}

/**
 * First ply of the endgame, or undefined. `fens[i]` is the position **after** ply `i + 1`
 * (the review's `moveDetails[ply].fenAfter`, plies 1-based); the result is that 1-based ply.
 * The rule is applied from the end of the game: the endgame starts after the last position with
 * more than 6 pieces, so a promotion that pushes the count above 6 moves the start behind it.
 * Undefined when the final position is not an endgame or fewer than 4 plies are in it.
 */
export function endgameStart(fens: readonly string[]): number | undefined {
  let start = 0; // index into fens
  for (let i = fens.length - 1; i >= 0; i--) {
    if (nonPawnPieces(fens[i]!) > ENDGAME_MAX_PIECES) {
      start = i + 1;
      break;
    }
  }
  if (fens.length - start < ENDGAME_MIN_PLIES) return undefined;
  return start + 1;
}
