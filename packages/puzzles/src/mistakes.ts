import { Chess } from 'chess.js';
import type { Puzzle, Score, Side } from './schemas.js';
import { sha256Hex } from './sha256.js';

/**
 * Stage 2 (ADR-023 §9): puzzles from the user's own reviewed games. Pure functions; the engine
 * searches are run by the caller (`apps/web/src/puzzles/mistakeGenerator.ts`) and supplied here.
 */

/** Win probability 0..100 for White of a White-POV centipawn value (lichess sigmoid). */
const cpToWin = (cp: number): number => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

/**
 * Win probability 0..100 of the side whose point of view `score` is given from. Mate for that
 * side → 100, against it (or `mate: 0`, the side is mated) → 0.
 */
export function winProbability(score: Score): number {
  if ('mate' in score) return score.mate > 0 ? 100 : 0;
  return cpToWin(score.cp);
}

/** `score` (White POV) seen from `side`. */
export function scoreFor(score: Score, side: Side): Score {
  if (side === 'white') return score;
  return 'mate' in score ? { mate: -score.mate } : { cp: -score.cp };
}

/** Score from the other side's point of view. */
const negate = (s: Score): Score => ('mate' in s ? { mate: -s.mate } : { cp: -s.cp });

/**
 * The fields of a review move detail the extraction needs (a subset of the web's `MoveDetail` /
 * the server store's `StoredMoveDetail`; scores are White POV).
 */
export interface MistakeMoveDetail {
  ply: number;
  mover: Side;
  classification: string;
  bestUci?: string;
  playedUci: string;
  fenBefore: string;
  evalBeforeWhite: Score;
  evalAfterWhite: Score;
  evalIfBest?: Score;
}

export interface ReviewForMistakes {
  moveDetails: Readonly<Record<number, MistakeMoveDetail>>;
}

export interface MistakeCandidate {
  /** `m:<16 hex of sha256(mistakeFen)>` */
  id: string;
  ply: number;
  userSide: Side;
  /** Puzzle start: the position before the opponent's previous move (or `mistakeFen`). */
  fen: string;
  /** The opponent's previous move (UCI); absent at ply 1 (the puzzle has no intro). */
  intro?: string;
  /** The position of the mistake (user to move). */
  mistakeFen: string;
  bestUci: string;
  playedUci: string;
  classification: 'mistake' | 'blunder';
  evalBeforeWhite: Score;
  evalAfterWhite: Score;
}

/** A best move whose win probability for the user is below this is not a puzzle. */
export const MIN_BEST_WIN_PROB = 20;

/** Mistake-puzzle id of a position. */
export function mistakeId(fen: string): string {
  return `m:${sha256Hex(fen).slice(0, 16)}`;
}

const positionKey = (fen: string): string => fen.split(' ').slice(0, 4).join(' ');

function playOne(fen: string, uci: string): string | undefined {
  try {
    const chess = new Chess(fen);
    chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return chess.fen();
  } catch {
    return undefined;
  }
}

/**
 * Candidate mistakes of a review for the user's side: every ply moved by `userSide` classified
 * `mistake` or `blunder` with a known best move, except positions where the best move itself
 * leaves the user below 20 % win probability; deduplicated by position (first occurrence wins),
 * ordered by ply. The intro is the opponent's previous move when it is known and leads to the
 * mistake position; otherwise the candidate starts with the user to move (no intro).
 */
