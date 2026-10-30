import { Chess, type Color, type PieceSymbol, type Square } from 'chess.js';
import type { Score } from '@daisychess/engine-core';
import type { ExplainInput, ExplainRule } from './types';

/**
 * The eight predicates of the explainer (ADR-024 §4), pure functions over chess.js positions and
 * the two engine lines. The work is bounded: at most {@link MAX_LINE_PLIES} plies of a line are
 * replayed, and the attack scans visit at most the 16 squares of one side's units.
 *
 * Lines are replayed with {@link replayBoard}, a board-only replay on chess.js `put`/`remove`
 * with a pseudo-legality check through `attackers()`: chess.js `move()` generates all legal
 * moves three to four times per ply (SAN, check, FEN) — about 0.1 ms each — and the predicates
 * need only material, captures and attacks. The SAN of the one line that is shown is computed
 * with a real chess.js replay afterwards (index.ts), which also cuts an illegal tail.
 */

/** Standard piece values in pawns; the king has no material value. */
export const PIECE_VALUES: Readonly<Record<PieceSymbol, number>> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

/** Plies of a line replayed at most. */
export const MAX_LINE_PLIES = 8;
/** Material swing (pawns) that counts as a loss or gain. */
export const MATERIAL_THRESHOLD = 2;
/** A hanging piece must be taken by this ply of the punishment line (the opponent's 2nd move). */
export const MAX_CAPTURE_PLY = 2;
/** Eval swing (centipawns, mover POV) for `missed_tactic`. */
export const TACTIC_THRESHOLD_CP = 200;

export type Side = 'white' | 'black';

export interface Unit {
  square: Square;
  type: PieceSymbol;
  color: Color;
}

/** A replayed move (board facts only, no SAN). */
export interface LineMove {
  from: Square;
  to: Square;
  color: Color;
  /** The moving unit (a pawn for a promotion). */
  piece: PieceSymbol;
  captured?: PieceSymbol;
  promotion?: PieceSymbol;
  /** `e2e4`, `e7e8q`. */
  lan: string;
}

export interface BoardLine {
  /** Start position. */
  fen: string;
  /** The (pseudo-)legal prefix of the line. */
  moves: LineMove[];
  /** Board after the last replayed move. */
  end: Chess;
  /** Board after the first move (undefined when there is none). */
  first?: Chess;
}

const UCI_RE = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');
export const colorOf = (s: Side): Color => (s === 'white' ? 'w' : 'b');

/** A chess.js board for `fen`, or undefined when the FEN is not valid. */
export function loadFen(fen: string): Chess | undefined {
  try {
    return new Chess(fen);
  } catch {
    return undefined;
  }
}

const fileOf = (sq: Square): number => sq.charCodeAt(0) - 97;
const rankOf = (sq: Square): number => Number(sq[1]);
const squareAt = (file: number, rank: number): Square =>
  `${String.fromCharCode(97 + file)}${rank}` as Square;

/**
 * Plays one UCI move for `turn` on the board of `chess` (mutating it) when it is pseudo-legal:
 * own unit on `from`, no own unit or king on `to`, and `to` reachable (pawn pushes/captures/en
 * passant by geometry, castling with the rook in place, every other move through `attackers()`).
 * King safety is not checked (engine lines are legal; this only stops a stale line). Undefined
 * when the move does not fit the board.
 */
