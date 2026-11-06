/*
 * Syzygy tablebase reader for DaisyChess — WDL and DTZ table files.
 *
 * Derived from python-chess (`chess/syzygy.py`: `Table`, `WdlTable`, `DtzTable`), Copyright (C)
 * 2012-2024 Niklas Fiekas <niklas.fiekas@backscattering.de>, itself a port of Ronald de Man's
 * probing code (https://github.com/syzygy1/tb). Licensed under the GNU General Public License,
 * version 3 or (at your option) any later version; see LICENSE in the repository root.
 * Changes (2026, the DaisyChess authors): TypeScript port over an in-memory `Uint8Array`
 * instead of mmap; no locking (single-threaded); 64-bit Huffman code arithmetic on two 32-bit
 * halves; the suicide-only encodings (more than one king) are left out; DTZ results carry the
 * "rounded" flag (values stored in moves instead of plies) like shakmaty-syzygy, so the caller can
 * reproduce lichess's 50-move categories.
 */

import {
  binom,
  DIAG,
  FILE_TO_FILE,
  FLAP,
  KK_IDX,
  LOWER,
  MFACTOR,
  PA_FLAGS,
  PAWNIDX,
  PFACTOR,
  PTWIST,
  TRIANGLE,
  WDL_TO_MAP,
} from './constants.js';
import type { TbBoard } from './board.js';
import { normalizeTableName, recalcKey } from './names.js';

/** Maximum pieces of a Syzygy table (python-chess `TBPIECES`). */
export const TBPIECES = 7;

const WDL_MAGIC = [0x71, 0xe8, 0x23, 0x5d];
const DTZ_MAGIC = [0xd7, 0x66, 0x0c, 0xa5];

const TWO32 = 4294967296;

export class SyzygyFormatError extends Error {}

interface PairsData {
  indextable: number;
  sizetable: number;
  data: number;
  offset: number;
  symlen: number[];
  sympat: number;
  blocksize: number;
  idxbits: number;
  minLen: number;
  /** `base[i]` as a 64-bit number split into high and low 32-bit halves (hi may be 2^32). */
  baseHi: number[];
  baseLo: number[];
}

interface Pairs {
  d: PairsData;
  next: number;
  flags: number;
}

const offdiag = (sq: number): number => (sq >> 3) - (sq & 7);
const flipdiag = (sq: number): number => ((sq >> 3) | (sq << 3)) & 63;

function subfactor(k: number, n: number): number {
  let f = n;
  let l = 1;
  for (let i = 1; i < k; i++) {
    f *= n - i;
    l *= i + 1;
  }
  return Math.floor(f / l);
}

function pow2(n: number): number {
  return 2 ** n;
}

/** Common part of WDL and DTZ tables (python-chess `Table`). */
abstract class Table {
  readonly name: string;
  key: string;
  mirroredKey: string;
  readonly symmetric: boolean;
  readonly num: number;
  readonly hasPawns: boolean;
  readonly pawns: [number, number] = [0, 0];
  readonly encType: number = 0;
  protected readonly data: Uint8Array;
  protected readonly view: DataView;
  protected initialized = false;

