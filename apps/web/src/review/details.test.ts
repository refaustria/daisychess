import type { ReviewedMove } from '@daisychess/engine-core';
import { describe, expect, it } from 'vitest';
import { gameToBatch } from './reviewStore';
import {
  buildMoveDetail,
  buildMoveDetails,
  explainMove,
  findJump,
  moveLabelFromFen,
  reviewHighlights,
  swingText,
  type MoveDetail,
} from './details';
import { scholarSummary } from './testFixtures';
import { Chess } from 'chess.js';

const SCHOLAR = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'];

function scholarGame() {
  const c = new Chess();
  const startFen = c.fen();
  const moves = SCHOLAR.map((san) => {
    const m = c.move(san);
    return { san: m.san, from: m.from, to: m.to, fen: m.after };
  });
  return gameToBatch({ startFen, moves });
}

describe('buildMoveDetails', () => {
  it('converts the best line to SAN from the position before the move', () => {
    const game = scholarGame();
    const results = Array.from({ length: 8 }, () => ({}));
    results[5] = { pv: ['g7g6', 'h5f3', 'g8f6', 'f3b3'] };
    const d = buildMoveDetails(scholarSummary(), game, results);
    const nf6 = d[6]!;
    expect(nf6.moveLabel).toBe('3...');
    expect(nf6.playedSan).toBe('Nf6');
    expect(nf6.bestSan).toBe('g6');
    expect(nf6.bestLine).toEqual(['g7g6', 'h5f3', 'g8f6', 'f3b3']);
    expect(nf6.bestLineSan).toBe('3... g6 4. Qf3 Nf6 5. Qb3');
    expect(nf6.bestLineMoves).toEqual(['g6', 'Qf3', 'Nf6', 'Qb3']);
    expect(nf6.fenBefore).toBe(game.moves[4]!.fenAfter);
    expect(nf6.fenAfter).toBe(game.moves[5]!.fenAfter);
    expect(nf6.evalBeforeWhite).toEqual({ cp: 20 });
    expect(nf6.evalAfterWhite).toEqual({ mate: 1 });
    expect(nf6.evalIfBest).toEqual({ cp: 20 });
    expect(nf6.swing).toBe('allows mate in 1');
    expect(nf6.classification).toBe('blunder');
    expect(nf6.playedIsBest).toBe(false);
    // No PV stored → the best move alone; played = best → no "better" move, no evalIfBest.
    expect(d[5]!.bestLineSan).toBe('3. Nf3');
    expect(d[1]!.bestSan).toBeUndefined();
    expect(d[1]!.evalIfBest).toBeUndefined();
    expect(d[1]!.playedIsBest).toBe(true);
    expect(d[7]!.swing).toBe('checkmate');
  });

  it('ignores a PV that does not start with the best move and illegal tails', () => {
    const game = scholarGame();
    const m = scholarSummary().moves[5]!;
    expect(
      buildMoveDetail(m, game.moves[4]!.fenAfter, game.moves[5]!.fenAfter, ['a7a6']).bestLine,
    ).toEqual(['g7g6']);
    const d = buildMoveDetail(m, game.moves[4]!.fenAfter, game.moves[5]!.fenAfter, [
      'g7g6',
      'e1e8',
    ]);
    expect(d.bestLine).toEqual(['g7g6']);
    expect(d.bestLineSan).toBe('3... g6');
  });

  it('reuses unchanged previous details and skips moves outside the game', () => {
    const game = scholarGame();
    const s = scholarSummary();
    const first = buildMoveDetails(s, game, []);
    const again = buildMoveDetails(s, game, [], first);
    expect(again[6]).toBe(first[6]);
    const short = { ...game, moves: game.moves.slice(0, 3) };
    expect(Object.keys(buildMoveDetails(s, short, []))).toEqual(['1', '2', '3']);
  });
});

