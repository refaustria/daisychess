/*
 * Syzygy tablebase reader for DaisyChess — probing (WDL, DTZ, per-move results).
 *
 * Derived from python-chess (`chess/syzygy.py`: `Tablebase.probe_ab`, `probe_wdl`,
 * `probe_dtz_no_ep`, `probe_dtz`), Copyright (C) 2012-2024 Niklas Fiekas
 * <niklas.fiekas@backscattering.de>, itself a port of Ronald de Man's probing code
 * (https://github.com/syzygy1/tb). This file and the rest of `src/syzygy/` are licensed under the
 * GNU General Public License, version 3 or (at your option) any later version; see LICENSE in the
 * repository root and THIRD_PARTY_NOTICES.md.
 *
 * Changes (2026, the DaisyChess authors): TypeScript port for standard chess only (no variants,
 * no antichess threat search); tables are added as in-memory bytes instead of a directory;
 * missing tables raise `MissingTableError`; `KBvK`/`KNvK` are drawn without a table; the DTZ
 * search tracks DTZ rounding like shakmaty-syzygy, and `probePosition` builds the `TbPosition`
 * of ADR-025 with lichess's 50-move categories (lila-tablebase `PartialPositionInfo::with_dtc`).
 */

import { Chess } from 'chess.js';
import type { TbCategory, TbMove, TbPosition, TablebaseProbe } from '../tablebase/types.js';
import { TbBoard, TbBoardError, isCaptureMove, isEnPassantMove } from './board.js';
import { DRAWN_WITHOUT_TABLE, isTableName, normalizeTableName, requiredTables } from './names.js';
import { DtzTable, TBPIECES, WdlTable } from './table.js';
import { WDL_TO_DTZ } from './constants.js';

/** WDL value for the side to move: 2 win, 1 cursed win, 0 draw, -1 blessed loss, -2 loss. */
export type Wdl = -2 | -1 | 0 | 1 | 2;

export type TableKind = 'wdl' | 'dtz';

/** A table needed for the probe is not loaded. */
export class MissingTableError extends Error {
  constructor(
    readonly table: string,
    readonly kind: TableKind,
  ) {
    super(`missing ${kind} table ${table}`);
    this.name = 'MissingTableError';
  }
}

/** DTZ with the rounding flag (true: the value may be one ply off, as in shakmaty-syzygy). */
interface Dtz {
  v: number;
  rounded: boolean;
}

const precise = (v: number): Dtz => ({ v, rounded: false });

function dtzBeforeZeroing(wdl: number): number {
  return Math.sign(wdl) * (Math.abs(wdl) === 2 ? 1 : 101);
}

const WDL_CATEGORY: Record<number, TbCategory> = {
  [-2]: 'loss',
  [-1]: 'blessed-loss',
  0: 'draw',
  1: 'cursed-win',
  2: 'win',
};

/** Category from a DTZ (plies, counter reset) once `halfmoves` have passed (shakmaty `Wdl::from_dtz`). */
function categoryFromDtz(dtz: number): TbCategory {
  if (dtz < -100) return 'blessed-loss';
  if (dtz < 0) return 'loss';
  if (dtz === 0) return 'draw';
  if (dtz <= 100) return 'win';
  return 'cursed-win';
}

/**
 * Lichess's category of a position (lila-tablebase `PartialPositionInfo::with_dtc` with shakmaty
 * `AmbiguousWdl::from_dtz_and_halfmoves`): with a DTZ, the 50-move counter decides between a win
 * and a cursed win (a rounded DTZ of exactly 100 is lichess's `syzygy-win`, which
 * `normalizeLichess` folds into `win`, as `categoryFromDtz` does). Without a DTZ the WDL decides,
 * which assumes a fresh 50-move counter (python-chess `probe_wdl`).
 */
function lichessCategory(
  wdl: Wdl,
  dtz: Dtz | undefined,
  halfmoves: number,
  halfmovesBefore: number,
  mated: boolean,
): TbCategory {
  if (mated) return halfmovesBefore < 100 ? 'loss' : 'blessed-loss';
  if (wdl === 0 || (dtz && dtz.v === 0)) return 'draw';
  if (!dtz) return WDL_CATEGORY[wdl]!;
  if (halfmovesBefore >= 100) return dtz.v < 0 ? 'blessed-loss' : 'cursed-win';
  if (halfmoves === 0) return WDL_CATEGORY[wdl]!;
  return categoryFromDtz(dtz.v > 0 ? dtz.v + halfmoves : dtz.v - halfmoves);
}

