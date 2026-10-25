import type { ReviewSummary, Score } from '@daisychess/engine-core';
import type { MoveRecord } from '../store/gameStore';
import { bestMoveSan, moveNumberLabel } from './format';

const NAGS: Partial<Record<string, string>> = { inaccuracy: '$6', mistake: '$2', blunder: '$4' };
const STD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** `[%eval 0.35]` value: pawns with two decimals, mate as `#3` / `#-3`. `undefined` for `mate 0`. */
export function evalComment(score: Score): string | undefined {
  if ('mate' in score) return score.mate === 0 ? undefined : `#${score.mate}`;
  return (score.cp / 100).toFixed(2);
}

const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const clean = (s: string): string => s.replace(/[{}]/g, '');

/**
 * Builds a PGN of the game. With a review summary it adds `[%eval]` comments (White POV, after
 * the move), NAGs for inaccuracies/mistakes/blunders, "best was ..." comments and an accuracy
 * comment before the first move.
 */
export function annotatePgn(
  headers: Readonly<Record<string, string>>,
  startFen: string,
  moves: readonly MoveRecord[],
  summary?: ReviewSummary,
): string {
  const h: Record<string, string> = { ...headers };
  if (!h.Result) h.Result = '*';
  if (startFen !== STD_FEN && !h.FEN) {
    h.SetUp = '1';
    h.FEN = startFen;
  }
  const lines = Object.entries(h).map(([k, v]) => `[${k} "${esc(v)}"]`);

  const tokens: string[] = [];
  if (summary) {
    const w = Math.round(summary.white.accuracy);
    const b = Math.round(summary.black.accuracy);
    tokens.push(`{ Accuracy: White ${w}%, Black ${b}% }`);
  }
  let needNumber = true;
  moves.forEach((m, i) => {
    const ply = i + 1;
    const label = moveNumberLabel(startFen, ply);
    const black = label.endsWith('...');
    if (!black || needNumber) tokens.push(label);
    tokens.push(m.san);
    needNumber = false;
    const r = summary?.moves.find((x) => x.ply === ply);
    if (!r) return;
    const nag = NAGS[r.classification];
    if (nag) tokens.push(nag);
    const ev = evalComment(r.evalAfter);
    const parts: string[] = ev ? [`[%eval ${ev}]`] : [];
    if (r.classification === 'mistake' || r.classification === 'blunder') {
      const best = bestMoveSan(startFen, moves, r);
      if (best) parts.push(`best was ${clean(best)}`);
    }
    // One comment per move: some parsers (chess.js) reject consecutive comments.
    if (parts.length > 0) {
      tokens.push(`{ ${parts.join(' ')} }`);
      needNumber = true;
    }
  });
  tokens.push(h.Result);
  return `${lines.join('\n')}\n\n${tokens.join(' ')}\n`;
}