export function applyUci(chess: Chess, uci: string, turn: Color): LineMove | undefined {
  const m = UCI_RE.exec(uci);
  if (!m) return undefined;
  const from = m[1] as Square;
  const to = m[2] as Square;
  const promo = m[3] as PieceSymbol | undefined;
  const unit = chess.get(from);
  if (!unit || unit.color !== turn) return undefined;
  const target = chess.get(to);
  if (target && (target.color === turn || target.type === 'k')) return undefined;
  const df = fileOf(to) - fileOf(from);
  const dr = rankOf(to) - rankOf(from);
  let captured: PieceSymbol | undefined = target?.type;
  let epSquare: Square | undefined;
  let rookFrom: Square | undefined;
  let rookTo: Square | undefined;
  if (unit.type === 'p') {
    const dir = turn === 'w' ? 1 : -1;
    const lastRank = turn === 'w' ? 8 : 1;
    if ((rankOf(to) === lastRank) !== (promo !== undefined)) return undefined;
    if (df === 0) {
      if (target) return undefined;
      const startRank = turn === 'w' ? 2 : 7;
      const two = dr === 2 * dir && rankOf(from) === startRank;
      if (dr !== dir && !two) return undefined;
      if (two && chess.get(squareAt(fileOf(from), rankOf(from) + dir))) return undefined;
    } else {
      if (Math.abs(df) !== 1 || dr !== dir) return undefined;
      if (!target) {
        epSquare = squareAt(fileOf(to), rankOf(from));
        const ep = chess.get(epSquare);
        if (!ep || ep.type !== 'p' || ep.color === turn) return undefined;
        captured = 'p';
      }
    }
  } else if (promo) {
    return undefined;
  } else if (unit.type === 'k' && dr === 0 && Math.abs(df) === 2) {
    rookFrom = squareAt(df > 0 ? 7 : 0, rankOf(from));
    rookTo = squareAt(fileOf(from) + (df > 0 ? 1 : -1), rankOf(from));
    const rook = chess.get(rookFrom);
    if (!rook || rook.type !== 'r' || rook.color !== turn || target) return undefined;
    const lo = Math.min(fileOf(from), fileOf(rookFrom));
    const hi = Math.max(fileOf(from), fileOf(rookFrom));
    for (let f = lo + 1; f < hi; f++) if (chess.get(squareAt(f, rankOf(from)))) return undefined;
  } else if (!chess.attackers(to, turn).includes(from)) {
    return undefined;
  }
  chess.remove(from);
  if (epSquare) chess.remove(epSquare);
  if (rookFrom && rookTo) {
    chess.remove(rookFrom);
    chess.put({ type: 'r', color: turn }, rookTo);
  }
  chess.put({ type: promo ?? unit.type, color: turn }, to);
  return {
    from,
    to,
    color: turn,
    piece: unit.type,
    ...(captured ? { captured } : {}),
    ...(promo ? { promotion: promo } : {}),
    lan: uci,
  };
}

/** Replays at most `max` plies of a UCI line from `fen` on the board (see {@link applyUci}). */
export function replayBoard(
  fen: string,
  line: readonly string[],
  max: number = MAX_LINE_PLIES,
): BoardLine | undefined {
  const chess = loadFen(fen);
  if (!chess) return undefined;
  let turn = chess.turn();
  const moves: LineMove[] = [];
  let first: Chess | undefined;
  for (const uci of line.slice(0, max)) {
    const m = applyUci(chess, uci, turn);
    if (!m) break;
    moves.push(m);
    if (moves.length === 1) first = new Chess(chess.fen(), { skipValidation: true });
    turn = other(turn);
  }
  return { fen, moves, end: chess, ...(first ? { first } : {}) };
}

/** SAN of a UCI line from `fen` with full chess.js legality; stops at the first illegal move. */
export function sanLine(fen: string, line: readonly string[], max = MAX_LINE_PLIES): string[] {
  const chess = loadFen(fen);
  if (!chess) return [];
  const out: string[] = [];
  for (const uci of line.slice(0, max)) {
    const m = UCI_RE.exec(uci);
    if (!m) break;
    try {
      out.push(chess.move({ from: m[1]!, to: m[2]!, promotion: m[3] }).san);
    } catch {
      break;
    }
  }
  return out;
}

/** All units of `color` on the board (≤ 16). */
export function unitsOf(chess: Chess, color: Color): Unit[] {
  const out: Unit[] = [];
  for (const row of chess.board()) {
    for (const cell of row) if (cell && cell.color === color) out.push(cell);
  }
  return out;
}

/** Material of `color` in pawns (1/3/3/5/9; promoted pieces count at their new value). */
export function materialOf(chess: Chess, color: Color): number {
  return unitsOf(chess, color).reduce((sum, u) => sum + PIECE_VALUES[u.type], 0);
}

/** Material balance from `color`'s point of view (own − opponent's), in pawns. */
export function materialBalance(chess: Chess, color: Color): number {
  return materialOf(chess, color) - materialOf(chess, other(color));
}

/** Value of a unit for the "attacked by a lower-valued piece" tests (the king counts highest). */
export const attackerValue = (t: PieceSymbol): number => (t === 'k' ? 100 : PIECE_VALUES[t]);

/**
 * Whether the unit on `square` (of colour `owner`) is en prise: attacked by the opponent and
 * either undefended or attacked by a lower-valued piece. Kings are never en prise here.
 */
