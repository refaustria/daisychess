import { Chess, type Square } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  ENDGAME_FAMILIES,
  endgameFamily,
  lessonFamilyFor,
  lessonGroupFor,
  materialKey,
  materialSignature,
  normalizeMaterialKey,
  puzzleThemeFor,
  sideMaterial,
  type EndgameFamily,
} from './material.js';

/** One hand-written legal FEN per family (White king e1, Black king e5 where possible). */
const FAMILY_FENS: Array<[EndgameFamily, string]> = [
  ['basic_mate', '8/8/8/4k3/8/8/8/3QK3 w - - 0 1'],
  ['kp_v_k', '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1'],
  ['pawn', '8/5p2/8/4k3/8/8/4P1P1/4K3 w - - 0 1'],
  ['rook', '8/5p2/8/4k3/r7/8/4P1P1/R3K3 w - - 0 1'],
  ['double_rook', 'r6r/5p2/8/4k3/8/8/4P1P1/R3K2R w - - 0 1'],
  ['rook_v_pawns', '8/5p2/8/4k3/8/8/8/R3K3 w - - 0 1'],
  ['rook_v_minor', '8/5p2/8/4k3/2b5/8/4P3/R3K3 w - - 0 1'],
  ['rook_minor', 'r3n3/5p2/8/4k3/8/8/4P3/R2BK3 w - - 0 1'],
  ['rook_minor_v_rook', 'r7/8/8/4k3/8/8/8/R2BK3 w - - 0 1'],
  ['queen', 'q7/8/8/4k3/8/8/6P1/3QK3 w - - 0 1'],
  ['queen_v_rook', 'r7/8/8/4k3/8/8/8/3QK3 w - - 0 1'],
  ['queen_v_pawns', '8/8/8/4k3/8/8/1p6/3QK3 w - - 0 1'],
  ['queen_v_minor', '8/8/2n5/4k3/8/8/8/3QK3 w - - 0 1'],
  ['queen_rook', 'q6r/8/8/4k3/8/8/8/R2QK3 w - - 0 1'],
  ['queen_v_pieces', 'r1b5/8/8/4k3/8/8/8/3QK3 w - - 0 1'],
  ['same_bishops', '5b2/5p2/8/4k3/8/8/4P3/2B1K3 w - - 0 1'],
  ['opposite_bishops', '2b5/5p2/8/4k3/8/8/4P3/2B1K3 w - - 0 1'],
  ['knight', '6n1/5p2/8/4k3/8/8/4P3/1N2K3 w - - 0 1'],
  ['bishop_v_knight', '6n1/5p2/8/4k3/8/8/4P3/2B1K3 w - - 0 1'],
  ['minor_v_pawns', '8/5p2/8/4k3/8/8/4P3/2B1K3 w - - 0 1'],
  ['two_minors', '6n1/8/8/4k3/8/8/8/1NB1K3 w - - 0 1'],
  ['other', '8/8/8/4k3/8/8/8/R2QK3 w - - 0 1'],
];

/** The three extra cases of the M32-1 acceptance. */
const EXTRA_FENS: Array<[EndgameFamily, string]> = [
  // Light-squared bishops (f1 and c8): same colour although on different wings.
  ['same_bishops', '2b5/5p2/8/4k3/8/8/4P3/4KB2 w - - 0 1'],
  // Q+R vs Q+R with pawns on both sides, Black's pieces listed first in the FEN.
  ['queen_rook', 'qr6/5pp1/8/4k3/8/8/5PP1/3QK2R b - - 0 1'],
  // K+B+N vs K is a basic mate.
  ['basic_mate', '8/8/8/4k3/8/8/8/1NB1K3 w - - 0 1'],
];

describe('endgameFamily', () => {
  it('lists 21 families plus other', () => {
    expect(ENDGAME_FAMILIES).toHaveLength(22);
    expect(new Set(ENDGAME_FAMILIES).size).toBe(22);
    expect(ENDGAME_FAMILIES.at(-1)).toBe('other');
  });

  it('covers every family with one hand-written FEN', () => {
    expect(new Set(FAMILY_FENS.map(([f]) => f))).toEqual(new Set(ENDGAME_FAMILIES));
  });

  it.each([...FAMILY_FENS, ...EXTRA_FENS])('%s: %s', (family, fen) => {
    expect(() => new Chess(fen)).not.toThrow();
    expect(endgameFamily(fen).family).toBe(family);
  });

  it('is symmetric in the colours', () => {
    for (const [family, fen] of FAMILY_FENS) {
      const [placement, , ...rest] = fen.split(' ');
      const mirrored = placement!
        .split('/')
        .reverse()
        .map((r) =>
          [...r].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join(''),
        )
        .join('/');
      expect(endgameFamily(`${mirrored} b ${rest.join(' ')}`).family, family).toBe(family);
    }
  });

  it('reports the pawn flags', () => {
    expect(endgameFamily('8/5p2/8/4k3/r7/8/4P1P1/R3K3 w - - 0 1')).toEqual({
      family: 'rook',
      pawnless: false,
      pawnsUp: 1,
    });
    expect(endgameFamily('8/8/8/4k3/8/8/1p6/3QK3 w - - 0 1').pawnsUp).toBe(-1);
    expect(endgameFamily('r7/8/8/4k3/8/8/8/3QK3 w - - 0 1').pawnless).toBe(true);
  });

  it('separates bare kings, pawns-only and R vs bare king with pawns', () => {
    expect(endgameFamily('8/8/8/4k3/8/8/8/4K3 w - - 0 1').family).toBe('other');
    // Pawns of the stronger side are ignored for the basic mates …
    expect(endgameFamily('8/8/8/4k3/8/8/4P3/R3K3 w - - 0 1').family).toBe('basic_mate');
    // … but a pawn of the defender makes it rook against pawns.
    expect(endgameFamily('8/8/8/4k3/8/8/1p6/R3K3 w - - 0 1').family).toBe('rook_v_pawns');
    // A lone minor piece without pawns is no family.
    expect(endgameFamily('8/8/8/4k3/8/8/8/2B1K3 w - - 0 1').family).toBe('other');
  });
});

