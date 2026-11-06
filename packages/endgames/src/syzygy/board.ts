/*
 * Syzygy tablebase reader for DaisyChess — a minimal position for probing.
 *
 * Part of the TypeScript port of python-chess's Syzygy probing (`chess/syzygy.py`, GPL-3.0-or-later;
 * see `tablebase.ts` for the full notice). python-chess probes on its own `chess.Board`; the
 * recursive capture resolution and the DTZ search make thousands of move generations per probed
 * position, which chess.js (SAN and FEN for every generated move) is too slow for. This board
 * implements exactly what the probing needs — legal moves without castling, make/unmake, check
 * detection and the piece lists — and is checked against chess.js move generation by
 * `board.test.ts`. chess.js stays the source of truth for FEN validation, SAN and the per-move
 * data of `SyzygyTables.probePosition`.
 */

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

/** 0 = White, 1 = Black (python-chess: WHITE = True; the Syzygy encoding uses 0 = White). */
export type Color = 0 | 1;

/** Square index a1 = 0 … h8 = 63 (python-chess numbering). */
export type Square = number;

// Move encoding: from | to << 6 | promotion piece type << 12 | flags << 15.
const F_CAPTURE = 1;
const F_EP = 2;
const F_DOUBLE = 4;

export const moveFrom = (m: number): Square => m & 63;
export const moveTo = (m: number): Square => (m >> 6) & 63;
export const movePromotion = (m: number): number => (m >> 12) & 7;
/** Capture (en passant included). */
export const isCaptureMove = (m: number): boolean => ((m >> 15) & F_CAPTURE) !== 0;
export const isEnPassantMove = (m: number): boolean => ((m >> 15) & F_EP) !== 0;

const encode = (from: number, to: number, promo: number, flags: number): number =>
  from | (to << 6) | (promo << 12) | (flags << 15);

const fileOf = (s: number): number => s & 7;
const rankOf = (s: number): number => s >> 3;

function stepTargets(deltas: Array<[number, number]>): number[][] {
  const out: number[][] = [];
  for (let s = 0; s < 64; s++) {
    const list: number[] = [];
    for (const [df, dr] of deltas) {
      const f = fileOf(s) + df;
      const r = rankOf(s) + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8) list.push(r * 8 + f);
    }
    out.push(list);
  }
  return out;
}

const KNIGHT_TARGETS = stepTargets([
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
]);
const KING_TARGETS = stepTargets([
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]);

function rays(dirs: Array<[number, number]>): number[][][] {
  const out: number[][][] = [];
  for (let s = 0; s < 64; s++) {
    const perSquare: number[][] = [];
    for (const [df, dr] of dirs) {
      const ray: number[] = [];
      let f = fileOf(s) + df;
      let r = rankOf(s) + dr;
      while (f >= 0 && f < 8 && r >= 0 && r < 8) {
        ray.push(r * 8 + f);
        f += df;
        r += dr;
      }
      perSquare.push(ray);
    }
    out.push(perSquare);
  }
  return out;
}

const ROOK_RAYS = rays([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]);
const BISHOP_RAYS = rays([
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]);

const PIECE_LETTERS = ' pnbrqk';

export class TbBoardError extends Error {}

/** A legal chess position without castling rights. Mutable; `push`/`pop` like python-chess. */
export class TbBoard {
  /** 0 = empty, else piece type | color << 3. */
  readonly sq = new Int8Array(64);
  turn: Color = 0;
  /** En passant target square (behind a pawn that just made a double step), or -1. */
  ep: Square = -1;
  halfmove = 0;
  private readonly undo: number[] = [];

  /**
   * Parses a FEN. Throws `TbBoardError` for castling rights, a wrong number of kings, pawns on
   * the first or last rank, or the side not to move being in check.
   */
  static fromFen(fen: string): TbBoard {
    const fields = fen.trim().split(/\s+/);
    const [placement, turn = 'w', castling = '-', ep = '-', half = '0'] = fields;
    if (!placement) throw new TbBoardError('empty FEN');
    const b = new TbBoard();
    const ranks = placement.split('/');
    if (ranks.length !== 8) throw new TbBoardError(`bad placement: ${placement}`);
    ranks.forEach((rank, i) => {
      const r = 7 - i;
      let f = 0;
      for (const ch of rank) {
        if (ch >= '1' && ch <= '8') {
          f += Number(ch);
          continue;
        }
        const type = PIECE_LETTERS.indexOf(ch.toLowerCase());
        if (type <= 0 || f > 7) throw new TbBoardError(`bad placement: ${placement}`);
        const color = ch === ch.toLowerCase() ? 1 : 0;
        b.sq[r * 8 + f] = type | (color << 3);
        f++;
      }
      if (f !== 8) throw new TbBoardError(`bad placement: ${placement}`);
    });
    if (turn !== 'w' && turn !== 'b') throw new TbBoardError(`bad side to move: ${turn}`);
    b.turn = turn === 'w' ? 0 : 1;
    if (castling !== '-') throw new TbBoardError('castling rights are not in the tablebases');
    const kings = [0, 0];
    for (let s = 0; s < 64; s++) {
      const p = b.sq[s]!;
      if ((p & 7) === KING) kings[p >> 3]!++;
      if ((p & 7) === PAWN && (rankOf(s) === 0 || rankOf(s) === 7)) {
        throw new TbBoardError('pawn on the first or last rank');
      }
    }
    if (kings[0] !== 1 || kings[1] !== 1) throw new TbBoardError('need exactly one king each');
    if (ep !== '-') {
      const s = squareOf(ep);
      const expectedRank = b.turn === 0 ? 5 : 2;
      if (s < 0 || rankOf(s) !== expectedRank) throw new TbBoardError(`bad en passant: ${ep}`);
      // Only meaningful when the double-stepped pawn is there; else ignore it like a lenient GUI.
      const pawnSq = b.turn === 0 ? s - 8 : s + 8;
      if (b.sq[pawnSq] === (PAWN | ((1 - b.turn) << 3)) && b.sq[s] === 0) b.ep = s;
    }
    const hm = Number(half);
    b.halfmove = Number.isInteger(hm) && hm >= 0 ? hm : 0;
    if (b.isAttacked(b.kingSquare((1 - b.turn) as Color), b.turn)) {
      throw new TbBoardError('the side not to move is in check');
    }
    return b;
  }

