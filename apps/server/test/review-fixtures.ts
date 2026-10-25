import { Chess } from 'chess.js';
import {
  reviewGameKey,
  type ReviewPreset,
  type ReviewPutMessage,
  type StoredReviewRecord,
} from '@daisychess/engine-core';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const counts = { best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, forced: 0 };

/**
 * A schema-valid review of the SAN game `sans` (FENs computed with chess.js), as a `review.put`
 * message. `pad` appends text to every swing/line to make the record larger (eviction tests).
 */
export function fixtureReview(
  sans: readonly string[],
  preset: ReviewPreset = 'fast',
  pad = '',
  startFen = START_FEN,
): ReviewPutMessage {
  const chess = new Chess(startFen);
  const uci: string[] = [];
  const moves: StoredReviewRecord['summary']['moves'] = [];
  const moveDetails: StoredReviewRecord['moveDetails'] = {};
  sans.forEach((san, i) => {
    const fenBefore = chess.fen();
    const m = chess.move(san);
    const u = `${m.from}${m.to}${m.promotion ?? ''}`;
    uci.push(u);
    const mover = i % 2 === 0 ? 'white' : 'black';
    moves.push({
      ply: i + 1,
      san,
      uci: u,
      mover,
      evalBefore: { cp: 10 },
      evalAfter: { cp: 12 },
      bestMove: u,
      winProbBefore: 50,
      winProbAfter: 50.5,
      winProbLoss: 0,
      classification: 'best',
    });
    moveDetails[String(i + 1)] = {
      ply: i + 1,
      mover,
      moveLabel: `${Math.floor(i / 2) + 1}${mover === 'white' ? '.' : '...'}`,
      playedUci: u,
      playedSan: san,
      bestLine: [u],
      bestLineSan: `${san}${pad}`.slice(0, 200),
      bestLineMoves: [san],
      bestLineFen: chess.fen(),
      fenBefore,
      fenAfter: chess.fen(),
      evalBeforeWhite: { cp: 10 },
      evalAfterWhite: { cp: 12 },
      swing: '+0.02',
      winProbLoss: 0,
      classification: 'best',
      playedIsBest: true,
    };
  });
  const record: StoredReviewRecord = {
    version: 1,
    options: preset === 'fast' ? { movetime: 300 } : { depth: 18 },
    engine: { kind: 'server', name: 'Stockfish 19', threads: 4 },
    summary: {
      white: { accuracy: 100, counts: { ...counts, best: Math.ceil(sans.length / 2) } },
      black: { accuracy: 100, counts: { ...counts, best: Math.floor(sans.length / 2) } },
      moves,
    },
    moveDetails,
  };
  return {
    type: 'review.put',
    gameKey: reviewGameKey(startFen, uci),
    startFen,
    moves: [...sans],
    preset,
    record,
  };
}

export const SCHOLAR = ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'];
export const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd3', 'd6'];