const TABLE_FILE = /^([KQRBNPv]+)\.(rtbw|rtbz)$/;

/**
 * In-memory Syzygy tables (WDL `.rtbw`, DTZ `.rtbz`) and the probes of ADR-025 §2. Pure: no I/O,
 * no DOM; the caller adds the table bytes (the web Worker, Node tests). Probing a position needs
 * the tables of its material and of everything reachable by captures and promotions
 * (`requiredTables`); `KBvK` and `KNvK` need none.
 */
export class SyzygyTables implements TablebaseProbe {
  private readonly wdl = new Map<string, WdlTable>();
  private readonly dtz = new Map<string, DtzTable>();

  /**
   * Adds a table file, e.g. `addTable('KQvK.rtbw', bytes)`. The bytes are kept (not copied).
   * Throws for a file name that is not a canonical table name and for a file that is not a
   * Syzygy table (size and magic; the rest of the header is parsed on the first probe).
   */
  addTable(fileName: string, bytes: Uint8Array): void {
    const m = TABLE_FILE.exec(fileName);
    if (!m || !isTableName(m[1]!)) throw new Error(`not a Syzygy table file name: ${fileName}`);
    const name = m[1]!;
    if (m[2] === 'rtbw') {
      const table = new WdlTable(name, bytes);
      this.wdl.set(table.key, table);
      this.wdl.set(table.mirroredKey, table);
    } else {
      const table = new DtzTable(name, bytes);
      this.dtz.set(table.key, table);
      this.dtz.set(table.mirroredKey, table);
    }
  }

  /** Whether the table file of `materialKey` (either side order) is loaded. */
  has(materialKey: string, kind: TableKind): boolean {
    return (kind === 'wdl' ? this.wdl : this.dtz).has(normalizeTableName(materialKey));
  }

  /**
   * The table files probing positions of `materialKey` would need but are not loaded:
   * WDL of the whole capture/promotion closure, plus the material's own DTZ for `kind: 'dtz'`.
   */
  missing(materialKey: string, kind: TableKind = 'wdl'): string[] {
    const out = requiredTables(materialKey)
      .filter((n) => !this.has(n, 'wdl'))
      .map((n) => `${n}.rtbw`);
    const own = normalizeTableName(materialKey);
    if (kind === 'dtz' && !DRAWN_WITHOUT_TABLE.has(own) && !this.has(own, 'dtz')) {
      out.push(`${own}.rtbz`);
    }
    return out;
  }

  /**
   * WDL of `fen` for the side to move, assuming the position was reached by a capture or pawn
   * move (python-chess `probe_wdl`). Throws `MissingTableError`, or `TbBoardError` for an
   * invalid FEN, castling rights or more than 7 pieces.
   */
  probeWdl(fen: string): Wdl {
    return this.wdlOf(this.board(fen));
  }

  /**
   * DTZ50'' of `fen` in plies (python-chess `probe_dtz`): positive when the side to move wins,
   * 0 for a draw; null when a needed DTZ table is missing. Precise with the unrounded `dtz-nr`
   * tables of the manifest; with the original rounded tables it can be one ply off, as
   * python-chess documents. Throws like `probeWdl` when a WDL table is missing.
   */
  probeDtz(fen: string): number | null {
    const board = this.board(fen);
    try {
      return this.dtzOf(board).v;
    } catch (e) {
      if (e instanceof MissingTableError && e.kind === 'dtz') return null;
      throw e;
    }
  }

