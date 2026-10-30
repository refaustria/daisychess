import type { MoveClass, ReviewedMove, Score } from '@daisychess/engine-core';
import { Chess } from 'chess.js';
import { buildMoveDetail } from '../details';
import type { ExplainInput, ExplainRule } from './types';

/**
 * Test helpers of the explainer: hand-built review inputs whose positions and lines are checked
 * with chess.js (every line must be legal in full, or the builder throws). Evals and lines are
 * Stockfish 19 depth-18 output for these positions (White POV), cut to 8 plies.
 */

/** Replays a UCI line from `fen`; throws on the first illegal move. Returns the SAN moves. */
export function legalLine(fen: string, line: readonly string[]): string[] {
  const c = new Chess(fen);
  return line.map((uci) => {
    try {
      return c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      throw new Error(`illegal ${uci} in ${c.fen()} (line from ${fen})`);
    }
  });
}

export interface CaseSpec {
  name: string;
  fen: string;
  played: string;
  best: string[];
  evalBefore: Score;
  evalAfter: Score;
  reply: string[];
  classification?: MoveClass;
  winProbLoss?: number;
}

/** Ply of the move played in `fen` (1-based, from the move number and side to move). */
const plyOf = (fen: string): number => {
  const [, side, , , , num] = fen.split(' ');
  return (Number(num) - 1) * 2 + (side === 'b' ? 2 : 1);
};

/** The explainer input of a spec, built like the review does (`buildMoveDetail`). */
export function inputOf(spec: CaseSpec): ExplainInput {
  const [playedSan] = legalLine(spec.fen, [spec.played]);
  legalLine(spec.fen, spec.best);
  const chess = new Chess(spec.fen);
  chess.move({
    from: spec.played.slice(0, 2),
    to: spec.played.slice(2, 4),
    promotion: spec.played[4],
  });
  const fenAfter = chess.fen();
  const replySans = legalLine(fenAfter, spec.reply);
  const loss = spec.winProbLoss ?? 40;
  const move: ReviewedMove = {
    ply: plyOf(spec.fen),
    san: playedSan!,
    uci: spec.played,
    mover: spec.fen.split(' ')[1] === 'w' ? 'white' : 'black',
    evalBefore: spec.evalBefore,
    evalAfter: spec.evalAfter,
    ...(spec.best[0] ? { bestMove: spec.best[0] } : {}),
    winProbBefore: 50 + loss / 2,
    winProbAfter: 50 - loss / 2,
    winProbLoss: loss,
    classification: spec.classification ?? 'blunder',
  };
  const detail = buildMoveDetail(move, spec.fen, fenAfter, spec.best);
  return {
    detail,
    reply: {
      ...(spec.reply[0] ? { bestUci: spec.reply[0] } : {}),
      bestLine: [...spec.reply],
      bestLineMoves: replySans,
      evalBeforeWhite: spec.evalAfter,
    },
  };
}

/** One position per rule (and the priority cases); `fires` = every predicate that applies. */
export interface RuleCase extends CaseSpec {
  rule: ExplainRule;
  fires: ExplainRule[];
  sentences: string[];
}

