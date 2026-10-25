import {
  formatScore,
  type MoveClass,
  type ReviewedMove,
  type ReviewSummary,
  type Score,
  type StoredMoveDetail,
} from '@daisychess/engine-core';
import { convertPv } from '../engine/pvToSan';
import type { BatchGame, PositionResult } from './BatchAnalyzer';

/**
 * Per-move details of a review, next to the engine-core {@link ReviewSummary} (which stays
 * unchanged): the engine's best line in SAN, evals and a swing text. Keyed by ply (1-based).
 */
export interface MoveDetail {
  ply: number;
  mover: 'white' | 'black';
  /** `12.` / `12...` */
  moveLabel: string;
  playedUci: string;
  playedSan: string;
  /** Engine's best move (UCI) in the position before the move, if known. */
  bestUci?: string;
  /** SAN of the best move; set only when it differs from the played move. */
  bestSan?: string;
  /** Engine line from the position before the move (UCI, up to 8 plies). */
  bestLine: string[];
  /** The best line in SAN with move numbers, e.g. `3... g6 4. Qf3 Nf6`. */
  bestLineSan: string;
  /** SAN moves of the best line (for the board preview). */
  bestLineMoves: string[];
  /** Position after the whole best line (preview target); `fenBefore` if there is no line. */
  bestLineFen: string;
  fenBefore: string;
  fenAfter: string;
  /** Position evals, White POV. */
  evalBeforeWhite: Score;
  evalAfterWhite: Score;
  /** Eval had the best move been played (= `evalBeforeWhite`); only when the played move differs. */
  evalIfBest?: Score;
  /** Eval change from the mover's point of view: `−2.35`, `+0.10`, `allows mate in 2`, … */
  swing: string;
  winProbLoss: number;
  classification: MoveClass;
  /** True when the played move is the engine's first choice. */
  playedIsBest: boolean;
}

export type MoveDetails = Record<number, MoveDetail>;

// Compile-time guarantee that the details stay interchangeable with the wire shape of the server
// review store (ADR-017, `StoredMoveDetailSchema`).
type Assignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const detailMatchesWire: Assignable<MoveDetail, StoredMoveDetail> = true;
void detailMatchesWire;

const MINUS = '−';

/** `12.` / `12...` for the move played in `fen`. */
export function moveLabelFromFen(fen: string): string {
  const parts = fen.split(' ');
  return `${Number(parts[5]) || 1}${parts[1] === 'b' ? '...' : '.'}`;
}

/** Mate distance from the mover's point of view (positive = the mover mates), or null. */
function moverMate(s: Score, mover: 'white' | 'black'): number | null {
  if (!('mate' in s)) return null;
  return mover === 'white' ? s.mate : -s.mate;
}

/** Eval change from the mover's point of view. */
export function swingText(before: Score, after: Score, mover: 'white' | 'black'): string {
  if ('mate' in after && after.mate === 0) return 'checkmate';
  const mb = moverMate(before, mover);
  const ma = moverMate(after, mover);
  if (ma !== null && ma < 0) return mb !== null && mb < 0 ? 'still mated' : `allows mate in ${-ma}`;
  if (mb !== null && mb > 0 && (ma === null || ma <= 0)) return `misses mate in ${mb}`;
  if (ma !== null && ma > 0) return mb !== null && mb > 0 ? 'keeps the mate' : `mate in ${ma}`;
  if ('cp' in before && 'cp' in after) {
    const d = ((after.cp - before.cp) * (mover === 'white' ? 1 : -1)) / 100;
    const s = Math.abs(d).toFixed(2);
    if (s === '0.00') return '0.00';
    return `${d > 0 ? '+' : MINUS}${s}`;
  }
  return `${formatScore(before)} → ${formatScore(after)}`;
}

/** Builds the details of one reviewed move. `pvBefore` is the engine line of the position before. */
export function buildMoveDetail(
  move: ReviewedMove,
  fenBefore: string,
  fenAfter: string,
  pvBefore?: readonly string[],
): MoveDetail {
  const bestUci = move.bestMove ?? pvBefore?.[0];
  // The bestmove can differ from the last info's PV (rare); then the PV does not belong to it.
  const line = bestUci ? (pvBefore && pvBefore[0] === bestUci ? [...pvBefore] : [bestUci]) : [];
  const conv = convertPv(fenBefore, line);
  const playedIsBest = bestUci !== undefined && bestUci === move.uci;
  const bestSan = !playedIsBest ? conv.san[0] : undefined;
  return {
    ply: move.ply,
    mover: move.mover,
    moveLabel: moveLabelFromFen(fenBefore),
    playedUci: move.uci,
    playedSan: move.san ?? move.uci,
    ...(bestUci !== undefined ? { bestUci } : {}),
    ...(bestSan !== undefined ? { bestSan } : {}),
    bestLine: line.slice(0, conv.count),
    bestLineSan: conv.text,
    bestLineMoves: conv.san,
    bestLineFen: conv.fen,
    fenBefore,
    fenAfter,
    evalBeforeWhite: move.evalBefore,
    evalAfterWhite: move.evalAfter,
    ...(!playedIsBest && bestUci !== undefined ? { evalIfBest: move.evalBefore } : {}),
    swing: swingText(move.evalBefore, move.evalAfter, move.mover),
    winProbLoss: move.winProbLoss,
    classification: move.classification,
    playedIsBest,
  };
}

