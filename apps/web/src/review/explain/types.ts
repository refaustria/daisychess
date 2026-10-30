import type { MoveDetail } from '../details';

/** Which rule produced an explanation (ADR-024 §4), in priority order. */
export type ExplainRule =
  | 'mate_allowed'
  | 'mate_missed'
  | 'piece_hangs'
  | 'fork_allowed'
  | 'material_lost'
  | 'missed_capture'
  | 'missed_tactic'
  | 'eval_drop';

export const EXPLAIN_RULES: readonly ExplainRule[] = [
  'mate_allowed',
  'mate_missed',
  'piece_hangs',
  'fork_allowed',
  'material_lost',
  'missed_capture',
  'missed_tactic',
  'eval_drop',
];

/** The opponent's best answer from `detail.fenAfter`: `details[ply + 1]` of the same review. */
export type ExplainReply = Pick<
  MoveDetail,
  'bestUci' | 'bestLine' | 'bestLineMoves' | 'evalBeforeWhite'
>;

export interface ExplainInput {
  /** The mistake (fenBefore/fenAfter, playedUci, bestUci, bestLine, evals, classification). */
  detail: MoveDetail;
  /** `details[ply + 1]`: the punishment line. Missing on the last move of a game. */
  reply?: ExplainReply;
  /** M22 time-trouble flag of the move. */
  timeTrouble?: boolean;
}

export type ArrowBrush = 'green' | 'red' | 'yellow';

export interface ExplainArrow {
  /** UCI move; a square repeated (`e5e5`) is a circle. */
  uci: string;
  brush: ArrowBrush;
}

export interface ExplainLine {
  /** Position the line starts from. */
  fen: string;
  /** SAN moves of the line (all legal from `fen`). */
  sans: string[];
  /** `Best line` | `What happens after Nxe5`. */
  label: string;
}

export interface Explanation {
  rule: ExplainRule;
  /** `12. Nxe5?? Blunder (−41%)`, plus ` (in time trouble)`. */
  headline: string;
  /** 1–3 sentences, ≤ 280 characters together. */
  sentences: string[];
  /** Steppable line: the punishment line for mate_allowed/piece_hangs/fork_allowed/material_lost, else the best line. */
  line?: ExplainLine;
  arrows: ExplainArrow[];
}