  kingSquare(color: Color): Square {
    const k = KING | (color << 3);
    for (let s = 0; s < 64; s++) if (this.sq[s] === k) return s;
    return -1;
  }

  /** Squares of `type` and `color`, ascending (python-chess `scan_forward(pieces_mask(…))`). */
  squares(type: number, color: Color): Square[] {
    const p = type | (color << 3);
    const out: Square[] = [];
    for (let s = 0; s < 64; s++) if (this.sq[s] === p) out.push(s);
    return out;
  }

  pieceCount(): number {
    let n = 0;
    for (let s = 0; s < 64; s++) if (this.sq[s] !== 0) n++;
    return n;
  }

  /** Only the two kings left. */
  onlyKings(): boolean {
    for (let s = 0; s < 64; s++) {
      const p = this.sq[s]!;
      if (p !== 0 && (p & 7) !== KING) return false;
    }
    return true;
  }

  /** Material key with White first (python-chess `calc_key`), e.g. `KRPvKR`. */
  key(mirror = false): string {
    const counts = [new Array<number>(7).fill(0), new Array<number>(7).fill(0)];
    for (let s = 0; s < 64; s++) {
      const p = this.sq[s]!;
      if (p !== 0) counts[p >> 3]![p & 7]!++;
    }
    const side = (c: number[]): string =>
      'K'.repeat(c[KING]!) +
      'Q'.repeat(c[QUEEN]!) +
      'R'.repeat(c[ROOK]!) +
      'B'.repeat(c[BISHOP]!) +
      'N'.repeat(c[KNIGHT]!) +
      'P'.repeat(c[PAWN]!);
    const w = side(counts[mirror ? 1 : 0]!);
    const b = side(counts[mirror ? 0 : 1]!);
    return `${w}v${b}`;
  }

  /** Whether `s` is attacked by a piece of `by`. */
  isAttacked(s: Square, by: Color): boolean {
    if (s < 0) return false;
    const sq = this.sq;
    const f = fileOf(s);
    if (by === 0) {
      if (f < 7 && s - 7 >= 0 && sq[s - 7] === PAWN) return true;
      if (f > 0 && s - 9 >= 0 && sq[s - 9] === PAWN) return true;
    } else {
      const bp = PAWN | 8;
      if (f > 0 && s + 7 < 64 && sq[s + 7] === bp) return true;
      if (f < 7 && s + 9 < 64 && sq[s + 9] === bp) return true;
    }
    const c = by << 3;
    for (const t of KNIGHT_TARGETS[s]!) if (sq[t] === (KNIGHT | c)) return true;
    for (const t of KING_TARGETS[s]!) if (sq[t] === (KING | c)) return true;
    for (const ray of ROOK_RAYS[s]!) {
      for (const t of ray) {
        const p = sq[t]!;
        if (p === 0) continue;
        if (p === (ROOK | c) || p === (QUEEN | c)) return true;
        break;
      }
    }
    for (const ray of BISHOP_RAYS[s]!) {
      for (const t of ray) {
        const p = sq[t]!;
        if (p === 0) continue;
        if (p === (BISHOP | c) || p === (QUEEN | c)) return true;
        break;
      }
    }
    return false;
  }

  isCheck(): boolean {
    return this.isAttacked(this.kingSquare(this.turn), (1 - this.turn) as Color);
  }