export function mistakeCandidates(review: ReviewForMistakes, userSide: Side): MistakeCandidate[] {
  const details = Object.values(review.moveDetails)
    .filter((d): d is MistakeMoveDetail => d !== undefined)
    .sort((a, b) => a.ply - b.ply);
  const byPly = new Map(details.map((d) => [d.ply, d]));
  const seen = new Set<string>();
  const out: MistakeCandidate[] = [];
  for (const d of details) {
    if (d.mover !== userSide) continue;
    if (d.classification !== 'mistake' && d.classification !== 'blunder') continue;
    if (!d.bestUci) continue;
    const ifBest = d.evalIfBest ?? d.evalBeforeWhite;
    if (winProbability(scoreFor(ifBest, userSide)) < MIN_BEST_WIN_PROB) continue;
    const id = mistakeId(d.fenBefore);
    if (seen.has(id)) continue;
    seen.add(id);
    const c: MistakeCandidate = {
      id,
      ply: d.ply,
      userSide,
      fen: d.fenBefore,
      mistakeFen: d.fenBefore,
      bestUci: d.bestUci,
      playedUci: d.playedUci,
      classification: d.classification,
      evalBeforeWhite: d.evalBeforeWhite,
      evalAfterWhite: d.evalAfterWhite,
    };
    const prev = byPly.get(d.ply - 1);
    if (prev && prev.mover !== userSide && prev.playedUci) {
      const after = playOne(prev.fenBefore, prev.playedUci);
      if (after && positionKey(after) === positionKey(d.fenBefore)) {
        c.fen = prev.fenBefore;
        c.intro = prev.playedUci;
      }
    }
    out.push(c);
  }
  return out;
}

/** One principal variation; `score` is from the point of view of the side to move in `fen`. */
export interface SearchLine {
  pv: string[];
  score: Score;
}

/** A `multipv` search of `fen`, best line first. */
export interface SearchResult {
  fen: string;
  lines: SearchLine[];
}

export type SearchPurpose = 'start' | 'reply' | 'final';

export type CutSkipReason =
  'no-result' | 'only-move' | 'not-clear' | 'illegal-line' | 'eval-drift' | 'budget';

export type CutDecision =
  /** Run this search and call `cutSolution` again with it added. */
  | { type: 'search'; fen: string; multipv: number; purpose: SearchPurpose }
  | { type: 'skip'; reason: CutSkipReason }
  /** `solution` starts with the user's move and ends with a user move. */
  | { type: 'accept'; puzzle: Puzzle; solution: string[]; userMoves: number };

/** Thresholds of the line cutting (ADR-023 §9). */
export const CUT_LIMITS = {
  maxUserMoves: 3,
  maxSearches: 4,
  /** Best vs second-best at the start: at least this many win-probability points … */
  clearWinProb: 10,
  /** … and, for two centipawn evals, at least this many centipawns. */
  clearCp: 80,
  /** An opponent reply is not forced when the second-best is within 100 cp … */
  forcedCp: 100,
  /** … or within 5 win-probability points. */
  forcedWinProb: 5,
  /** The end position may be at most this much worse for the user than the start. */
  driftCp: 50,
} as const;

/** True when `best` is clearly better than `second` (both from the same point of view). */
function clearlyBetter(best: Score, second: Score): boolean {
  if (winProbability(best) - winProbability(second) < CUT_LIMITS.clearWinProb) return false;
  if ('cp' in best && 'cp' in second) return best.cp - second.cp >= CUT_LIMITS.clearCp;
  return true;
}

/** True when the second-best reply is about as good as the best one (reply not forced). */
function closeAlternative(best: Score, second: Score): boolean {
  if ('cp' in best && 'cp' in second && Math.abs(best.cp - second.cp) <= CUT_LIMITS.forcedCp)
    return true;
  return Math.abs(winProbability(best) - winProbability(second)) <= CUT_LIMITS.forcedWinProb;
}

/** End eval acceptable against the start eval (user POV): same mate sign, or ≤ 50 cp worse. */
function holdsEval(start: Score, end: Score): boolean {
  if ('mate' in start) {
    const startWins = start.mate > 0;
    return 'mate' in end ? end.mate > 0 === startWins : !startWins;
  }
  if ('mate' in end) return end.mate > 0;
  return end.cp >= start.cp - CUT_LIMITS.driftCp;
}

const legalCount = (fen: string): number => {
  try {
    return new Chess(fen).moves().length;
  } catch {
    return 0;
  }
};

interface Cut {
  /** Solution length (plies, from the user's first move). */
  length: number;
  /** Eval for the user after the cut's last user move, when known. */
  eval?: Score;
}

