import { Chess } from 'chess.js';
import { currentFen, type GameState } from '../store/gameStore';

export type GameResult = '1-0' | '0-1' | '½-½';
export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient_material'
  | 'fifty_moves'
  | 'threefold_repetition'
  | 'resign'
  | 'engine_error';

export interface Outcome {
  result?: GameResult;
  reason: EndReason;
}

/** The game with the view moved to its last move (the "tip"). */
export function atTip<T extends Pick<GameState, 'startFen' | 'moves' | 'ply'>>(s: T): T {
  return s.ply === s.moves.length ? s : { ...s, ply: s.moves.length };
}

/** Position key for repetition detection: placement, side to move, castling, en passant. */
const positionKey = (fen: string): string => fen.split(' ').slice(0, 4).join(' ');

/**
 * Over-the-board outcome at the tip of the game, or null while the game goes on.
 * Repetitions are counted over the whole move list (chess.js only sees one FEN).
 */
export function gameOutcome(s: Pick<GameState, 'startFen' | 'moves' | 'ply'>): Outcome | null {
  const tip = atTip(s);
  const fen = currentFen(tip);
  const chess = new Chess(fen);
  if (chess.isCheckmate())
    return { result: chess.turn() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  if (chess.isStalemate()) return { result: '½-½', reason: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { result: '½-½', reason: 'insufficient_material' };
  if (chess.isDrawByFiftyMoves()) return { result: '½-½', reason: 'fifty_moves' };
  const key = positionKey(fen);
  let seen = positionKey(tip.startFen) === key ? 1 : 0;
  for (const m of tip.moves) if (positionKey(m.fen) === key) seen++;
  if (seen >= 3) return { result: '½-½', reason: 'threefold_repetition' };
  return null;
}

export const REASON_TEXT: Record<EndReason, string> = {
  checkmate: 'Checkmate',
  stalemate: 'Stalemate',
  insufficient_material: 'Insufficient material',
  fifty_moves: 'Fifty-move rule',
  threefold_repetition: 'Threefold repetition',
  resign: 'Resignation',
  engine_error: 'Engine error',
};