  constructor(name: string, data: Uint8Array, magic: readonly number[]) {
    this.name = name;
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length % 64 !== 16) {
      throw new SyzygyFormatError(`${name}: invalid file size ${data.length}`);
    }
    for (let i = 0; i < 4; i++) {
      if (data[i] !== magic[i]) throw new SyzygyFormatError(`${name}: invalid magic header`);
    }
    this.key = normalizeTableName(name);
    this.mirroredKey = normalizeTableName(name, true);
    this.symmetric = this.key === this.mirroredKey;
    this.num = name.length - 1;
    this.hasPawns = name.includes('P');
    // Like python-chess: the first part is called "black", the second "white".
    const [blackPart = '', whitePart = ''] = name.split('v');
    const count = (s: string, c: string): number => s.split(c).length - 1;
    if (this.hasPawns) {
      this.pawns = [count(whitePart, 'P'), count(blackPart, 'P')];
      if (this.pawns[1] > 0 && (this.pawns[0] === 0 || this.pawns[1] < this.pawns[0])) {
        this.pawns = [this.pawns[1], this.pawns[0]];
      }
    } else {
      let j = 0;
      for (const pt of 'KQRBNP') {
        if (count(blackPart, pt) === 1) j++;
        if (count(whitePart, pt) === 1) j++;
      }
      if (j >= 3) this.encType = 0;
      else if (j === 2) this.encType = 2;
      else throw new SyzygyFormatError(`${name}: encoding not supported (variant table)`);
    }
  }

  protected u16(p: number): number {
    return this.view.getUint16(p, true);
  }

  protected u32(p: number): number {
    return this.view.getUint32(p, true);
  }

  protected u32be(p: number): number {
    return this.view.getUint32(p, false);
  }

  protected setupPairs(
    ptr: number,
    tbSize: number,
    size: number[],
    sizeIdx: number,
    wdl: boolean,
  ): Pairs {
    const data = this.data;
    const flags = data[ptr]!;
    const d: PairsData = {
      indextable: 0,
      sizetable: 0,
      data: 0,
      offset: 0,
      symlen: [],
      sympat: 0,
      blocksize: 0,
      idxbits: 0,
      minLen: 0,
      baseHi: [],
      baseLo: [],
    };
    if (flags & 0x80) {
      d.idxbits = 0;
      // http://www.talkchess.com/forum/viewtopic.php?p=698093#698093 (captures not compulsory)
      d.minLen = wdl ? data[ptr + 1]! : 0;
      size[sizeIdx] = 0;
      size[sizeIdx + 1] = 0;
      size[sizeIdx + 2] = 0;
      return { d, next: ptr + 2, flags };
    }
    d.blocksize = data[ptr + 1]!;
    d.idxbits = data[ptr + 2]!;
    const realNumBlocks = this.u32(ptr + 4);
    const numBlocks = realNumBlocks + data[ptr + 3]!;
    const maxLen = data[ptr + 8]!;
    const minLen = data[ptr + 9]!;
    const h = maxLen - minLen + 1;
    const numSyms = this.u16(ptr + 10 + 2 * h);
    d.offset = ptr + 10;
    d.symlen = new Array<number>(h * 8 + numSyms).fill(0);
    d.sympat = ptr + 12 + 2 * h;
    d.minLen = minLen;
    const next = ptr + 12 + 2 * h + 3 * numSyms + (numSyms & 1);

    const numIndices = Math.floor((tbSize + pow2(d.idxbits) - 1) / pow2(d.idxbits));
    size[sizeIdx] = 6 * numIndices;
    size[sizeIdx + 1] = 2 * numBlocks;
    size[sizeIdx + 2] = pow2(d.blocksize) * realNumBlocks;

    const tmp = new Array<number>(numSyms).fill(0);
    for (let i = 0; i < numSyms; i++) if (!tmp[i]) this.calcSymlen(d, i, tmp);

    const base = new Array<number>(h).fill(0);
    for (let i = h - 2; i >= 0; i--) {
      base[i] = Math.floor(
        (base[i + 1]! + this.u16(d.offset + i * 2) - this.u16(d.offset + i * 2 + 2)) / 2,
      );
    }
    for (let i = 0; i < h; i++) {
      const v = BigInt(base[i]!) << BigInt(64 - (minLen + i));
      d.baseHi.push(Number(v >> 32n));
      d.baseLo.push(Number(v & 0xffffffffn));
    }
    d.offset -= 2 * d.minLen;
    return { d, next, flags };
  }

  private calcSymlen(d: PairsData, s: number, tmp: number[]): void {
    const data = this.data;
    const w = d.sympat + 3 * s;
    const s2 = (data[w + 2]! << 4) | (data[w + 1]! >> 4);
    if (s2 === 0x0fff) {
      d.symlen[s] = 0;
    } else {
      const s1 = ((data[w + 1]! & 0xf) << 8) | data[w]!;
      if (!tmp[s1]) this.calcSymlen(d, s1, tmp);
      if (!tmp[s2]) this.calcSymlen(d, s2, tmp);
      d.symlen[s] = d.symlen[s1]! + d.symlen[s2]! + 1;
    }
    tmp[s] = 1;
  }

  protected setNormPiece(norm: number[], pieces: number[]): void {
    norm[0] = this.encType === 0 ? 3 : this.encType === 2 ? 2 : this.encType - 1;
    let i = norm[0];
    while (i < this.num) {
      let j = i;
      while (j < this.num && pieces[j] === pieces[i]) {
        norm[i]!++;
        j++;
      }
      i += norm[i]!;
    }
  }

  protected calcFactorsPiece(factor: number[], order: number, norm: number[]): number {
    const PIVFAC = [31332, 28056, 462];
    let n = 64 - norm[0]!;
    let f = 1;
    let i = norm[0]!;
    let k = 0;
    while (i < this.num || k === order) {
      if (k === order) {
        factor[0] = f;
        f *= this.encType < 4 ? PIVFAC[this.encType]! : MFACTOR[this.encType - 2]!;
      } else {
        factor[i] = f;
        f *= subfactor(norm[i]!, n);
        n -= norm[i]!;
        i += norm[i]!;
      }
      k++;
    }
    return f;
  }

  protected calcFactorsPawn(
    factor: number[],
    order: number,
    order2: number,
    norm: number[],
    file: number,
  ): number {
    let i = norm[0]!;
    if (order2 < 0x0f) i += norm[i]!;
    let n = 64 - i;
    let fac = 1;
    let k = 0;
    while (i < this.num || k === order || k === order2) {
      if (k === order) {
        factor[0] = fac;
        fac *= PFACTOR[norm[0]! - 1]![file]!;
      } else if (k === order2) {
        factor[norm[0]!] = fac;
        fac *= subfactor(norm[norm[0]!]!, 48 - norm[0]!);
      } else {
        factor[i] = fac;
        fac *= subfactor(norm[i]!, n);
        n -= norm[i]!;
        i += norm[i]!;
      }
      k++;
    }
    return fac;
  }

  protected setNormPawn(norm: number[], pieces: number[]): void {
    norm[0] = this.pawns[0];
    if (this.pawns[1]) norm[this.pawns[0]] = this.pawns[1];
    let i = this.pawns[0] + this.pawns[1];
    while (i < this.num) {
      let j = i;
      while (j < this.num && pieces[j] === pieces[i]) {
        norm[i]!++;
        j++;
      }
      i += norm[i]!;
    }
  }

  protected pawnFile(pos: number[]): number {
    for (let i = 1; i < this.pawns[0]; i++) {
      if (FLAP[pos[0]!]! > FLAP[pos[i]!]!) [pos[0], pos[i]] = [pos[i]!, pos[0]!];
    }
    return FILE_TO_FILE[pos[0]! & 0x07]!;
  }

  protected encodePiece(norm: number[], pos: number[], factor: number[]): number {
    const n = this.num;
    if (pos[0]! & 0x04) for (let i = 0; i < n; i++) pos[i] = pos[i]! ^ 0x07;
    if (pos[0]! & 0x20) for (let i = 0; i < n; i++) pos[i] = pos[i]! ^ 0x38;
    let i = 0;
    for (i = 0; i < n; i++) if (offdiag(pos[i]!)) break;
    if (i === n) i = n - 1; // python's loop variable after a loop without break
    if (i < (this.encType === 0 ? 3 : 2) && offdiag(pos[i]!) > 0) {
      for (let x = 0; x < n; x++) pos[x] = flipdiag(pos[x]!);
    }

    let idx: number;
    if (this.encType === 0) {
      // 111
      const a = pos[1]! > pos[0]! ? 1 : 0;
      const b = (pos[2]! > pos[0]! ? 1 : 0) + (pos[2]! > pos[1]! ? 1 : 0);
      if (offdiag(pos[0]!)) {
        idx = TRIANGLE[pos[0]!]! * 63 * 62 + (pos[1]! - a) * 62 + (pos[2]! - b);
      } else if (offdiag(pos[1]!)) {
        idx = 6 * 63 * 62 + DIAG[pos[0]!]! * 28 * 62 + LOWER[pos[1]!]! * 62 + pos[2]! - b;
      } else if (offdiag(pos[2]!)) {
        idx =
          6 * 63 * 62 +
          4 * 28 * 62 +
          DIAG[pos[0]!]! * 7 * 28 +
          (DIAG[pos[1]!]! - a) * 28 +
          LOWER[pos[2]!]!;
      } else {
        idx =
          6 * 63 * 62 +
          4 * 28 * 62 +
          4 * 7 * 28 +
          DIAG[pos[0]!]! * 7 * 6 +
          (DIAG[pos[1]!]! - a) * 6 +
          (DIAG[pos[2]!]! - b);
      }
      i = 3;
    } else {
      // K2 (enc_type 2, kings not connected)
      idx = KK_IDX[TRIANGLE[pos[0]!]!]![pos[1]!]!;
      i = 2;
    }
    idx *= factor[0]!;
    return idx + this.encodeRest(norm, pos, factor, i, 0);
  }

  /** Encodes the groups of like pieces from `start` on (shared by both encodings). */
  private encodeRest(
    norm: number[],
    pos: number[],
    factor: number[],
    start: number,
    idx0: number,
  ): number {
    const n = this.num;
    let idx = idx0;
    let i = start;
    while (i < n) {
      const t = norm[i]!;
      for (let j = i; j < i + t; j++) {
        for (let k = j + 1; k < i + t; k++) {
          if (pos[j]! > pos[k]!) [pos[j], pos[k]] = [pos[k]!, pos[j]!];
        }
      }
      let s = 0;
      for (let m = i; m < i + t; m++) {
        const p = pos[m]!;
        let j = 0;
        for (let l = 0; l < i; l++) if (p > pos[l]!) j++;
        s += binom(p - j, m - i + 1);
      }
      idx += s * factor[i]!;
      i += t;
    }
    return idx;
  }

  protected encodePawn(norm: number[], pos: number[], factor: number[]): number {
    const n = this.num;
    if (pos[0]! & 0x04) for (let i = 0; i < n; i++) pos[i] = pos[i]! ^ 0x07;

    for (let i = 1; i < this.pawns[0]; i++) {
      for (let j = i + 1; j < this.pawns[0]; j++) {
        if (PTWIST[pos[i]!]! < PTWIST[pos[j]!]!) [pos[i], pos[j]] = [pos[j]!, pos[i]!];
      }
    }
    let t = this.pawns[0] - 1;
    let idx = PAWNIDX[t]![FLAP[pos[0]!]!]!;
    for (let i = t; i > 0; i--) idx += binom(PTWIST[pos[i]!]!, t - i + 1);
    idx *= factor[0]!;

    // Remaining pawns.
    let i = this.pawns[0];
    t = i + this.pawns[1];
    if (t > i) {
      for (let j = i; j < t; j++) {
        for (let k = j + 1; k < t; k++) {
          if (pos[j]! > pos[k]!) [pos[j], pos[k]] = [pos[k]!, pos[j]!];
        }
      }
      let s = 0;
      for (let m = i; m < t; m++) {
        const p = pos[m]!;
        let j = 0;
        for (let k = 0; k < i; k++) if (p > pos[k]!) j++;
        s += binom(p - j - 8, m - i + 1);
      }
      idx += s * factor[i]!;
      i = t;
    }
    return this.encodeRest(norm, pos, factor, i, idx);
  }

  protected decompressPairs(d: PairsData, idx: number, dtz: boolean): number {
    const data = this.data;
    if (!d.idxbits) return d.minLen;

    const span = pow2(d.idxbits);
    const mainidx = Math.floor(idx / span);
    let litidx = (idx % span) - pow2(d.idxbits - 1);
    let block = this.u32(d.indextable + 6 * mainidx);
    litidx += this.u16(d.indextable + 6 * mainidx + 4);

    if (litidx < 0) {
      while (litidx < 0) {
        block -= 1;
        litidx += this.u16(d.sizetable + 2 * block) + 1;
      }
    } else {
      while (litidx > this.u16(d.sizetable + 2 * block)) {
        litidx -= this.u16(d.sizetable + 2 * block) + 1;
        block += 1;
      }
    }

    let ptr = d.data + block * pow2(d.blocksize);
    const m = d.minLen;
    // 64-bit code window as two unsigned 32-bit halves.
    let hi = this.u32be(ptr);
    let lo = this.u32be(ptr + 4);
    ptr += 8;
    let bitcnt = 0; // number of empty bits in code
    let sym: number;
    for (;;) {
      let l = m;
      while (hi < d.baseHi[l - m]! || (hi === d.baseHi[l - m]! && lo < d.baseLo[l - m]!)) l++;
      // (code - base[l]) >> (64 - l), exact.
      let dlo = lo - d.baseLo[l - m]!;
      let borrow = 0;
      if (dlo < 0) {
        dlo += TWO32;
        borrow = 1;
      }
      const dhi = hi - d.baseHi[l - m]! - borrow;
      const s = 64 - l;
      const add =
        s >= 32 ? Math.floor(dhi / pow2(s - 32)) : dhi * pow2(32 - s) + Math.floor(dlo / pow2(s));
      sym = this.u16(d.offset + l * 2) + add;
      if (litidx < d.symlen[sym]! + 1) break;
      litidx -= d.symlen[sym]! + 1;
      // code <<= l (cut off at 64 bits)
      if (l >= 64) {
        hi = 0;
        lo = 0;
      } else if (l >= 32) {
        hi = (lo << (l - 32)) >>> 0;
        lo = 0;
      } else if (l > 0) {
        hi = ((hi << l) | (lo >>> (32 - l))) >>> 0;
        lo = (lo << l) >>> 0;
      }
      bitcnt += l;
      if (bitcnt >= 32) {
        bitcnt -= 32;
        const v = this.u32be(ptr);
        ptr += 4;
        lo = (lo | (v << bitcnt)) >>> 0;
        if (bitcnt > 0) hi = (hi | (v >>> (32 - bitcnt))) >>> 0;
      }
    }

    const sympat = d.sympat;
    while (d.symlen[sym]) {
      const w = sympat + 3 * sym;
      const s1 = ((data[w + 1]! & 0xf) << 8) | data[w]!;
      if (litidx < d.symlen[s1]! + 1) {
        sym = s1;
      } else {
        litidx -= d.symlen[s1]! + 1;
        sym = (data[w + 2]! << 4) | (data[w + 1]! >> 4);
      }
    }
    const w = sympat + 3 * sym;
    return dtz ? ((data[w + 1]! & 0x0f) << 8) | data[w]! : data[w]!;
  }

  /**
   * The table's colour mapping for `board` (python-chess: `cmirror`, `mirror`, `bside`):
   * whether the board's White plays the table's first side, and which side's sub-table to read.
   */
  protected sides(board: TbBoard): { cmirror: number; mirror: number; bside: number } {
    const key = board.key();
    const white = board.turn === 0;
    if (!this.symmetric) {
      if (key !== this.key) return { cmirror: 8, mirror: 0x38, bside: white ? 1 : 0 };
      return { cmirror: 0, mirror: 0, bside: white ? 0 : 1 };
    }
    return { cmirror: white ? 0 : 8, mirror: white ? 0 : 0x38, bside: 0 };
  }

  /** Fills `p` from index `i` with the squares of the pieces `pc[i…]` (table piece codes). */
  protected fill(
    board: TbBoard,
    p: number[],
    start: number,
    pc: number[],
    cmirror: number,
    mirror: number,
  ): void {
    let i = start;
    while (i < this.num) {
      const code = pc[i]!;
      const squares = board.squares(code & 0x07, ((code ^ cmirror) >> 3) as 0 | 1);
      if (squares.length === 0)
        throw new SyzygyFormatError(`${this.name}: board does not match the table`);
      for (const sq of squares) p[i++] = sq ^ mirror;
    }
  }
}