/**
 * Validates a candidate and cuts its solution line (ADR-023 §9). Deterministic over the supplied
 * `results` (matched by position): returns the next search to run, a skip, or the accepted puzzle.
 * Searches: `start` = the mistake position (`multipv: 2`; skipped unless the best move is clearly
 * better than the second best); `reply` = the opponent's position after each user move of the
 * line (`multipv: 2`; a non-forced reply ends the line before it); `final` = the last position
 * when its eval is not known yet. At most 3 user moves and 4 searches.
 */
export function cutSolution(
  candidate: MistakeCandidate,
  results: readonly SearchResult[],
): CutDecision {
  const byPos = new Map(results.map((r) => [positionKey(r.fen), r]));
  const used = new Set<string>();
  const find = (fen: string): SearchResult | undefined => {
    const r = byPos.get(positionKey(fen));
    if (r) used.add(positionKey(fen));
    return r;
  };
  const request = (fen: string, purpose: SearchPurpose, multipv: number): CutDecision =>
    used.size >= CUT_LIMITS.maxSearches
      ? { type: 'skip', reason: 'budget' }
      : { type: 'search', fen, multipv, purpose };

  const start = find(candidate.mistakeFen);
  if (!start) return request(candidate.mistakeFen, 'start', 2);
  const best = start.lines[0];
  if (!best || best.pv.length === 0) return { type: 'skip', reason: 'no-result' };
  const second = start.lines[1];
  if (!second) {
    return {
      type: 'skip',
      reason: legalCount(candidate.mistakeFen) <= 1 ? 'only-move' : 'not-clear',
    };
  }
  if (!clearlyBetter(best.score, second.score)) return { type: 'skip', reason: 'not-clear' };
  const startEval = best.score;

  const firstUser = best.pv[0]!;
  let fen = playOne(candidate.mistakeFen, firstUser);
  if (!fen) return { type: 'skip', reason: 'illegal-line' };
  const solution = [firstUser];
  let cont = best.pv.slice(1);
  const cuts: Cut[] = [{ length: 1 }];

  for (;;) {
    const cut = cuts[cuts.length - 1]!;
    const chess = new Chess(fen);
    if (chess.isCheckmate()) {
      cut.eval = { mate: 1 };
      break;
    }
    if (chess.isDraw() || chess.moves().length === 0) {
      cut.eval = { cp: 0 };
      break;
    }
    if (cuts.length >= CUT_LIMITS.maxUserMoves || cont.length === 0) break;
    const reply = find(fen);
    if (!reply) return request(fen, 'reply', 2);
    const r0 = reply.lines[0];
    if (!r0 || r0.pv.length === 0) break;
    cut.eval = negate(r0.score);
    const r1 = reply.lines[1];
    const forced = r1 ? !closeAlternative(r0.score, r1.score) : legalCount(fen) <= 1;
    if (!forced) break;
    const opp = r0.pv[0]!;
    const next = r0.pv[1] ?? (cont[0] === opp ? cont[1] : undefined);
    if (next === undefined) break;
    const afterOpp = playOne(fen, opp);
    const afterUser = afterOpp && playOne(afterOpp, next);
    if (!afterUser) break;
    solution.push(opp, next);
    fen = afterUser;
    cont = r0.pv.slice(2);
    cuts.push({ length: solution.length });
  }

  const last = cuts[cuts.length - 1]!;
  if (last.eval === undefined) {
    const fin = find(fen);
    if (!fin) return request(fen, 'final', 1);
    const f0 = fin.lines[0];
    if (!f0) return { type: 'skip', reason: 'no-result' };
    last.eval = negate(f0.score);
  }
  const chosen = holdsEval(startEval, last.eval)
    ? last
    : cuts.find((c) => c.eval !== undefined && holdsEval(startEval, c.eval));
  if (!chosen) return { type: 'skip', reason: 'eval-drift' };
  const line = solution.slice(0, chosen.length);
  const puzzle: Puzzle = {
    id: candidate.id,
    fen: candidate.fen,
    moves: candidate.intro ? [candidate.intro, ...line] : line,
    themes: [],
    openings: [],
    source: 'mistake',
  };
  if (!candidate.intro) puzzle.noIntro = true;
  return { type: 'accept', puzzle, solution: line, userMoves: (line.length + 1) / 2 };
}
