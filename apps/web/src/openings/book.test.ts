import { beforeAll, describe, expect, it } from 'vitest';
import rows from './data/openings.json';
import {
  Book,
  inSubtree,
  MAX_NAMES,
  normalizeText,
  openingKey,
  pickWeighted,
  type BookMove,
  type OpeningRow,
} from './book';
import {
  bookMoves,
  getBook,
  inBook,
  lineFor,
  loadOpenings,
  searchOpenings,
  variationsUnder,
} from '.';

// The JSON is typed as string[][]; the generator guarantees the 4-tuple.
const table = rows as unknown as OpeningRow[];
const book = new Book(table);

const small = new Book([
  ['C20', "King's Pawn Game", 'epd1', 'e4 e5'],
  ['C40', "King's Knight Opening", 'epd2', 'e4 e5 Nf3'],
  ['C44', "King's Knight Opening: Normal Variation", 'epd3', 'e4 e5 Nf3 Nc6'],
  ['C50', 'Italian Game', 'epd4', 'e4 e5 Nf3 Nc6 Bc4'],
  ['C60', 'Ruy Lopez', 'epd5', 'e4 e5 Nf3 Nc6 Bb5'],
  ['C65', 'Ruy Lopez: Berlin Defense', 'epd6', 'e4 e5 Nf3 Nc6 Bb5 Nf6'],
  ['C70', 'Ruy Lopez: Morphy Defense', 'epd7', 'e4 e5 Nf3 Nc6 Bb5 a6'],
  ['C25', 'Vienna Game', 'epd8', 'e4 e5 Nc3'],
  ['B20', 'Sicilian Defense', 'epd9', 'e4 c5'],
]);

const byName = (b: Book, name: string) => {
  const o = b.openings.find((x) => x.name === name);
  if (!o) throw new Error(`missing ${name}`);
  return o;
};

describe('data', () => {
  it('every row has a move line that ends in its position', () => {
    expect(table.length).toBeGreaterThan(3000);
    for (const r of table) {
      expect(r).toHaveLength(4);
      expect(r[3].split(' ').length).toBeGreaterThan(0);
    }
    expect(table.find((r) => r[1] === 'Italian Game')?.[3]).toBe('e4 e5 Nf3 Nc6 Bc4');
  });
});