interface PawnFileData {
  precomp: PairsData[];
  factor: number[][];
  pieces: number[][];
  norm: number[][];
}

export class WdlTable extends Table {
  private tbSize: number[] = [];
  private size: number[] = [];
  private precomp: PairsData[] = [];
  private pieces: number[][] = [];
  private factor: number[][] = [];
  private norm: number[][] = [];
  private files: PawnFileData[] = [];

  constructor(name: string, data: Uint8Array) {
    super(name, data, WDL_MAGIC);
  }

  private init(): void {
    if (this.initialized) return;
    const data = this.data;
    this.tbSize = new Array<number>(8).fill(0);
    this.size = new Array<number>(8 * 3).fill(0);
    this.factor = [new Array<number>(TBPIECES).fill(0), new Array<number>(TBPIECES).fill(0)];
    this.norm = [new Array<number>(this.num).fill(0), new Array<number>(this.num).fill(0)];
    this.files = [0, 1, 2, 3].map(() => ({ precomp: [], factor: [], pieces: [], norm: [] }));

    const split = data[4]! & 0x01;
    const files = data[4]! & 0x02 ? 4 : 1;
    let ptr = 5;

    if (!this.hasPawns) {
      this.setupPiecesPiece(ptr);
      ptr += this.num + 1;
      ptr += ptr & 0x01;
      let r = this.setupPairs(ptr, this.tbSize[0]!, this.size, 0, true);
      this.precomp[0] = r.d;
      ptr = r.next;
      if (split) {
        r = this.setupPairs(ptr, this.tbSize[1]!, this.size, 3, true);
        this.precomp[1] = r.d;
        ptr = r.next;
      }
      this.precomp[0].indextable = ptr;
      ptr += this.size[0]!;
      if (split) {
        this.precomp[1]!.indextable = ptr;
        ptr += this.size[3]!;
      }
      this.precomp[0].sizetable = ptr;
      ptr += this.size[1]!;
      if (split) {
        this.precomp[1]!.sizetable = ptr;
        ptr += this.size[4]!;
      }
      ptr = (ptr + 0x3f) & ~0x3f;
      this.precomp[0].data = ptr;
      ptr += this.size[2]!;
      if (split) {
        ptr = (ptr + 0x3f) & ~0x3f;
        this.precomp[1]!.data = ptr;
      }
      this.key = recalcKey(this.pieces[0]!);
      this.mirroredKey = recalcKey(this.pieces[0]!, true);
    } else {
      const s = 1 + (this.pawns[1] > 0 ? 1 : 0);
      for (let f = 0; f < 4; f++) {
        this.setupPiecesPawn(ptr, 2 * f, f);
        ptr += this.num + s;
      }
      ptr += ptr & 0x01;
      for (let f = 0; f < files; f++) {
        const file = this.files[f]!;
        let r = this.setupPairs(ptr, this.tbSize[2 * f]!, this.size, 6 * f, true);
        file.precomp[0] = r.d;
        ptr = r.next;
        if (split) {
          r = this.setupPairs(ptr, this.tbSize[2 * f + 1]!, this.size, 6 * f + 3, true);
          file.precomp[1] = r.d;
          ptr = r.next;
        }
      }
      for (let f = 0; f < files; f++) {
        const file = this.files[f]!;
        file.precomp[0]!.indextable = ptr;
        ptr += this.size[6 * f]!;
        if (split) {
          file.precomp[1]!.indextable = ptr;
          ptr += this.size[6 * f + 3]!;
        }
      }
      for (let f = 0; f < files; f++) {
        const file = this.files[f]!;
        file.precomp[0]!.sizetable = ptr;
        ptr += this.size[6 * f + 1]!;
        if (split) {
          file.precomp[1]!.sizetable = ptr;
          ptr += this.size[6 * f + 4]!;
        }
      }
      for (let f = 0; f < files; f++) {
        const file = this.files[f]!;
        ptr = (ptr + 0x3f) & ~0x3f;
        file.precomp[0]!.data = ptr;
        ptr += this.size[6 * f + 2]!;
        if (split) {
          ptr = (ptr + 0x3f) & ~0x3f;
          file.precomp[1]!.data = ptr;
          ptr += this.size[6 * f + 5]!;
        }
      }
    }
    this.initialized = true;
  }

