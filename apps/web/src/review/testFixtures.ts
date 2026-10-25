import type { MoveClass, ReviewedMove, ReviewSummary, Score } from '@daisychess/engine-core';

const counts = (): Record<MoveClass, number> => ({
  best: 0,
  excellent: 0,
  good: 0,
  inaccuracy: 0,
  mistake: 0,
  blunder: 0,
  forced: 0,
});

/** Review of 1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# (hand-made numbers). */
export function scholarSummary(): ReviewSummary {
  const spec: [string, string, ReviewedMove['mover'], Score, MoveClass, string?][] = [
    ['e4', 'e2e4', 'white', { cp: 30 }, 'best'],
    ['e5', 'e7e5', 'black', { cp: 25 }, 'best'],
    ['Bc4', 'f1c4', 'white', { cp: 35 }, 'good'],
    ['Nc6', 'b8c6', 'black', { cp: 30 }, 'best'],
    ['Qh5', 'd1h5', 'white', { cp: 20 }, 'inaccuracy', 'g1f3'],
    ['Nf6', 'g8f6', 'black', { mate: 1 }, 'blunder', 'g7g6'],
    ['Qxf7#', 'h5f7', 'white', { mate: 0 }, 'best'],
  ];
  let before: Score = { cp: 20 };
  const moves = spec.map(([san, uci, mover, after, classification, bestMove], i): ReviewedMove => {
    const wp = (s: Score): number =>
      'mate' in s ? (s.mate > 0 ? 100 : 0) : 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * s.cp)) - 1);
    const m = (p: number): number => (mover === 'white' ? p : 100 - p);
    const pb = m(wp(before));
    const pa = mover === 'white' && 'mate' in after ? 100 : m(wp(after));
    const r: ReviewedMove = {
      ply: i + 1,
      san,
      uci,
      mover,
      evalBefore: before,
      evalAfter: after,
      bestMove: bestMove ?? uci,
      winProbBefore: pb,
      winProbAfter: pa,
      winProbLoss: Math.max(0, pb - pa),
      classification,
    };
    before = after;
    return r;
  });
  const summary: ReviewSummary = {
    white: { accuracy: 87, counts: counts() },
    black: { accuracy: 62, counts: counts() },
    moves,
  };
  for (const m of moves) summary[m.mover].counts[m.classification]++;
  return summary;
}

/**
 * The game of {@link scholarSummary} with lichess-style clocks (1+0): Black blunders 3... Nf6
 * after a 35 s think with 5 s left (time trouble).
 */
export const SCHOLAR_TIMED_PGN =
  '[White "Ann"]\n[Black "Bob"]\n[TimeControl "60+0"]\n\n' +
  '1. e4 { [%clk 0:01:00] } 1... e5 { [%clk 0:01:00] } 2. Bc4 { [%clk 0:00:58] } ' +
  '2... Nc6 { [%clk 0:00:40] } 3. Qh5 { [%clk 0:00:50] } 3... Nf6 { [%clk 0:00:05] } ' +
  '4. Qxf7# { [%clk 0:00:49] } 1-0';