export const RULE_CASES: RuleCase[] = [
  {
    name: 'mate_allowed: 3... Nf6?? allows Qxf7#',
    rule: 'mate_allowed',
    fires: ['mate_allowed'],
    fen: 'r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3',
    played: 'g8f6',
    best: ['g7g6', 'h5f3', 'g8f6', 'g1e2', 'f8g7', 'b1c3', 'e8g8', 'd2d3'],
    evalBefore: { cp: -23 },
    evalAfter: { mate: 1 },
    reply: ['h5f7'],
    sentences: ['Nf6 allows mate in 1: 4. Qxf7#.', 'Better was g6.'],
  },
  {
    name: 'mate_missed: h3 instead of the back-rank mate Re8#',
    rule: 'mate_missed',
    fires: ['mate_missed'],
    fen: '6k1/5ppp/8/n7/8/8/5PPP/4R1K1 w - - 0 1',
    played: 'h2h3',
    best: ['e1e8'],
    evalBefore: { mate: 1 },
    evalAfter: { cp: 442 },
    reply: ['g8f8', 'e1d1', 'f8e7', 'g2g4', 'a5b7', 'f2f4', 'b7c5', 'g1f2'],
    classification: 'mistake',
    winProbLoss: 15,
    sentences: ['h3 misses mate in 1: 1. Re8#.'],
  },
  {
    name: 'piece_hangs: 3. Nxe5?? dxe5',
    rule: 'piece_hangs',
    fires: ['piece_hangs', 'material_lost', 'missed_tactic'],
    fen: 'rnbqkbnr/ppp2ppp/3p4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3',
    played: 'f3e5',
    best: ['d2d4', 'g8f6', 'd4e5', 'f6e4', 'c1e3', 'd6e5', 'd1d8', 'e8d8'],
    evalBefore: { cp: 59 },
    evalAfter: { cp: -614 },
    reply: ['d6e5', 'f1b5', 'c7c6', 'b5c4', 'g8f6', 'd2d3', 'f8d6', 'e1g1'],
    sentences: ['Nxe5 hangs the knight on e5: dxe5 takes it.', 'Better was d4.'],
  },
  {
    name: 'piece_hangs: h3 leaves the attacked knight on e5',
    rule: 'piece_hangs',
    fires: ['piece_hangs', 'material_lost'],
    fen: 'r1bqkbnr/ppp2ppp/2np4/4N3/4P3/8/PPPP1PPP/RNBQKB1R w KQkq - 0 4',
    played: 'h2h3',
    best: ['e5c6', 'b7c6', 'd2d4', 'g8f6', 'b1c3', 'g7g6', 'c1e3', 'a8b8'],
    evalBefore: { cp: 220 },
    evalAfter: { cp: -595 },
    reply: ['d6e5', 'c2c3', 'd8f6', 'f1e2', 'a7a6', 'a2a4', 'f6g6', 'd2d4'],
    sentences: ['h3 does not save the knight on e5: dxe5 takes it.', 'Better was Nxc6.'],
  },
  {
    name: 'fork_allowed: ...Qg5?? Nc7+ forks king and rook',
    rule: 'fork_allowed',
    fires: ['fork_allowed', 'missed_tactic'],
    fen: 'r2qk2r/pp3ppp/8/1N6/8/7P/PPQ2PP1/5RK1 b kq - 0 1',
    played: 'd8g5',
    best: ['e8g8', 'b5c3', 'd8c7', 'c2b3', 'a8d8', 'c3d5', 'c7d7', 'f1d1'],
    evalBefore: { cp: -575 },
    evalAfter: { cp: 729 },
    reply: ['b5c7', 'e8e7', 'c2e4', 'e7d7', 'e4b7', 'h8b8', 'f1d1', 'd7e7'],
    sentences: ['Qg5 allows a fork: Nc7+ attacks the king and the rook.', 'Better was O-O.'],
  },
  {
    name: 'material_lost: ...Kd7?? Ra7+ skewers the queen',
    rule: 'material_lost',
    fires: ['material_lost', 'missed_tactic'],
    fen: '3k4/7q/5pp1/8/8/8/5PPP/R5K1 b - - 0 1',
    played: 'd8d7',
    best: ['h7d7', 'a1e1', 'd7d3', 'h2h3', 'f6f5', 'f2f3', 'd8d7', 'g1f2'],
    evalBefore: { cp: -287 },
    evalAfter: { cp: 706 },
    reply: ['a1a7', 'd7e6', 'a7h7', 'e6f5', 'h7e7', 'f5g5', 'e7e8', 'g5f5'],
    sentences: [
      'Kd7 loses material: after 2. Ra7+ Ke6 3. Rxh7 the queen is lost.',
      'Better was Qd7.',
    ],
  },
  {
    name: 'missed_capture: h3 instead of taking the free knight',
    rule: 'missed_capture',
    fires: ['missed_capture'],
    fen: '6k1/5pp1/7p/3n4/8/8/5PPP/3R2K1 w - - 0 1',
    played: 'h2h3',
    best: ['d1d5', 'g8f8', 'g1f1', 'f8e7', 'd5d4', 'e7f6', 'f1e2', 'f6g6'],
    evalBefore: { cp: 712 },
    evalAfter: { cp: 436 },
    reply: ['d5f4', 'd1d8', 'g8h7', 'd8d7', 'h7g8', 'g1h2', 'g7g6', 'h2g3'],
    classification: 'mistake',
    winProbLoss: 12,
    sentences: [
      'h3 misses Rxd5, which wins the knight.',
      'After h3 the position is +4.4 instead of +7.1.',
    ],
  },
  {
    name: 'missed_capture: a defended queen for a bishop',
    rule: 'missed_capture',
    fires: ['missed_capture'],
    fen: '4k3/8/4p3/3q4/2B5/1P6/8/4K3 w - - 0 1',
    played: 'e1e2',
    best: ['c4d5', 'e6d5', 'e1d2', 'e8d7', 'd2c3', 'd7c7', 'c3d4', 'c7d6'],
    evalBefore: { cp: 0 },
    evalAfter: { cp: -629 },
    reply: ['d5e4', 'e2d2', 'e6e5', 'c4d3', 'e4d5', 'd2e2', 'e8d7', 'b3b4'],
    sentences: [
      'Ke2 misses Bxd5, which wins the queen for the bishop.',
      'After Ke2 the position is −6.3 instead of 0.0.',
    ],
  },
  {
    name: 'missed_tactic: h3 instead of the fork Nc7+',
    rule: 'missed_tactic',
    fires: ['missed_tactic'],
    fen: 'r3k3/pp3ppp/8/1N6/8/8/PPP2PPP/6K1 w - - 0 1',
    played: 'h2h3',
    best: ['b5c7', 'e8d8', 'c7a8', 'd8c8', 'g2g3', 'c8b8', 'g1g2', 'b8a8'],
    evalBefore: { cp: 495 },
    evalAfter: { cp: -548 },
    reply: ['a8d8', 'g1f1', 'd8d2', 'b5a3', 'd2d1', 'f1e2', 'd1a1', 'e2d2'],
    sentences: [
      'h3 misses Nc7+: after 1. Nc7+ Kd8 2. Nxa8 Kc8 the position is +5.0.',
      'After h3 it is −5.5.',
    ],
  },
  {
    name: 'eval_drop: 2. a3?! (White)',
    rule: 'eval_drop',
    fires: [],
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',
    played: 'a2a3',
    best: ['g1f3', 'g8f6', 'd2d4', 'f6e4', 'f1d3', 'd7d5', 'f3e5', 'b8d7'],
    evalBefore: { cp: 33 },
    evalAfter: { cp: -3 },
    reply: ['g8f6', 'b1c3', 'b8c6', 'g1f3', 'd7d5', 'e4d5', 'f6d5', 'f1b5'],
    classification: 'inaccuracy',
    winProbLoss: 3,
    sentences: ['Better was Nf3, which keeps +0.3; after a3 it is 0.0.'],
  },
  {
    name: 'eval_drop: 2... h6?! (Black, signs from Black’s side)',
    rule: 'eval_drop',
    fires: [],
    fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/P7/1PPP1PPP/RNBQKBNR b KQkq - 0 2',
    played: 'h7h6',
    best: ['g8f6', 'b1c3', 'b8c6', 'g1f3', 'd7d5', 'e4d5', 'f6d5', 'f1b5'],
    evalBefore: { cp: -3 },
    evalAfter: { cp: 52 },
    reply: ['g1f3', 'b8c6', 'b1c3', 'g8f6', 'd2d4', 'e5d4', 'f3d4', 'f8c5'],
    classification: 'inaccuracy',
    winProbLoss: 6,
    sentences: ['Better was Nf6, which keeps 0.0; after h6 it is −0.5.'],
  },
  {
    name: 'priority: the rook on e8 hangs inside a mate in 2 → mate_allowed',
    rule: 'mate_allowed',
    fires: ['mate_allowed', 'piece_hangs'],
    fen: '4r1k1/pp1q1pbp/6pB/8/8/8/PPQ2PPP/4RK2 b - - 0 1',
    played: 'd7d4',
    best: ['d7b5', 'e1e2', 'g7h6', 'g2g3', 'e8e5', 'h2h4', 'h6f8', 'b2b3'],
    evalBefore: { cp: -687 },
    evalAfter: { mate: 2 },
    reply: ['e1e8', 'g7f8', 'e8f8'],
    sentences: ['Qd4 allows mate in 2: 2. Rxe8+ Bf8 3. Rxf8#.', 'Better was Qb5+.'],
  },
];