describe('sideMaterial', () => {
  it('counts pieces and gets bishop square colours right', () => {
    const fen = '2b2b2/5p2/8/4k3/8/8/4P3/2B1KB2 w - - 0 1';
    const { white, black } = sideMaterial(fen);
    expect(white).toMatchObject({ q: 0, r: 0, b: 2, n: 0, p: 1 });
    expect(black).toMatchObject({ b: 2, p: 1 });
    const chess = new Chess(fen);
    const colour = (sq: Square) => chess.squareColor(sq);
    expect(white.bishopColors).toEqual([colour('c1'), colour('f1')]);
    expect(black.bishopColors).toEqual([colour('c8'), colour('f8')]);
  });
});

describe('materialSignature', () => {
  it('lists Q R B N then the pawn count, White first', () => {
    expect(materialSignature('8/5pp1/8/4k3/r7/8/4PPP1/R3K3 w - - 0 1')).toEqual({
      white: 'R+3P',
      black: 'R+2P',
      text: 'R+3P vs R+2P',
    });
    expect(materialSignature('qr2b3/8/8/4k3/8/8/4P3/1N1QK2R w - - 0 1').text).toBe(
      'Q+R+N+P vs Q+R+B',
    );
  });

  it('writes K for a bare king', () => {
    expect(materialSignature('8/8/8/4k3/8/8/8/3QK3 w - - 0 1').text).toBe('Q vs K');
    expect(materialSignature('8/8/8/4k3/8/8/8/4K3 w - - 0 1').text).toBe('K vs K');
  });
});

describe('materialKey / normalizeMaterialKey', () => {
  it('names the stronger side first (Syzygy naming)', () => {
    expect(materialKey('1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1')).toBe('KRPvKR');
    expect(materialKey('1k6/1p1K4/8/8/8/8/R7/2r5 w - - 0 1')).toBe('KRPvKR');
    expect(materialKey('8/8/8/4k3/8/8/4P3/r3K3 w - - 0 1')).toBe('KRvKP');
    expect(materialKey('8/8/8/4k3/8/8/8/1NB1K3 w - - 0 1')).toBe('KBNvK');
    expect(materialKey('8/8/8/4k3/8/8/8/4K3 w - - 0 1')).toBe('KvK');
  });

  it('normalises table names like python-chess', () => {
    expect(normalizeMaterialKey('KPvKR')).toBe('KRvKP');
    expect(normalizeMaterialKey('KNvKB')).toBe('KBvKN');
    expect(normalizeMaterialKey('KvKQ')).toBe('KQvK');
    expect(normalizeMaterialKey('KPRvKR')).toBe('KRPvKR');
    expect(normalizeMaterialKey('KQvKR')).toBe('KQvKR');
    expect(normalizeMaterialKey('KRvKRP')).toBe('KRPvKR');
  });
});

describe('puzzleThemeFor', () => {
  it.each<[EndgameFamily, string]>([
    ['rook', 'rookEndgame'],
    ['double_rook', 'rookEndgame'],
    ['rook_v_pawns', 'rookEndgame'],
    ['rook_v_minor', 'rookEndgame'],
    ['rook_minor', 'rookEndgame'],
    ['rook_minor_v_rook', 'rookEndgame'],
    ['pawn', 'pawnEndgame'],
    ['kp_v_k', 'pawnEndgame'],
    ['queen', 'queenEndgame'],
    ['queen_v_rook', 'queenEndgame'],
    ['queen_v_pawns', 'queenEndgame'],
    ['queen_v_minor', 'queenEndgame'],
    ['queen_v_pieces', 'queenEndgame'],
    ['queen_rook', 'queenRookEndgame'],
    ['same_bishops', 'bishopEndgame'],
    ['opposite_bishops', 'bishopEndgame'],
    ['knight', 'knightEndgame'],
    ['basic_mate', 'endgame'],
    ['bishop_v_knight', 'endgame'],
    ['minor_v_pawns', 'endgame'],
    ['two_minors', 'endgame'],
    ['other', 'endgame'],
  ])('%s → %s', (family, theme) => {
    expect(puzzleThemeFor(family)).toBe(theme);
  });
});

describe('lessonGroupFor', () => {
  it('maps the taught families and nothing else', () => {
    expect(lessonGroupFor('basic_mate')).toBe('basic_mates');
    expect(lessonGroupFor('kp_v_k')).toBe('king_pawn');
    expect(lessonGroupFor('pawn')).toBe('king_pawn');
    expect(lessonGroupFor('queen_v_pawns')).toBe('queen_pawn');
    expect(lessonGroupFor('rook')).toBe('rook_pawn');
    const mapped = new Set(['basic_mate', 'kp_v_k', 'pawn', 'queen_v_pawns', 'rook']);
    for (const f of ENDGAME_FAMILIES) if (!mapped.has(f)) expect(lessonGroupFor(f)).toBeUndefined();
    expect(lessonFamilyFor).toBe(lessonGroupFor);
  });
});