  private pseudoLegal(out: number[]): void {
    const sq = this.sq;
    const us = this.turn;
    const them = 1 - us;
    for (let from = 0; from < 64; from++) {
      const p = sq[from]!;
      if (p === 0 || p >> 3 !== us) continue;
      const type = p & 7;
      if (type === PAWN) {
        const dir = us === 0 ? 8 : -8;
        const lastRank = us === 0 ? 7 : 0;
        const startRank = us === 0 ? 1 : 6;
        const add = (to: number, flags: number): void => {
          if (rankOf(to) === lastRank) {
            for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT])
              out.push(encode(from, to, promo, flags));
          } else {
            out.push(encode(from, to, 0, flags));
          }
        };
        const one = from + dir;
        if (sq[one] === 0) {
          add(one, 0);
          const two = one + dir;
          if (rankOf(from) === startRank && sq[two] === 0) out.push(encode(from, two, 0, F_DOUBLE));
        }
        for (const df of [-1, 1]) {
          const f = fileOf(from) + df;
          if (f < 0 || f > 7) continue;
          const to = one + df;
          const q = sq[to]!;
          if (q !== 0 && q >> 3 === them) add(to, F_CAPTURE);
          else if (to === this.ep && q === 0) out.push(encode(from, to, 0, F_CAPTURE | F_EP));
        }
      } else if (type === KNIGHT || type === KING) {
        for (const to of (type === KNIGHT ? KNIGHT_TARGETS : KING_TARGETS)[from]!) {
          const q = sq[to]!;
          if (q === 0) out.push(encode(from, to, 0, 0));
          else if (q >> 3 === them) out.push(encode(from, to, 0, F_CAPTURE));
        }
      } else {
        const sets =
          type === ROOK
            ? [ROOK_RAYS[from]!]
            : type === BISHOP
              ? [BISHOP_RAYS[from]!]
              : [ROOK_RAYS[from]!, BISHOP_RAYS[from]!];
        for (const set of sets) {
          for (const ray of set) {
            for (const to of ray) {
              const q = sq[to]!;
              if (q === 0) {
                out.push(encode(from, to, 0, 0));
                continue;
              }
              if (q >> 3 === them) out.push(encode(from, to, 0, F_CAPTURE));
              break;
            }
          }
        }
      }
    }
  }

  /** Legal moves (encoded numbers; see `moveFrom`, `moveTo`, `movePromotion`). */
  legalMoves(): number[] {
    const pseudo: number[] = [];
    this.pseudoLegal(pseudo);
    const us = this.turn;
    const legal: number[] = [];
    for (const m of pseudo) {
      this.push(m);
      if (!this.isAttacked(this.kingSquare(us), this.turn)) legal.push(m);
      this.pop();
    }
    return legal;
  }

  /** Whether the move moves a pawn. */
  isPawnMove(m: number): boolean {
    return ((this.sq[moveFrom(m)] ?? 0) & 7) === PAWN;
  }

  /** Capture or pawn move (resets the 50-move counter). */
  isZeroing(m: number): boolean {
    return isCaptureMove(m) || this.isPawnMove(m);
  }

  push(m: number): void {
    const from = moveFrom(m);
    const to = moveTo(m);
    const promo = movePromotion(m);
    const flags = m >> 15;
    const sq = this.sq;
    const piece = sq[from]!;
    let captured: number;
    let capSq = to;
    if (flags & F_EP) {
      capSq = this.turn === 0 ? to - 8 : to + 8;
      captured = sq[capSq]!;
      sq[capSq] = 0;
    } else {
      captured = sq[to]!;
    }
    // Undo record: move, captured piece, previous ep (+1), previous halfmove clock.
    this.undo.push(m, captured, this.ep + 1, this.halfmove);
    sq[to] = promo ? promo | (this.turn << 3) : piece;
    sq[from] = 0;
    this.halfmove = captured !== 0 || (piece & 7) === PAWN ? 0 : this.halfmove + 1;
    this.ep = flags & F_DOUBLE ? (from + to) >> 1 : -1;
    this.turn = (1 - this.turn) as Color;
  }

  pop(): void {
    const halfmove = this.undo.pop()!;
    const ep = this.undo.pop()! - 1;
    const captured = this.undo.pop()!;
    const m = this.undo.pop()!;
    this.turn = (1 - this.turn) as Color;
    this.halfmove = halfmove;
    this.ep = ep;
    const from = moveFrom(m);
    const to = moveTo(m);
    const sq = this.sq;
    const moved = movePromotion(m) ? PAWN | (this.turn << 3) : sq[to]!;
    sq[from] = moved;
    if ((m >> 15) & F_EP) {
      sq[to] = 0;
      sq[this.turn === 0 ? to - 8 : to + 8] = captured;
    } else {
      sq[to] = captured;
    }
  }

  /** UCI of an encoded move (`e7e8q`). */
  static uci(m: number): string {
    const name = (s: number): string => 'abcdefgh'[fileOf(s)]! + String(rankOf(s) + 1);
    const promo = movePromotion(m);
    return name(moveFrom(m)) + name(moveTo(m)) + (promo ? PIECE_LETTERS[promo]! : '');
  }
}

function squareOf(name: string): Square {
  if (!/^[a-h][1-8]$/.test(name)) return -1;
  return (name.charCodeAt(1) - 49) * 8 + (name.charCodeAt(0) - 97);
}