  /** Parses the header now (normally lazy); throws `SyzygyFormatError`/`RangeError` when corrupt. */
  validate(): void {
    this.init();
  }

  private setupPiecesPawn(p: number, pTbSize: number, f: number): void {
    const data = this.data;
    const file = this.files[f]!;
    const j = 1 + (this.pawns[1] > 0 ? 1 : 0);
    for (const side of [0, 1]) {
      const shift = side === 0 ? 0 : 4;
      const order = (data[p]! >> shift) & 0x0f;
      const order2 = this.pawns[1] ? (data[p + 1]! >> shift) & 0x0f : 0x0f;
      file.pieces[side] = Array.from(
        { length: this.num },
        (_, i) => (data[p + i + j]! >> shift) & 0x0f,
      );
      file.norm[side] = new Array<number>(this.num).fill(0);
      this.setNormPawn(file.norm[side]!, file.pieces[side]!);
      file.factor[side] = new Array<number>(TBPIECES).fill(0);
      this.tbSize[pTbSize + side] = this.calcFactorsPawn(
        file.factor[side]!,
        order,
        order2,
        file.norm[side]!,
        f,
      );
    }
  }

  private setupPiecesPiece(p: number): void {
    const data = this.data;
    for (const side of [0, 1]) {
      const shift = side === 0 ? 0 : 4;
      this.pieces[side] = Array.from(
        { length: this.num },
        (_, i) => (data[p + i + 1]! >> shift) & 0x0f,
      );
      const order = (data[p]! >> shift) & 0x0f;
      this.setNormPiece(this.norm[side]!, this.pieces[side]!);
      this.tbSize[side] = this.calcFactorsPiece(this.factor[side]!, order, this.norm[side]!);
    }
  }