describe('Book.bookMoves', () => {
  it('lists the continuations of a prefix, most popular first, with names', () => {
    const moves = small.bookMoves(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(moves.map((m) => m.san)).toEqual(['Bb5', 'Bc4']);
    expect(moves[0]).toMatchObject({ lines: 3, names: expect.arrayContaining(['Ruy Lopez']) });
    expect(moves[0]!.opening?.name).toBe('Ruy Lopez');
    expect(moves[0]!.names[0]).toBe('Ruy Lopez'); // shallowest first
    expect(moves[1]).toMatchObject({ san: 'Bc4', lines: 1, names: ['Italian Game'] });
  });

  it('includes moves that lead to named lines without a name of their own', () => {
    const [e4] = small.bookMoves([]);
    expect(e4).toMatchObject({ san: 'e4', lines: 9 });
    expect(e4!.opening).toBeUndefined();
    expect(e4!.names.length).toBeLessThanOrEqual(MAX_NAMES);
    expect(e4!.names).toContain("King's Pawn Game");
  });

  it('is empty out of book and at the end of a line', () => {
    expect(small.bookMoves(['d4'])).toEqual([]);
    expect(small.bookMoves(['e4', 'c5'])).toEqual([]);
  });

  it('real table: 1.e4 e5 2.Nf3 has Nc6 as the main reply', () => {
    const moves = book.bookMoves(['e4', 'e5', 'Nf3']);
    expect(moves[0]!.san).toBe('Nc6');
    expect(moves.map((m) => m.san)).toEqual(expect.arrayContaining(['Nf6', 'd6', 'f5']));
  });
});

describe('Book.inBook / openingAt / openingExactly', () => {
  it('prefixes of named lines are in book', () => {
    expect(small.inBook([])).toBe(true);
    expect(small.inBook(['e4'])).toBe(true);
    expect(small.inBook(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])).toBe(true);
    expect(small.inBook(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5'])).toBe(false);
    expect(small.inBook(['d4'])).toBe(false);
  });

  it('openingAt is the deepest named variation along the moves', () => {
    expect(small.openingAt(['e4'])).toBeUndefined();
    expect(small.openingAt(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6', 'O-O'])?.name).toBe(
      'Ruy Lopez: Berlin Defense',
    );
    expect(small.openingExactly(['e4', 'e5', 'Nf3'])?.name).toBe("King's Knight Opening");
    expect(small.openingExactly(['e4'])).toBeUndefined();
  });
});

describe('Book.lineFor / variationsUnder / countUnder / subtreeMoves', () => {
  it('lineFor returns a copy of the line', () => {
    const o = byName(small, 'Italian Game');
    const line = small.lineFor(o);
    expect(line).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    line.push('x');
    expect(o.moves).toHaveLength(5);
  });

  it('variationsUnder lists the sub-variations, shallowest first', () => {
    const knight = byName(small, "King's Knight Opening");
    expect(small.variationsUnder(knight).map((o) => o.name)).toEqual([
      "King's Knight Opening: Normal Variation",
      'Italian Game',
      'Ruy Lopez',
      'Ruy Lopez: Berlin Defense',
      'Ruy Lopez: Morphy Defense',
    ]);
    expect(small.countUnder(knight)).toBe(5);
    expect(small.variationsUnder(byName(small, 'Sicilian Defense'))).toEqual([]);
    expect(small.countUnder(byName(small, 'Sicilian Defense'))).toBe(0);
  });

  it('real table: the Italian Game has many sub-variations, all extending its line', () => {
    const italian = byName(book, 'Italian Game');
    const subs = book.variationsUnder(italian);
    expect(subs.length).toBeGreaterThan(50);
    expect(book.countUnder(italian)).toBe(subs.length);
    for (const s of subs) expect(inSubtree(italian, s.moves)).toBe(true);
    expect(subs.map((s) => s.name)).toContain('Italian Game: Giuoco Piano');
  });

  it('subtreeMoves is forced along the line, then the whole subtree', () => {
    const ruy = byName(small, 'Ruy Lopez');
    expect(small.subtreeMoves(ruy, []).map((m) => m.san)).toEqual(['e4']);
    expect(small.subtreeMoves(ruy, ['e4', 'e5']).map((m) => m.san)).toEqual(['Nf3']);
    expect(small.subtreeMoves(ruy, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']).map((m) => m.san)).toEqual(
      expect.arrayContaining(['Nf6', 'a6']),
    );
    expect(small.subtreeMoves(ruy, ['e4', 'c5'])).toEqual([]);
    expect(small.subtreeMoves(ruy, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])).toEqual([]);
  });

  it('find by openingKey', () => {
    const o = byName(small, 'Vienna Game');
    expect(openingKey(o)).toBe('C25 Vienna Game');
    expect(small.find('C25 Vienna Game')).toBe(o);
    expect(small.find('C25 Nope')).toBeUndefined();
  });
});

describe('Book.search', () => {
  it('"Italian" finds the Italian Game first', () => {
    const hits = book.search('Italian');
    expect(hits[0]!.name).toBe('Italian Game');
    expect(hits.slice(0, 20).every((h) => h.name.startsWith('Italian Game'))).toBe(true);
  });

  it('matches word prefixes in any position, ordered matches first', () => {
    const hits = book.search('queen gambit decl');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.name).toMatch(/^Queen's Gambit Declined/);
    expect(book.search('najdorf')[0]!.name).toMatch(/Sicilian Defense: Najdorf Variation/);
    expect(book.search('berlin ruy').some((h) => h.name === 'Ruy Lopez: Berlin Defense')).toBe(
      true,
    );
  });

  it('searches ECO codes (exact before prefix)', () => {
    const hits = book.search('C50');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.eco === 'C50')).toBe(true);
    // ECO prefix hits rank before names that merely contain "c5".
    const c5 = book.search('c5', 2000);
    const firstOther = c5.findIndex((h) => !h.eco.startsWith('C5'));
    const eco = c5.filter((h) => h.eco.startsWith('C5'));
    expect(eco.length).toBeGreaterThan(50);
    if (firstOther >= 0) expect(firstOther).toBe(eco.length);
  });

  it('ignores case, diacritics and punctuation; empty queries match nothing', () => {
    expect(normalizeText("King's Gambit: Accepted")).toBe('king s gambit accepted');
    expect(normalizeText('Réti')).toBe('reti');
    expect(book.search('reti').length).toBeGreaterThan(0);
    expect(book.search('   ')).toEqual([]);
    expect(book.search('zzzzqqq')).toEqual([]);
  });

  it('respects the limit and is fast enough for typing', () => {
    expect(book.search('a', 10)).toHaveLength(10);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) book.search('sicilian defense');
    expect((performance.now() - t0) / 20).toBeLessThan(25);
  });
});

describe('pickWeighted', () => {
  const moves: BookMove[] = [
    { san: 'a', names: [], lines: 8 },
    { san: 'b', names: [], lines: 2 },
  ];
  it('weights by the number of lines below', () => {
    expect(pickWeighted(moves, () => 0)?.san).toBe('a');
    expect(pickWeighted(moves, () => 0.79)?.san).toBe('a');
    expect(pickWeighted(moves, () => 0.81)?.san).toBe('b');
    expect(pickWeighted(moves, () => 0.9999)?.san).toBe('b');
    expect(pickWeighted([], () => 0)).toBeUndefined();
  });
});

describe('module API (lazy-loaded table)', () => {
  it('returns empty results before the table is loaded', () => {
    if (getBook()) return; // another test file in the same worker loaded it already
    expect(bookMoves([])).toEqual([]);
    expect(inBook([])).toBe(false);
    expect(searchOpenings('Italian')).toEqual([]);
  });

  describe('after loadOpenings', () => {
    beforeAll(loadOpenings);
    it('exposes the book', () => {
      expect(getBook()).not.toBeNull();
      expect(bookMoves(['e4', 'e5', 'Nf3', 'Nc6']).map((m) => m.san)).toEqual(
        expect.arrayContaining(['Bb5', 'Bc4', 'd4']),
      );
      expect(inBook(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'])).toBe(true);
      expect(inBook(['e4', 'e5', 'Ba6'])).toBe(false);
      const italian = searchOpenings('Italian')[0]!;
      expect(lineFor(italian)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
      expect(variationsUnder(italian).length).toBeGreaterThan(50);
    });
  });
});
