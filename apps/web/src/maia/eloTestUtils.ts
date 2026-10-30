/** A long synthetic reviewed game for the Elo estimate tests (no engine, no sockets). */
import type { PolicyEntry, ReviewedMove, ReviewSummary } from '@daisychess/engine-core';
import { Chess } from 'chess.js';
import type { HintSourceDetail } from './hints';
import type { FakeAnswer } from './hintTestUtils';

export interface EloTestGame {
  pgn: string;
  startFen: string;
  summary: ReviewSummary;
  details: Record<number, HintSourceDetail>;
  /** Position before ply n → the move played / a different legal move ("best"). */
  playedAt: Map<string, string>;
  otherAt: Map<string, string>;
}

const uciOf = (m: { from: string; to: string; promotion?: string }) =>
  `${m.from}${m.to}${m.promotion ?? ''}`;

/**
 * A deterministic game of `plies` legal moves (never ending early), every move classified
 * `good` in an undecided position (win probability 50 before, `50 − loss` after).
 */
export function eloTestGame(plies = 80, loss = 5, seed = 7): EloTestGame {
  const c = new Chess();
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s;
  };
  const moves: ReviewedMove[] = [];
  const details: Record<number, HintSourceDetail> = {};
  const playedAt = new Map<string, string>();
  const otherAt = new Map<string, string>();
  for (let ply = 1; ply <= plies; ply++) {
    const fenBefore = c.fen();
    const legal = c.moves({ verbose: true });
    let pick: (typeof legal)[number] | undefined;
    for (let t = 0; t < legal.length; t++) {
      const m = legal[(rnd() + t) % legal.length]!;
      c.move(m.san);
      const over = c.isGameOver();
      c.undo();
      if (!over) {
        pick = m;
        break;
      }
    }
    if (!pick) throw new Error(`test game ends at ply ${ply}`);
    const other = legal.find((m) => m.san !== pick.san) ?? pick;
    c.move(pick.san);
    const mover = ply % 2 === 1 ? 'white' : 'black';
    const uci = uciOf(pick);
    moves.push({
      ply,
      san: pick.san,
      uci,
      mover,
      evalBefore: { cp: 0 },
      evalAfter: { cp: 0 },
      bestMove: uciOf(other),
      winProbBefore: 50,
      winProbAfter: 50 - loss,
      winProbLoss: loss,
      classification: 'good',
    });
    details[ply] = {
      ply,
      classification: 'good',
      fenBefore,
      playedUci: uci,
      bestUci: uciOf(other),
      mover,
    };
    playedAt.set(fenBefore, uci);
    otherAt.set(fenBefore, uciOf(other));
  }
  const summary: ReviewSummary = {
    white: { accuracy: 80, counts: { ...zero } },
    black: { accuracy: 80, counts: { ...zero } },
    moves,
  };
  return { pgn: c.pgn(), startFen: new Chess().fen(), summary, details, playedAt, otherAt };
}

const zero = {
  best: 0,
  excellent: 0,
  good: 0,
  inaccuracy: 0,
  mistake: 0,
  blunder: 0,
  forced: 0,
};

/** Probability a level gives the played move: peaked at `peak` (a player of that strength). */
export const peakedP = (rating: number, peak = 1500): number =>
  0.05 + 0.35 * Math.exp(-(((rating - peak) / 200) ** 2));

/**
 * A server with ADR-024: answers with the requested moves (`policyMoves`) and a filler, the
 * played move with {@link peakedP}.
 */
export function newServerAnswer(game: EloTestGame, peak = 1500) {
  return (
    rating: number,
    fen: string,
    _attempt: number,
    policyMoves: readonly string[] | undefined,
  ): FakeAnswer => {
    const played = game.playedAt.get(fen)!;
    const out: PolicyEntry[] = [{ uci: played, p: peakedP(rating, peak) }];
    for (const m of policyMoves ?? []) if (m !== played) out.push({ uci: m, p: 0.2 });
    return out.sort((a, b) => b.p - a.p);
  };
}

/**
 * A server older than ADR-024: ignores `policyMoves`; its top list misses the played move in
 * every `missEvery`-th position (by ply parity of the FEN's fullmove number).
 */
export function oldServerAnswer(game: EloTestGame, missEvery = 6, peak = 1500) {
  const order = [...game.playedAt.keys()];
  return (rating: number, fen: string): FakeAnswer => {
    const played = game.playedAt.get(fen)!;
    const other = game.otherAt.get(fen)!;
    const i = order.indexOf(fen);
    if (i % missEvery === 0) return [{ uci: other, p: 0.5 }];
    return [
      { uci: played, p: peakedP(rating, peak) },
      ...(other !== played ? [{ uci: other, p: 0.01 }] : []),
    ].sort((a, b) => b.p - a.p);
  };
}
