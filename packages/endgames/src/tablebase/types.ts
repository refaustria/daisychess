/**
 * Tablebase types (ADR-025 §3). One shape for both sources: the lichess API (normalised by
 * `normalizeLichess`) and the local Syzygy reader (M32-2).
 */

/**
 * Exact result of a position for the side to move. Lichess's `unknown` and `maybe-*` answers
 * never become a `TbPosition`; its `syzygy-win`/`syzygy-loss` are folded into `win`/`loss` by
 * the normalisation, so consumers only see these five.
 * `cursed-win`/`blessed-loss`: a win/loss that the 50-move rule turns into a draw.
 */
export type TbCategory = 'win' | 'cursed-win' | 'draw' | 'blessed-loss' | 'loss';

export const TB_CATEGORIES: readonly TbCategory[] = [
  'win',
  'cursed-win',
  'draw',
  'blessed-loss',
  'loss',
];

/** Result for one side under the 50-move rule. */
export type MoverResult = 'win' | 'draw' | 'loss';

export interface TbMove {
  /** UCI, promotions with the piece letter (`b7b8q`). */
  uci: string;
  san: string;
  /** From the point of view of the side to move **after** the move. */
  category: TbCategory;
  /** Signed like lichess: from the point of view of the side to move after the move. */
  dtz?: number;
  dtm?: number;
  /** Capture or pawn move (resets the 50-move counter). */
  zeroing: boolean;
  checkmate: boolean;
  stalemate: boolean;
}

export interface TbPosition {
  fen: string;
  /** From the point of view of the side to move. */
  category: TbCategory;
  /** Distance to zeroing in plies (signed, side to move). Absent when unknown. */
  dtz?: number;
  /** Distance to mate in plies (signed, side to move). The lichess API has it for ≤ 5 pieces. */
  dtm?: number;
  /** Legal moves; the order carries no meaning (use `rankMoves`). */
  moves: TbMove[];
}

/** Judgment of one move (ADR-025 §3). */
export interface TbVerdict {
  /** The judged move (canonical UCI from the position) and its SAN. */
  uci: string;
  san: string;
  /** The mover's result before and after the move (50-move rule folded). */
  before: MoverResult;
  after: MoverResult;
  /**
   * `thrown`: the result got worse; `only`: kept, and exactly one legal move keeps it;
   * `kept`: kept with alternatives.
   */
  kind: 'kept' | 'only' | 'thrown';
  /** UCI of the moves that keep `before`, best first (`rankMoves` order). */
  keepers: string[];
  dtmBefore?: number;
  dtzBefore?: number;
}

/** What the eval bar and the cards display (no engine `Score` is invented). */
export interface TbScoreHint {
  result: 'white' | 'draw' | 'black';
  /** Signed plies from the side to move, as in `TbPosition`. */
  dtm?: number;
  dtz?: number;
  /** Mate in N moves for the winning side (from `dtm`), when known and not a draw. */
  mateIn?: number;
  /** False for `cursed-win`/`blessed-loss`: the result is a draw only by the 50-move rule. */
  exact50: boolean;
}

/** A tablebase source (lichess client, local Worker, cache layer). */
export interface TablebaseProbe {
  /** `null` when the position is not available from this source. */
  probe(fen: string): Promise<TbPosition | null>;
}