  /** Raw WDL value (-2 … 2) of the table for `board`, captures not resolved. */
  probe(board: TbBoard): number {
    this.init();
    const { cmirror, mirror, bside } = this.sides(board);
    const p = new Array<number>(TBPIECES).fill(0);
    let res: number;
    if (!this.hasPawns) {
      this.fill(board, p, 0, this.pieces[bside]!, cmirror, 0);
      const pre = this.precomp[bside];
      if (!pre) throw new SyzygyFormatError(`${this.name}: side not stored`);
      const idx = this.encodePiece(this.norm[bside]!, p, this.factor[bside]!);
      res = this.decompressPairs(pre, idx, false);
    } else {
      const lead = this.files[0]!.pieces[0]![0]! ^ cmirror;
      let i = 0;
      for (const sq of board.squares(lead & 0x07, (lead >> 3) as 0 | 1)) p[i++] = sq ^ mirror;
      const f = this.pawnFile(p);
      const file = this.files[f]!;
      this.fill(board, p, i, file.pieces[bside]!, cmirror, mirror);
      const pre = file.precomp[bside];
      if (!pre) throw new SyzygyFormatError(`${this.name}: side not stored`);
      const idx = this.encodePawn(file.norm[bside]!, p, file.factor[bside]!);
      res = this.decompressPairs(pre, idx, false);
    }
    return res - 2;
  }
}