export function isEnPrise(chess: Chess, square: Square, owner: Color): boolean {
  const unit = chess.get(square);
  if (!unit || unit.color !== owner || unit.type === 'k') return false;
  const attackers = chess.attackers(square, other(owner));
  if (attackers.length === 0) return false;
  const defenders = chess.attackers(square, owner);
  if (defenders.length === 0) return true;
  const cheapest = Math.min(...attackers.map((sq) => attackerValue(chess.get(sq)?.type ?? 'k')));
  return cheapest < PIECE_VALUES[unit.type];
}

/** Mate distance from the mover's point of view (positive = the mover mates), or null. */
export function moverMate(s: Score, mover: Side): number | null {
  if (!('mate' in s)) return null;
  return mover === 'white' ? s.mate : -s.mate;
}

/** Centipawns from the mover's point of view, or null for a mate score. */
export function moverCp(s: Score, mover: Side): number | null {
  if (!('cp' in s)) return null;
  return mover === 'white' ? s.cp : -s.cp;
}

/** Units of `color` lost between two positions, by type, most valuable first. */
export function unitsLost(from: Chess, to: Chess, color: Color): PieceSymbol[] {
  const count = (c: Chess): Map<PieceSymbol, number> => {
    const m = new Map<PieceSymbol, number>();
    for (const u of unitsOf(c, color)) m.set(u.type, (m.get(u.type) ?? 0) + 1);
    return m;
  };
  const a = count(from);
  const b = count(to);
  const lost: PieceSymbol[] = [];
  for (const t of ['q', 'r', 'b', 'n', 'p'] as const) {
    for (let i = (a.get(t) ?? 0) - (b.get(t) ?? 0); i > 0; i--) lost.push(t);
  }
  return lost;
}

/** Everything the predicates look at, computed once per explanation. */
export interface RuleContext {
  mover: Side;
  moverColor: Color;
  oppColor: Color;
  before: Chess;
  after: Chess;
  /** The played move on the board of `fenBefore` (undefined when it does not fit). */
  played?: LineMove;
  /** Engine's best line from `fenBefore` (`detail.bestLine`, ≤ 8 plies). */
  best: BoardLine;
  /** The punishment line from `fenAfter` (`reply.bestLine`, ≤ 8 plies). */
  punish: BoardLine;
  evalBefore: Score;
  evalAfter: Score;
  /** Eval after the best move (White POV); `evalBefore` when unknown. */
  evalIfBest: Score;
  /** Material balance (mover POV) before the move. */
  balanceBefore: number;
}

/** The engine line of a detail: `bestLine`, else the lone best move. */
export const lineOf = (d: { bestUci?: string; bestLine: readonly string[] }): readonly string[] =>
  d.bestLine.length > 0 ? d.bestLine : d.bestUci ? [d.bestUci] : [];

/** Builds the context; undefined when the positions cannot be read. */
export function buildContext(input: ExplainInput): RuleContext | undefined {
  const { detail, reply } = input;
  const before = loadFen(detail.fenBefore);
  const after = loadFen(detail.fenAfter);
  const best = replayBoard(detail.fenBefore, lineOf(detail));
  const punish = replayBoard(detail.fenAfter, reply ? lineOf(reply) : []);
  if (!before || !after || !best || !punish) return undefined;
  const moverColor = colorOf(detail.mover);
  const played = applyUci(new Chess(detail.fenBefore), detail.playedUci, moverColor);
  return {
    mover: detail.mover,
    moverColor,
    oppColor: other(moverColor),
    before,
    after,
    ...(played ? { played } : {}),
    best,
    punish,
    evalBefore: detail.evalBeforeWhite,
    evalAfter: detail.evalAfterWhite,
    evalIfBest: detail.evalIfBest ?? detail.evalBeforeWhite,
    balanceBefore: materialBalance(before, moverColor),
  };
}

// ---------------------------------------------------------------------------------------------
// Findings: what a rule found, the data the wording turns into sentences.