/**
 * Details for the moves of `summary` (a full or partial review of `game`). `results[i]` is the
 * analysis of position i (0 = start). Plies already in `previous` are reused, so a running
 * review only converts the newly analysed moves.
 */
export function buildMoveDetails(
  summary: ReviewSummary,
  game: BatchGame,
  results: readonly Pick<PositionResult, 'pv'>[],
  previous: MoveDetails = {},
): MoveDetails {
  const out: MoveDetails = {};
  for (const m of summary.moves) {
    const fenBefore = m.ply <= 1 ? game.startFen : game.moves[m.ply - 2]?.fenAfter;
    const fenAfter = game.moves[m.ply - 1]?.fenAfter;
    if (!fenBefore || !fenAfter) continue;
    const prev = previous[m.ply];
    out[m.ply] =
      prev && prev.fenAfter === fenAfter && prev.classification === m.classification
        ? prev
        : buildMoveDetail(m, fenBefore, fenAfter, results[m.ply - 1]?.pv);
  }
  return out;
}

const pct = (n: number): string => `${Math.max(1, Math.round(n))}%`;

/** One-sentence explanation of a move (simple templates per class). */
export function explainMove(d: MoveDetail): string {
  const best = d.bestSan ? `${d.moveLabel} ${d.bestSan}` : undefined;
  const keep = `keeping the evaluation at ${formatScore(d.evalBeforeWhite)}`;
  if ('mate' in d.evalAfterWhite && d.evalAfterWhite.mate === 0) return 'Checkmate.';
  switch (d.classification) {
    case 'forced':
      return 'Only move.';
    case 'best':
      return d.playedIsBest || !best
        ? "Good move. Matches the engine's first choice."
        : `Good move. As strong as the engine's first choice, ${best}.`;
    case 'excellent':
      return best ? `Excellent move. The engine's first choice was ${best}.` : 'Excellent move.';
    case 'good':
      return best ? `Good move. The engine prefers ${best}, ${keep}.` : 'Good move.';
    default: {
      const mb = moverMate(d.evalBeforeWhite, d.mover);
      const ma = moverMate(d.evalAfterWhite, d.mover);
      const what =
        ma !== null && ma < 0 && !(mb !== null && mb < 0)
          ? 'Allows a forced mate.'
          : mb !== null && mb > 0 && (ma === null || ma <= 0)
            ? 'Misses a forced mate.'
            : `Loses ${pct(d.winProbLoss)} winning chances.`;
      return best ? `${what} The engine prefers ${best}, ${keep}.` : what;
    }
  }
}

const BAD: ReadonlySet<MoveClass> = new Set(['inaccuracy', 'mistake', 'blunder']);
const GOOD: ReadonlySet<MoveClass> = new Set(['best', 'excellent']);
/** Classes the prev/next buttons jump between. */
export const JUMP_CLASSES: ReadonlySet<MoveClass> = new Set(['mistake', 'blunder']);

export interface SideHighlights {
  /** Best/excellent moves that kept (or gained) the most, at most `maxGood`. */
  good: ReviewedMove[];
  /** Inaccuracies, mistakes and blunders, biggest loss first. */
  improve: ReviewedMove[];
}

/** "Good moves" and "Moves to improve" per side. */
export function reviewHighlights(
  summary: ReviewSummary,
  maxGood = 5,
  maxImprove = 10,
): Record<'white' | 'black', SideHighlights> {
  const side = (color: 'white' | 'black'): SideHighlights => {
    const mine = summary.moves.filter((m) => m.mover === color);
    const good = mine
      .filter((m) => GOOD.has(m.classification))
      .sort(
        (a, b) =>
          b.winProbAfter - b.winProbBefore - (a.winProbAfter - a.winProbBefore) || a.ply - b.ply,
      )
      .slice(0, maxGood);
    const improve = mine
      .filter((m) => BAD.has(m.classification))
      .sort((a, b) => b.winProbLoss - a.winProbLoss || a.ply - b.ply)
      .slice(0, maxImprove);
    return { good, improve };
  };
  return { white: side('white'), black: side('black') };
}

/** Next (`dir = 1`) or previous (`-1`) ply after/before `ply` with a mistake or blunder. */
export function findJump(
  summary: ReviewSummary,
  ply: number,
  dir: 1 | -1,
  classes: ReadonlySet<MoveClass> = JUMP_CLASSES,
): number | undefined {
  const plies = summary.moves.filter((m) => classes.has(m.classification)).map((m) => m.ply);
  return dir === 1 ? plies.find((p) => p > ply) : plies.reverse().find((p) => p < ply);
}
