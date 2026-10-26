import { describe, expect, it } from 'vitest';
import { bandOf, buildDictionary, decodeRow, encodeRow, rowEncoder } from './rows.js';
import { PuzzleRowSchema } from './schemas.js';
import type { CsvPuzzle } from './csv.js';
import { fixturePuzzles } from '../test/fixture.js';

const P: CsvPuzzle = {
  id: 'abc12',
  fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
  moves: ['f2g3', 'e6e7'],
  rating: 1811,
  rd: 76,
  popularity: 95,
  nbPlays: 1000,
  themes: ['short', 'fork'],
  openings: ['Sicilian_Defense', 'Sicilian_Defense_Open'],
  game: '787zsVup/black#48',
};

describe('bandOf', () => {
  it('floors to 100 and clamps to 500…2900', () => {
    expect(bandOf(1811)).toBe(1800);
    expect(bandOf(1800)).toBe(1800);
    expect(bandOf(1799)).toBe(1700);
    expect(bandOf(320)).toBe(500);
    expect(bandOf(3150)).toBe(2900);
  });
});

describe('buildDictionary', () => {
  it('sorts themes and openings and marks first tags as families', () => {
    const d = buildDictionary([P, { themes: ['mate'], openings: ['Italian_Game'] }]);
    expect(d.themes).toEqual(['fork', 'mate', 'short']);
    expect(d.openings).toEqual(['Italian_Game', 'Sicilian_Defense', 'Sicilian_Defense_Open']);
    expect(d.families).toEqual([0, 1]);
  });
});

describe('encodeRow / decodeRow', () => {
  it('round-trips a puzzle', () => {
    const d = buildDictionary([P]);
    const row = encodeRow(P, d);
    expect(PuzzleRowSchema.parse(row)).toEqual(row);
    expect(row).toEqual([P.id, P.fen, 'f2g3 e6e7', 1811, 76, [1, 0], [0, 1], P.game]);
    expect(decodeRow(row, d)).toEqual({
      id: P.id,
      fen: P.fen,
      moves: P.moves,
      rating: 1811,
      rd: 76,
      themes: ['short', 'fork'],
      openings: P.openings,
      game: P.game,
      source: 'lichess',
    });
  });

  it('round-trips the whole fixture', () => {
    const d = buildDictionary(fixturePuzzles);
    const enc = rowEncoder(d);
    for (const p of fixturePuzzles) {
      const back = decodeRow(PuzzleRowSchema.parse(enc(p)), d);
      expect(back.moves).toEqual(p.moves);
      expect(back.themes).toEqual(p.themes);
      expect(back.openings).toEqual(p.openings);
    }
  });

  it('omits an empty game', () => {
    const d = buildDictionary([P]);
    expect('game' in decodeRow(encodeRow({ ...P, game: '' }, d), d)).toBe(false);
  });

  it('throws on keys missing from the dictionary or indexes out of range', () => {
    const d = buildDictionary([P]);
    expect(() => encodeRow({ ...P, themes: ['zugzwang'] }, d)).toThrow(RangeError);
    const row = encodeRow(P, d);
    expect(() => decodeRow([...row.slice(0, 5), [9], row[6], row[7]] as typeof row, d)).toThrow(
      RangeError,
    );
    expect(() => decodeRow([...row.slice(0, 6), [7], row[7]] as typeof row, d)).toThrow(RangeError);
  });
});
