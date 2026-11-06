import { Chess } from 'chess.js';
import type {
  MoverResult,
  TbCategory,
  TbMove,
  TbPosition,
  TbScoreHint,
  TbVerdict,
} from './types.js';

/** Largest piece count (kings included) the tablebases cover. */
export const TABLEBASE_MAX_PIECES = 7;

/**
 * The side to move's result under the 50-move rule: `cursed-win` and `blessed-loss` fold to
 * `draw` (`tbScoreHint` reports them with `exact50: false`).
 */
export function moverResult(category: TbCategory): MoverResult {
  switch (category) {
    case 'win':
      return 'win';
    case 'loss':
      return 'loss';
    default:
      return 'draw';
  }
}

const RANK: Record<MoverResult, number> = { loss: 0, draw: 1, win: 2 };
const flip = (r: MoverResult): MoverResult =>
  r === 'win' ? 'loss' : r === 'loss' ? 'win' : 'draw';

/** The mover's result after `move` (the move's category is the opponent's view). */
const resultAfter = (move: TbMove): MoverResult => flip(moverResult(move.category));

/**
 * Exact (50-move-aware) result of the mover after `move`, best = 4:
 * win 4, cursed win 3, draw 2, blessed loss 1, loss 0.
 */
function exactAfter(move: TbMove): number {
  switch (move.category) {
    case 'loss':
      return 4;
    case 'blessed-loss':
      return 3;
    case 'draw':
      return 2;
    case 'cursed-win':
      return 1;
    default:
      return 0;
  }
}

const abs = (n: number | undefined): number | undefined =>
  n === undefined ? undefined : Math.abs(n);

function compareDistance(a: TbMove, b: TbMove, fastest: boolean): number {
  const sign = fastest ? 1 : -1;
  const am = abs(a.dtm);
  const bm = abs(b.dtm);
  if (am !== undefined && bm !== undefined && am !== bm) return sign * (am - bm);
  const az = abs(a.dtz);
  const bz = abs(b.dtz);
  if (az !== undefined && bz !== undefined && az !== bz) return sign * (az - bz);
  return 0;
}

/**
 * Moves best first for the side to move, like lichess: by the mover's exact result (win,
 * cursed win, draw, blessed loss, loss); wins fastest first (checkmate, then DTM, then DTZ),
 * losses slowest first, draws zeroing moves first; remaining ties by UCI (deterministic).
 */
export function rankMoves(pos: TbPosition): TbMove[] {
  return [...pos.moves].sort((a, b) => {
    const ra = exactAfter(a);
    const rb = exactAfter(b);
    if (ra !== rb) return rb - ra;
    let d = 0;
    if (ra >= 3) {
      if (a.checkmate !== b.checkmate) return a.checkmate ? -1 : 1;
      d = compareDistance(a, b, true);
    } else if (ra <= 1) {
      d = compareDistance(a, b, false);
    } else if (a.zeroing !== b.zeroing) {
      d = a.zeroing ? -1 : 1;
    }
    if (d !== 0) return d;
    return a.uci < b.uci ? -1 : a.uci > b.uci ? 1 : 0;
  });
}

/** The moves that keep the side to move's result (50-move rule folded), best first. */
export function keepers(pos: TbPosition): TbMove[] {
  const before = RANK[moverResult(pos.category)];
  return rankMoves(pos).filter((m) => RANK[resultAfter(m)] >= before);
}

/** The best move of the position (first of `rankMoves`), or undefined without legal moves. */
export function bestMove(pos: TbPosition): TbMove | undefined {
  return rankMoves(pos)[0];
}

/**
 * Judges `uci` in `pos`: `thrown` when the mover's result after the move is worse than before
 * (win → draw, win → loss, draw → loss), `only` when it is kept and exactly one legal move keeps
 * it, else `kept`. Undefined when `uci` is not one of the position's moves.
 */
export function judgeMove(pos: TbPosition, uci: string): TbVerdict | undefined {
  const text = uci.trim().toLowerCase();
  const move = pos.moves.find((m) => m.uci === text);
  if (!move) return undefined;
  const before = moverResult(pos.category);
  const after = resultAfter(move);
  const keep = keepers(pos).map((m) => m.uci);
  const kind: TbVerdict['kind'] =
    RANK[after] < RANK[before] ? 'thrown' : keep.length === 1 ? 'only' : 'kept';
  const verdict: TbVerdict = { uci: move.uci, san: move.san, before, after, kind, keepers: keep };
  if (pos.dtm !== undefined) verdict.dtmBefore = pos.dtm;
  if (pos.dtz !== undefined) verdict.dtzBefore = pos.dtz;
  return verdict;
}

const sideToMove = (fen: string): 'white' | 'black' =>
  fen.trim().split(/\s+/)[1] === 'b' ? 'black' : 'white';

/** The display hint of a position from White's point of view (ADR-025 §3). */
export function tbScoreHint(pos: TbPosition): TbScoreHint {
  const r = moverResult(pos.category);
  const stm = sideToMove(pos.fen);
  const result: TbScoreHint['result'] =
    r === 'draw' ? 'draw' : (r === 'win') === (stm === 'white') ? 'white' : 'black';
  const hint: TbScoreHint = {
    result,
    exact50: pos.category !== 'cursed-win' && pos.category !== 'blessed-loss',
  };
  if (pos.dtm !== undefined) {
    hint.dtm = pos.dtm;
    if (result !== 'draw') hint.mateIn = Math.ceil(Math.abs(pos.dtm) / 2);
  }
  if (pos.dtz !== undefined) hint.dtz = pos.dtz;
  return hint;
}

/** Number of pieces on the board, kings and pawns included. */
export function pieceCount(fen: string): number {
  const placement = fen.trim().split(/\s+/)[0] ?? '';
  let n = 0;
  for (const ch of placement) if (/[kqrbnp]/i.test(ch)) n++;
  return n;
}

/**
 * Whether a position can be looked up: a legal FEN (chess.js) with at most 7 pieces and no
 * castling rights (Syzygy has none).
 */
export function tablebaseEligible(fen: string): boolean {
  const fields = fen.trim().split(/\s+/);
  if ((fields[2] ?? '-') !== '-') return false;
  if (pieceCount(fen) > TABLEBASE_MAX_PIECES) return false;
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}