interface PawnFileDataDtz {
  precomp: PairsData | undefined;
  factor: number[];
  pieces: number[];
  norm: number[];
}

/** Result of a DTZ table read: `success` -1 when the table stores the other side to move. */
export interface DtzRead {
  res: number;
  success: 1 | -1;
  /** The table stores moves, not plies, for this result (value doubled, may be off by one). */
  rounded: boolean;
}

export class DtzTable extends Table {
  private factor: number[] = [];
  private norm: number[] = [];
  private tbSize: number[] = [];
  private size: number[] = [];
  private files: PawnFileDataDtz[] = [];
  private mapIdx: number[][] = [];
  private pMap = 0;
  private flags: number[] = [];
  private precomp: PairsData | undefined;
  private pieces: number[] = [];

  constructor(name: string, data: Uint8Array) {
    super(name, data, DTZ_MAGIC);
  }

  private init(): void {
    if (this.initialized) return;
    const data = this.data;
    this.factor = new Array<number>(TBPIECES).fill(0);
    this.norm = new Array<number>(this.num).fill(0);
    this.tbSize = [0, 0, 0, 0];
    this.size = new Array<number>(12).fill(0);
    this.files = [0, 1, 2, 3].map(() => ({ precomp: undefined, factor: [], pieces: [], norm: [] }));
    const files = data[4]! & 0x02 ? 4 : 1;
    let p = 5;

    if (!this.hasPawns) {
      this.mapIdx = [[0, 0, 0, 0]];
      this.pieces = Array.from({ length: this.num }, (_, i) => data[p + i + 1]! & 0x0f);
      const order = data[p]! & 0x0f;
      this.setNormPiece(this.norm, this.pieces);
      this.tbSize[0] = this.calcFactorsPiece(this.factor, order, this.norm);
      p += this.num + 1;
      p += p & 0x01;

      const r = this.setupPairs(p, this.tbSize[0], this.size, 0, false);
      this.precomp = r.d;
      this.flags = [r.flags];
      p = r.next;
      this.pMap = p;
      const flags = r.flags;
      if (flags & 2) {
        if (!(flags & 16)) {
          for (let i = 0; i < 4; i++) {
            this.mapIdx[0]![i] = p + 1 - this.pMap;
            p += 1 + data[p]!;
          }
        } else {
          for (let i = 0; i < 4; i++) {
            this.mapIdx[0]![i] = (p + 2 - this.pMap) / 2;
            p += 2 + 2 * this.u16(p);
          }
        }
      }
      p += p & 0x01;
      this.precomp.indextable = p;
      p += this.size[0]!;
      this.precomp.sizetable = p;
      p += this.size[1]!;
      p = (p + 0x3f) & ~0x3f;
      this.precomp.data = p;
      this.key = recalcKey(this.pieces);
      this.mirroredKey = recalcKey(this.pieces, true);
    } else {
      const s = 1 + (this.pawns[1] > 0 ? 1 : 0);
      for (let f = 0; f < 4; f++) {
        this.setupPiecesPawnDtz(p, f, f);
        p += this.num + s;
      }
      p += p & 0x01;
      this.flags = [];
      for (let f = 0; f < files; f++) {
        const r = this.setupPairs(p, this.tbSize[f]!, this.size, 3 * f, false);
        this.files[f]!.precomp = r.d;
        p = r.next;
        this.flags.push(r.flags);
      }
      this.mapIdx = [];
      this.pMap = p;
      for (let f = 0; f < files; f++) {
        const list: number[] = [];
        this.mapIdx.push(list);
        const flags = this.flags[f]!;
        if (flags & 2) {
          if (!(flags & 16)) {
            for (let i = 0; i < 4; i++) {
              list.push(p + 1 - this.pMap);
              p += 1 + data[p]!;
            }
          } else {
            p += p & 0x01;
            for (let i = 0; i < 4; i++) {
              list.push((p + 2 - this.pMap) / 2);
              p += 2 + 2 * this.u16(p);
            }
          }
        }
      }
      p += p & 0x01;
      for (let f = 0; f < files; f++) {
        this.files[f]!.precomp!.indextable = p;
        p += this.size[3 * f]!;
      }
      for (let f = 0; f < files; f++) {
        this.files[f]!.precomp!.sizetable = p;
        p += this.size[3 * f + 1]!;
      }
      for (let f = 0; f < files; f++) {
        p = (p + 0x3f) & ~0x3f;
        this.files[f]!.precomp!.data = p;
        p += this.size[3 * f + 2]!;
      }
    }
    this.initialized = true;
  }

