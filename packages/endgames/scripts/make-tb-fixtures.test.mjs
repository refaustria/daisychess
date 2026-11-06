// make-tb-fixtures.mjs without the network: deterministic legal random positions, the compact
// answer format and the argument parser. The API run itself is manual (never in CI).
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  CORE_MATERIALS,
  ROOK_MATERIALS,
  compactAnswer,
  mulberry32,
  parseArgs,
  randomPosition,
  randomPositions,
} from './make-tb-fixtures.mjs';

const material = (fen) => {
  const placement = fen.split(' ')[0];
  const side = (re) =>
    [...placement]
      .filter((c) => re.test(c))
      .sort()
      .join('');
  return [side(/[KQRBNP]/), side(/[kqrbnp]/)];
};

describe('make-tb-fixtures', () => {
  it('draws legal positions of the requested material, deterministically', () => {
    const a = randomPositions('KRPvKR', 50, mulberry32(7));
    const b = randomPositions('KRPvKR', 50, mulberry32(7));
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(50);
    for (const fen of a) {
      const chess = new Chess(fen);
      expect(fen).toMatch(/ [wb] - - 0 1$/);
      expect(material(fen)).toEqual(['KPR', 'kr']);
      // the side not to move is not in check
      const flipped = new Chess(fen.replace(/ ([wb]) /, (_, t) => ` ${t === 'w' ? 'b' : 'w'} `));
      expect(flipped.inCheck()).toBe(false);
      expect(chess.board().flat().filter(Boolean)).toHaveLength(5);
    }
  });

  it('never puts pawns on the first or last rank', () => {
    const rng = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const ranks = randomPosition('KPvK', rng).split(' ')[0].split('/');
      expect(ranks[0]).not.toMatch(/P/);
      expect(ranks[7]).not.toMatch(/P/);
    }
  });

  it('writes compact answers', () => {
    const json = {
      category: 'win',
      dtz: 16,
      precise_dtz: null,
      checkmate: false,
      stalemate: false,
      moves: [
        { uci: 'a1a2', category: 'loss', dtz: -15, precise_dtz: -15 },
        { uci: 'b7b8q', category: 'draw', dtz: 0, precise_dtz: 0 },
        { uci: 'b7b8n', category: 'unknown', dtz: null, precise_dtz: null },
      ],
    };
    expect(compactAnswer('fen', 'KPvK', json)).toEqual({
      fen: 'fen',
      material: 'KPvK',
      category: 'win',
      dtz: '~16',
      checkmate: false,
      stalemate: false,
      moves: ['a1a2 loss -15', 'b7b8q draw 0', 'b7b8n unknown -'],
    });
  });

  it('parses its arguments', () => {
    expect(parseArgs(['--from-api', '--core', '3', '--rook', '2', '--seed', '9'])).toMatchObject({
      fromApi: true,
      core: 3,
      rook: 2,
      seed: 9,
    });
    expect(parseArgs([]).fromApi).toBe(false);
    expect(() => parseArgs(['--core'])).toThrow();
    expect(() => parseArgs(['--x'])).toThrow();
    expect(CORE_MATERIALS).toEqual(['KQvK', 'KRvK', 'KPvK', 'KBBvK', 'KBNvK', 'KQvKP']);
    expect(ROOK_MATERIALS).toEqual(['KRPvKR']);
  });
});