  /**
   * The position with the result of every legal move, in the shape of the lichess API
   * (`TbPosition`; `dtz` only where the material's DTZ table is loaded, never `dtm`). Null when
   * the FEN is invalid or has castling rights or more than 7 pieces, or when a needed WDL table
   * is missing. Categories follow lichess, 50-move counter included, where the DTZ is known;
   * from WDL-only tables they assume a fresh counter (a cursed win can then show as `win`
   * when the FEN's halfmove clock is high). Corrupt table bytes throw (`SyzygyFormatError`,
   * `RangeError`); the manifest's sha256 check before `addTable` rules that out.
   */
  probePosition(fen: string): TbPosition | null {
    let chess: Chess;
    let board: TbBoard;
    try {
      chess = new Chess(fen);
      board = this.board(fen);
    } catch {
      return null;
    }
    try {
      const sans = new Map<string, string>();
      for (const m of chess.moves({ verbose: true })) sans.set(m.lan, m.san);

      const moves: TbMove[] = [];
      const legal = board.legalMoves();
      for (const m of legal) {
        const uci = TbBoard.uci(m);
        const zeroing = board.isZeroing(m);
        const halfBefore = board.halfmove;
        board.push(m);
        try {
          const childMoves = board.legalMoves().length;
          const check = board.isCheck();
          const info = this.info(board, childMoves === 0 && check);
          const category = lichessCategory(
            info.wdl,
            info.dtz,
            board.halfmove,
            halfBefore,
            info.mated,
          );
          const move: TbMove = {
            uci,
            san: sans.get(uci) ?? uci,
            category: childMoves === 0 && !check ? 'draw' : category,
            zeroing,
            checkmate: childMoves === 0 && check,
            stalemate: childMoves === 0 && !check,
          };
          if (info.dtz) move.dtz = info.dtz.v;
          moves.push(move);
        } finally {
          board.pop();
        }
      }

      const mated = legal.length === 0 && board.isCheck();
      const info = this.info(board, mated);
      let category: TbCategory;
      if (legal.length === 0 && !mated) category = 'draw';
      else
        category = lichessCategory(
          info.wdl,
          info.dtz,
          board.halfmove,
          Math.max(0, board.halfmove - 1),
          mated,
        );
      const pos: TbPosition = { fen, category, moves };
      if (info.dtz) pos.dtz = info.dtz.v;
      return pos;
    } catch (e) {
      if (e instanceof MissingTableError) return null;
      throw e;
    }
  }

  /** `TablebaseProbe`: `probePosition` as a promise (the local source of ADR-025 §2). */
  probe(fen: string): Promise<TbPosition | null> {
    return Promise.resolve(this.probePosition(fen));
  }

  // ---- internals -------------------------------------------------------------------------

  private board(fen: string): TbBoard {
    const board = TbBoard.fromFen(fen);
    if (board.pieceCount() > TBPIECES) {
      throw new TbBoardError(`syzygy tables support up to ${TBPIECES} pieces`);
    }
    return board;
  }

  /** WDL and, when the material's DTZ table is loaded, the DTZ of `board`. */
  private info(board: TbBoard, mated: boolean): { wdl: Wdl; dtz?: Dtz; mated: boolean } {
    const wdl = this.wdlOf(board);
    const key = board.key();
    if (
      !this.dtz.has(key) &&
      !DRAWN_WITHOUT_TABLE.has(normalizeTableName(key)) &&
      !board.onlyKings()
    ) {
      return { wdl, mated };
    }
    try {
      return { wdl, dtz: this.dtzOf(board), mated };
    } catch (e) {
      if (e instanceof MissingTableError && e.kind === 'dtz') return { wdl, mated };
      throw e;
    }
  }

  private wdlTable(board: TbBoard): number {
    if (board.onlyKings()) return 0;
    const key = board.key();
    const table = this.wdl.get(key);
    if (!table) {
      if (DRAWN_WITHOUT_TABLE.has(normalizeTableName(key))) return 0;
      throw new MissingTableError(normalizeTableName(key), 'wdl');
    }
    return table.probe(board);
  }

  private dtzTable(board: TbBoard, wdl: number) {
    const key = board.key();
    const table = this.dtz.get(key);
    if (!table) throw new MissingTableError(normalizeTableName(key), 'dtz');
    return table.probe(board, wdl);
  }

  /** python-chess `probe_ab`: alpha-beta over non-en-passant captures, then the table. */
  private probeAb(board: TbBoard, alpha: number, beta: number): [number, number] {
    if (board.pieceCount() > TBPIECES + 1) {
      throw new TbBoardError(`syzygy tables support up to ${TBPIECES} pieces`);
    }
    for (const m of board.legalMoves()) {
      if (!isCaptureMove(m) || isEnPassantMove(m)) continue;
      board.push(m);
      let v: number;
      try {
        v = -this.probeAb(board, -beta, -alpha)[0];
      } finally {
        board.pop();
      }
      if (v > alpha) {
        if (v >= beta) return [v, 2];
        alpha = v;
      }
    }
    const v = this.wdlTable(board);
    if (alpha >= v) return [alpha, 1 + (alpha > 0 ? 1 : 0)];
    return [v, 1];
  }