export type Finding =
  | { rule: 'mate_allowed'; mateIn: number }
  | { rule: 'mate_missed'; mateIn: number }
  | {
      rule: 'piece_hangs';
      square: Square;
      piece: PieceSymbol;
      /** The hanging unit is the one that just moved. */
      moved: boolean;
      /** It was already en prise on that square before the move (and was not the moved unit). */
      alreadyHanging: boolean;
      /** Index in the punishment line of the move that captures it. */
      capturePly: number;
    }
  | {
      rule: 'fork_allowed';
      /** The forking move (first ply of the punishment line). */
      fork: LineMove;
      /** The two most valuable forked units (king first). */
      targets: Unit[];
    }
  | {
      rule: 'material_lost';
      /** Pawns lost (positive). */
      loss: number;
      /** Set when exactly one unit of the mover disappears and it is not a pawn. */
      piece?: PieceSymbol;
    }
  | {
      rule: 'missed_capture';
      capture: LineMove;
      /** The captured unit is undefended before the move and the line keeps it. */
      free: boolean;
      /** Material gain (pawns) at the end of the best line. */
      gain: number;
    }
  | { rule: 'missed_tactic'; gainCp: number }
  | { rule: 'eval_drop' };

/** Material change (mover POV, pawns) from before the move to the end of a line. */
const deltaAt = (ctx: RuleContext, line: BoardLine): number =>
  materialBalance(line.end, ctx.moverColor) - ctx.balanceBefore;

/** Rule 1: the move allows a forced mate that was not there before. */
export function mateAllowed(ctx: RuleContext): Finding | undefined {
  const ma = moverMate(ctx.evalAfter, ctx.mover);
  const mb = moverMate(ctx.evalBefore, ctx.mover);
  if (ma === null || ma >= 0) return undefined;
  if (mb !== null && mb < 0) return undefined;
  return { rule: 'mate_allowed', mateIn: -ma };
}

/** Rule 2: there was a forced mate for the mover and the move lets it go. */
export function mateMissed(ctx: RuleContext): Finding | undefined {
  const mb = moverMate(ctx.evalBefore, ctx.mover);
  const ma = moverMate(ctx.evalAfter, ctx.mover);
  if (mb === null || mb <= 0) return undefined;
  if (ma !== null && ma > 0) return undefined;
  if ('mate' in ctx.evalAfter && ctx.evalAfter.mate === 0) return undefined; // delivered mate
  return { rule: 'mate_missed', mateIn: mb };
}

/**
 * Index of the punishment-line ply that captures the unit standing on `square`; undefined when
 * the line never takes it there (or the mover moves it away first).
 */
function capturePlyOf(ctx: RuleContext, square: Square): number | undefined {
  for (let i = 0; i < ctx.punish.moves.length; i++) {
    const m = ctx.punish.moves[i]!;
    if (m.color === ctx.moverColor) {
      if (m.from === square) return undefined;
    } else if (m.to === square && m.captured) {
      return i;
    }
  }
  return undefined;
}

/** Rule 3: a unit of the mover stands en prise after the move and the punishment line takes it. */
export function pieceHangs(ctx: RuleContext): Finding | undefined {
  if (ctx.punish.moves.length === 0) return undefined;
  const loss = -deltaAt(ctx, ctx.punish);
  let found: Extract<Finding, { rule: 'piece_hangs' }> | undefined;
  for (const u of unitsOf(ctx.after, ctx.moverColor)) {
    if (u.type === 'k') continue;
    // A pawn only counts when the line confirms at least its value; a piece needs the threshold.
    if (loss < (u.type === 'p' ? 1 : MATERIAL_THRESHOLD)) continue;
    // Taken by the opponent's next move (a pawn) or within its next two moves (a piece).
    const capturePly = capturePlyOf(ctx, u.square);
    if (capturePly === undefined || capturePly > (u.type === 'p' ? 0 : MAX_CAPTURE_PLY)) continue;
    if (!isEnPrise(ctx.after, u.square, ctx.moverColor)) continue;
    const moved = ctx.played?.to === u.square;
    const sameBefore = ctx.before.get(u.square);
    const alreadyHanging =
      !moved &&
      sameBefore?.color === u.color &&
      sameBefore.type === u.type &&
      isEnPrise(ctx.before, u.square, ctx.moverColor);
    const better =
      !found ||
      capturePly < found.capturePly ||
      (capturePly === found.capturePly && PIECE_VALUES[u.type] > PIECE_VALUES[found.piece]);
    if (better) {
      found = {
        rule: 'piece_hangs',
        square: u.square,
        piece: u.type,
        moved,
        alreadyHanging,
        capturePly,
      };
    }
  }
  return found;
}