describe('swingText', () => {
  it('formats cp swings from the mover’s point of view and mate changes', () => {
    expect(swingText({ cp: 30 }, { cp: -120 }, 'white')).toBe('−1.50');
    expect(swingText({ cp: 30 }, { cp: -120 }, 'black')).toBe('+1.50');
    expect(swingText({ cp: 30 }, { cp: 30 }, 'white')).toBe('0.00');
    expect(swingText({ cp: 30 }, { mate: -2 }, 'white')).toBe('allows mate in 2');
    expect(swingText({ mate: 3 }, { cp: 200 }, 'white')).toBe('misses mate in 3');
    expect(swingText({ mate: 3 }, { mate: 2 }, 'white')).toBe('keeps the mate');
    expect(swingText({ cp: 300 }, { mate: 4 }, 'white')).toBe('mate in 4');
    expect(swingText({ mate: -3 }, { mate: -2 }, 'white')).toBe('still mated');
    expect(swingText({ cp: 0 }, { mate: 0 }, 'black')).toBe('checkmate');
  });
});

describe('explainMove', () => {
  const game = scholarGame();
  const details = buildMoveDetails(scholarSummary(), game, []);
  const with_ = (d: MoveDetail, patch: Partial<MoveDetail>): MoveDetail => ({ ...d, ...patch });

  it('uses one template per class', () => {
    expect(explainMove(details[1]!)).toBe("Good move. Matches the engine's first choice.");
    expect(explainMove(details[7]!)).toBe('Checkmate.');
    expect(explainMove(details[6]!)).toBe(
      'Allows a forced mate. The engine prefers 3... g6, keeping the evaluation at +0.20.',
    );
    expect(explainMove(details[5]!)).toMatch(
      /^Loses \d+% winning chances\. The engine prefers 3\. Nf3, keeping the evaluation at \+0\.30\.$/,
    );
    const nf6 = details[6]!;
    expect(explainMove(with_(nf6, { classification: 'forced' }))).toBe('Only move.');
    expect(explainMove(with_(nf6, { classification: 'excellent' }))).toBe(
      "Excellent move. The engine's first choice was 3... g6.",
    );
    expect(explainMove(with_(nf6, { classification: 'good', evalAfterWhite: { cp: 40 } }))).toBe(
      'Good move. The engine prefers 3... g6, keeping the evaluation at +0.20.',
    );
    expect(explainMove(with_(nf6, { classification: 'best', evalAfterWhite: { cp: 20 } }))).toBe(
      "Good move. As strong as the engine's first choice, 3... g6.",
    );
    expect(
      explainMove(
        with_(nf6, {
          classification: 'mistake',
          evalAfterWhite: { cp: 250 },
          winProbLoss: 14.6,
          bestSan: undefined,
        }),
      ),
    ).toBe('Loses 15% winning chances.');
    expect(
      explainMove(
        with_(nf6, {
          classification: 'blunder',
          evalBeforeWhite: { mate: -2 },
          evalAfterWhite: { cp: 0 },
        }),
      ),
    ).toMatch(/^Misses a forced mate\./);
  });
});

describe('reviewHighlights / findJump', () => {
  it('lists good moves and moves to improve per side', () => {
    const h = reviewHighlights(scholarSummary());
    expect(h.white.improve.map((m) => m.san)).toEqual(['Qh5']);
    expect(h.black.improve.map((m) => m.san)).toEqual(['Nf6']);
    expect(h.white.good.map((m) => m.san)).toEqual(['e4', 'Qxf7#']);
    expect(h.black.good.map((m) => m.san).sort()).toEqual(['Nc6', 'e5']);
  });

  it('caps the lists and sorts mistakes by loss', () => {
    const s = scholarSummary();
    const extra: ReviewedMove[] = [10, 30, 20].map((loss, i) => ({
      ...s.moves[1]!,
      ply: 20 + i,
      classification: 'mistake',
      winProbLoss: loss,
    }));
    s.moves.push(...extra);
    const h = reviewHighlights(s, 1, 2);
    expect(h.black.improve.map((m) => m.winProbLoss)).toEqual([s.moves[5]!.winProbLoss, 30]);
    expect(h.black.good).toHaveLength(1);
  });

  it('jumps between mistakes and blunders', () => {
    const s = scholarSummary();
    expect(findJump(s, 0, 1)).toBe(6);
    expect(findJump(s, 6, 1)).toBeUndefined();
    expect(findJump(s, 7, -1)).toBe(6);
    expect(findJump(s, 6, -1)).toBeUndefined();
  });

  it('labels move numbers from the FEN', () => {
    expect(moveLabelFromFen('8/8/8/8/8/8/8/K6k b - - 0 12')).toBe('12...');
    expect(moveLabelFromFen('8/8/8/8/8/8/8/K6k w - - 0 3')).toBe('3.');
  });
});