  private epMoves(board: TbBoard): number[] {
    if (board.ep < 0) return [];
    return board.legalMoves().filter(isEnPassantMove);
  }

  /** python-chess `probe_wdl`. */
  private wdlOf(board: TbBoard): Wdl {
    let v = this.probeAb(board, -2, 2)[0];
    const eps = this.epMoves(board);
    if (eps.length === 0) return v as Wdl;
    let v1 = -3;
    for (const m of eps) {
      board.push(m);
      try {
        v1 = Math.max(v1, -this.probeAb(board, -2, 2)[0]);
      } finally {
        board.pop();
      }
    }
    if (v1 > -3) {
      if (v1 >= v) v = v1;
      else if (v === 0 && board.legalMoves().every(isEnPassantMove)) v = v1;
    }
    return v as Wdl;
  }

  /** python-chess `probe_dtz_no_ep`. */
  private dtzNoEp(board: TbBoard): Dtz {
    const [wdl, success] = this.probeAb(board, -2, 2);
    if (wdl === 0) return precise(0);
    // python-chess also tests "no pieces but pawns" here, which the king makes impossible.
    if (success === 2) return precise(dtzBeforeZeroing(wdl));

    if (wdl > 0) {
      // A winning pawn advance zeroes at once.
      for (const m of board.legalMoves()) {
        if (!board.isPawnMove(m) || isCaptureMove(m)) continue;
        board.push(m);
        let v: number;
        try {
          v = -this.wdlOf(board);
        } finally {
          board.pop();
        }
        if (v === wdl) return precise(wdl === 2 ? 1 : 101);
      }
    }

    const read = this.dtzTable(board, wdl);
    if (read.success >= 0) {
      return {
        v: dtzBeforeZeroing(wdl) + (wdl > 0 ? read.res : -read.res),
        rounded: read.rounded,
      };
    }

    // The table stores the other side to move: 1-ply search.
    if (wdl > 0) {
      let best: Dtz = precise(0xffff);
      for (const m of board.legalMoves()) {
        if (board.isPawnMove(m) || isCaptureMove(m)) continue;
        board.push(m);
        try {
          const child = this.dtzOf(board);
          const v = -child.v;
          if (v === 1 && board.legalMoves().length === 0 && board.isCheck()) best = precise(1);
          else if (v > 0 && v + 1 < best.v) best = { v: v + 1, rounded: child.rounded };
        } finally {
          board.pop();
        }
      }
      return best;
    }
    let best: Dtz = precise(-1);
    for (const m of board.legalMoves()) {
      board.push(m);
      let v: Dtz;
      try {
        if (board.halfmove === 0) {
          if (wdl === -2) v = precise(-1);
          else v = precise(this.probeAb(board, 1, 2)[0] === 2 ? 0 : -101);
        } else {
          const child = this.dtzOf(board);
          v = { v: -child.v - 1, rounded: child.rounded };
        }
      } finally {
        board.pop();
      }
      if (v.v < best.v) best = v;
    }
    return best;
  }

  /** python-chess `probe_dtz`. */
  private dtzOf(board: TbBoard): Dtz {
    let v = this.dtzNoEp(board);
    const eps = this.epMoves(board);
    if (eps.length === 0) return v;
    let v1 = -3;
    for (const m of eps) {
      board.push(m);
      try {
        v1 = Math.max(v1, -this.probeAb(board, -2, 2)[0]);
      } finally {
        board.pop();
      }
    }
    if (v1 > -3) {
      const e = precise(WDL_TO_DTZ[v1 + 2]!);
      if (v.v < -100) {
        if (e.v >= 0) v = e;
      } else if (v.v < 0) {
        if (e.v >= 0 || e.v < -100) v = e;
      } else if (v.v > 100) {
        if (e.v > 0) v = e;
      } else if (v.v > 0) {
        if (e.v === 1) v = e;
      } else if (e.v >= 0) {
        v = e;
      } else if (board.legalMoves().every(isEnPassantMove)) {
        v = e;
      }
    }
    return v;
  }
}