/** Rule 4: the opponent's best reply attacks two valuable units at once. */
export function forkAllowed(ctx: RuleContext): Finding | undefined {
  const fork = ctx.punish.moves[0];
  const pos = ctx.punish.first;
  if (!fork || !pos) return undefined;
  const forkerValue = attackerValue(fork.promotion ?? fork.piece);
  const targets: Unit[] = [];
  for (const u of unitsOf(pos, ctx.moverColor)) {
    if (u.type !== 'k' && PIECE_VALUES[u.type] < 3) continue;
    if (!pos.attackers(u.square, ctx.oppColor).includes(fork.to)) continue;
    const loose =
      u.type === 'k' ||
      PIECE_VALUES[u.type] > forkerValue ||
      pos.attackers(u.square, ctx.moverColor).length === 0;
    if (loose) targets.push(u);
  }
  if (targets.length < 2) return undefined;
  // Not a fork when the forking unit can simply be taken: it must be unattacked, or defended
  // and attacked only by units worth at least as much.
  const takers = pos.attackers(fork.to, ctx.moverColor);
  if (takers.length > 0) {
    const defended = pos.attackers(fork.to, ctx.oppColor).length > 0;
    const cheapest = Math.min(...takers.map((sq) => attackerValue(pos.get(sq)?.type ?? 'k')));
    if (!defended || cheapest < forkerValue) return undefined;
  }
  targets.sort((a, b) => attackerValue(b.type) - attackerValue(a.type));
  return { rule: 'fork_allowed', fork, targets: targets.slice(0, 2) };
}

const hasMate = (ctx: RuleContext): boolean => 'mate' in ctx.evalBefore || 'mate' in ctx.evalAfter;

/** Rule 5: the punishment line ends ≥ 2 pawns down compared with before the move. */
export function materialLost(ctx: RuleContext): Finding | undefined {
  if (hasMate(ctx) || ctx.punish.moves.length === 0) return undefined;
  const loss = -deltaAt(ctx, ctx.punish);
  if (loss < MATERIAL_THRESHOLD) return undefined;
  const lost = unitsLost(ctx.before, ctx.punish.end, ctx.moverColor);
  const piece = lost.length === 1 && lost[0] !== 'p' ? lost[0] : undefined;
  return { rule: 'material_lost', loss, ...(piece ? { piece } : {}) };
}

/** Rule 6: the best move is a capture that wins material. */
export function missedCapture(ctx: RuleContext): Finding | undefined {
  const capture = ctx.best.moves[0];
  if (!capture?.captured || capture.lan === ctx.played?.lan) return undefined;
  const gain = deltaAt(ctx, ctx.best);
  // Undefended, and the line does not win it back.
  const free = gain >= 1 && ctx.before.attackers(capture.to, ctx.oppColor).length === 0;
  if (gain < MATERIAL_THRESHOLD && !free) return undefined;
  return { rule: 'missed_capture', capture, free, gain };
}

/** Rule 7: a quiet best move that is worth ≥ 2 pawns more than the played one. */
export function missedTactic(ctx: RuleContext): Finding | undefined {
  const first = ctx.best.moves[0];
  if (!first || first.captured || first.lan === ctx.played?.lan) return undefined;
  const ifBest = moverCp(ctx.evalIfBest, ctx.mover);
  const after = moverCp(ctx.evalAfter, ctx.mover);
  if (ifBest === null || after === null) return undefined;
  const gainCp = ifBest - after;
  return gainCp >= TACTIC_THRESHOLD_CP ? { rule: 'missed_tactic', gainCp } : undefined;
}

/** Predicates in priority order; `eval_drop` is the default. */
export const RULES: readonly [ExplainRule, (ctx: RuleContext) => Finding | undefined][] = [
  ['mate_allowed', mateAllowed],
  ['mate_missed', mateMissed],
  ['piece_hangs', pieceHangs],
  ['fork_allowed', forkAllowed],
  ['material_lost', materialLost],
  ['missed_capture', missedCapture],
  ['missed_tactic', missedTactic],
];

/** The first rule that applies. */
export function findRule(ctx: RuleContext): Finding {
  for (const [, predicate] of RULES) {
    const f = predicate(ctx);
    if (f) return f;
  }
  return { rule: 'eval_drop' };
}