  /** Parses the header now (normally lazy); throws `SyzygyFormatError`/`RangeError` when corrupt. */
  validate(): void {
    this.init();
  }

  private setupPiecesPawnDtz(p: number, pTbSize: number, f: number): void {
    const data = this.data;
    const file = this.files[f]!;
    const j = 1 + (this.pawns[1] > 0 ? 1 : 0);
    const order = data[p]! & 0x0f;
    const order2 = this.pawns[1] ? data[p + 1]! & 0x0f : 0x0f;
    file.pieces = Array.from({ length: this.num }, (_, i) => data[p + i + j]! & 0x0f);
    file.norm = new Array<number>(this.num).fill(0);
    this.setNormPawn(file.norm, file.pieces);
    file.factor = new Array<number>(TBPIECES).fill(0);
    this.tbSize[pTbSize] = this.calcFactorsPawn(file.factor, order, order2, file.norm, f);
  }

  private mapValue(f: number, flags: number, wdl: number, res: number): number {
    if (!(flags & 2)) return res;
    const m = this.mapIdx[f]![WDL_TO_MAP[wdl + 2]!]!;
    if (!(flags & 16)) return this.data[this.pMap + m + res]!;
    return this.u16(this.pMap + 2 * (m + res));
  }

  /** DTZ table read for `board` with the known decisive `wdl` (python-chess `probe_dtz_table`). */
  probe(board: TbBoard, wdl: number): DtzRead {
    this.init();
    const { cmirror, mirror, bside } = this.sides(board);
    const p = new Array<number>(TBPIECES).fill(0);
    let res: number;
    let flags: number;
    if (!this.hasPawns) {
      flags = this.flags[0]!;
      if ((flags & 1) !== bside && !this.symmetric) return { res: 0, success: -1, rounded: false };
      this.fill(board, p, 0, this.pieces, cmirror, 0);
      const idx = this.encodePiece(this.norm, p, this.factor);
      res = this.decompressPairs(this.precomp!, idx, true);
      res = this.mapValue(0, flags, wdl, res);
    } else {
      const lead = this.files[0]!.pieces[0]! ^ cmirror;
      let i = 0;
      for (const sq of board.squares(lead & 0x07, (lead >> 3) as 0 | 1)) p[i++] = sq ^ mirror;
      const f = this.pawnFile(p);
      flags = this.flags[f]!;
      if ((flags & 1) !== bside) return { res: 0, success: -1, rounded: false };
      const file = this.files[f]!;
      this.fill(board, p, i, file.pieces, cmirror, mirror);
      const idx = this.encodePawn(file.norm, p, file.factor);
      res = this.decompressPairs(file.precomp!, idx, true);
      res = this.mapValue(f, flags, wdl, res);
    }
    let rounded = false;
    if (!(flags & PA_FLAGS[wdl + 2]!) || wdl & 1) {
      res *= 2;
      rounded = true;
    }
    return { res, success: 1, rounded };
  }
}
