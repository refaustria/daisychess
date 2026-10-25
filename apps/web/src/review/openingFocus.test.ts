import { Chess } from 'chess.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { findOpening, getBook, loadOpenings, toEpd, type Opening } from '../openings';
import { Book, type OpeningRow } from '../openings/book';
import type { MoveDetail, MoveDetails } from './details';
import {
  alternativesText,
  computeOpeningFocus,
  moverSwingText,
  plyLabel,
  shortName,
} from './openingFocus';

function epdsOf(sans: readonly string[]): string[] {
  const c = new Chess();
  const out = [toEpd(c.fen())];
  for (const m of sans) out.push(toEpd(c.move(m).after));
  return out;
}

const split = (line: string) => line.split(' ').filter(Boolean);

/** A row with the real EPD of its line (so the position lookup works). */
const row = (eco: string, name: string, line: string): OpeningRow => [
  eco,
  name,
  epdsOf(split(line)).at(-1)!,
  line,
];

const ROWS: OpeningRow[] = [
  row('C20', "King's Pawn Game", 'e4 e5'),
  row('C40', "King's Knight Opening", 'e4 e5 Nf3'),
  row('C50', 'Italian Game', 'e4 e5 Nf3 Nc6 Bc4'),
  row('C50', 'Italian Game: Giuoco Piano', 'e4 e5 Nf3 Nc6 Bc4 Bc5'),
  row('C50', 'Italian Game: Giuoco Pianissimo', 'e4 e5 Nf3 Nc6 Bc4 Bc5 d3'),
  row('C53', 'Italian Game: Classical Variation', 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3'),
  row('C55', 'Italian Game: Two Knights Defense', 'e4 e5 Nf3 Nc6 Bc4 Nf6'),
  row('A06', 'Zukertort Opening', 'Nf3 d5'),
  row('D02', "Queen's Pawn Game: Zukertort Variation", 'd4 d5 Nf3'),
  row('D02', "Queen's Pawn Game: Symmetrical Variation", 'd4 d5 Nf3 Nf6'),
];
const book = new Book(ROWS);
const byEpd = new Map(book.openings.map((o) => [o.epd, o] as const));
/** Same contract as `findOpening` of `openings/index.ts` over the small table. */
function lookup(positions: string[]): Opening | null {
  for (let ply = positions.length - 1; ply >= 0; ply--) {
    const o = byEpd.get(positions[ply]!);
    if (o) return { eco: o.eco, name: o.name, moves: o.moves, ply };
  }
  return null;
}

function focus(line: string, details?: MoveDetails) {
  const sans = split(line);
  return computeOpeningFocus({ sans, epds: epdsOf(sans), book, findOpening: lookup, details });
}

/** A detail with only the fields the focus reads. */
const detail = (ply: number, before: number, after: number): MoveDetail =>
  ({
    ply,
    mover: ply % 2 === 1 ? 'white' : 'black',
    evalBeforeWhite: { cp: before },
    evalAfterWhite: { cp: after },
  }) as MoveDetail;

describe('computeOpeningFocus (small book)', () => {
  it('a game that stays in book', () => {
    expect(focus('e4 e5 Nf3 Nc6 Bc4 Bc5')).toEqual({
      openingName: 'Italian Game: Giuoco Piano',
      eco: 'C50',
      lastBookPly: 6,
      leftBy: null,
    });
  });

  it('White leaves the book: alternatives, swing from the details', () => {
    const f = focus('e4 e5 Nf3 Nc6 Bc4 Bc5 Nc3 Nf6', { 7: detail(7, 30, -10) });
    expect(f).toMatchObject({
      openingName: 'Italian Game: Giuoco Piano',
      eco: 'C50',
      lastBookPly: 6,
      leftBy: 'white',
      leavePly: 7,
      bookMoveInstead: [
        { san: 'c3', name: 'Italian Game: Classical Variation' },
        { san: 'd3', name: 'Italian Game: Giuoco Pianissimo' },
      ],
    });
    expect(f.evalSwingAtLeave).toBeCloseTo(-0.4);
    expect(f.endOfBook).toBeUndefined();
  });

  it('Black leaves the book', () => {
    const f = focus('e4 e5 Nf3 d6');
    expect(f).toMatchObject({
      openingName: "King's Knight Opening",
      lastBookPly: 3,
      leftBy: 'black',
      leavePly: 4,
      bookMoveInstead: [{ san: 'Nc6', name: 'Italian Game' }],
    });
    expect(f.evalSwingAtLeave).toBeUndefined();
  });

  it('the move after the end of a book line is marked as end of book', () => {
    const f = focus('e4 e5 Nf3 Nc6 Bc4 Bc5 d3 h6');
    expect(f).toMatchObject({ lastBookPly: 7, leftBy: 'black', leavePly: 8, endOfBook: true });
    expect(f.bookMoveInstead).toBeUndefined();
  });

  it('a transposition into a book position stays in book (position beats move order)', () => {
    // 1. Nf3 d5 2. d4 is not a book move order here, but reaches the position of 1. d4 d5 2. Nf3.
    const f = focus('Nf3 d5 d4 Nf6 e3');
    expect(f).toMatchObject({
      openingName: "Queen's Pawn Game: Symmetrical Variation",
      eco: 'D02',
      lastBookPly: 4,
      leftBy: 'white',
      leavePly: 5,
      endOfBook: true,
    });
  });

  it('no book moves at all', () => {
    const f = focus('a3 e5');
    expect(f).toEqual({
      lastBookPly: 0,
      leftBy: 'white',
      leavePly: 1,
      bookMoveInstead: [
        { san: 'e4', name: "King's Pawn Game" },
        { san: 'd4', name: "Queen's Pawn Game: Zukertort Variation" },
        { san: 'Nf3', name: 'Zukertort Opening' },
      ],
    });
  });

  it('mate scores give no swing; an empty game is in book with no name', () => {
    const d = { ...detail(7, 30, 0), evalAfterWhite: { mate: -3 } } as MoveDetail;
    expect(focus('e4 e5 Nf3 Nc6 Bc4 Bc5 Nc3', { 7: d }).evalSwingAtLeave).toBeUndefined();
    expect(focus('')).toEqual({ lastBookPly: 0, leftBy: null });
  });
});

describe('text helpers', () => {
  it('plyLabel, shortName, alternativesText, moverSwingText', () => {
    expect(plyLabel(11, 'Nc3')).toBe('6. Nc3');
    expect(plyLabel(10, 'Nf6')).toBe('5... Nf6');
    expect(shortName('Italian Game: Giuoco Pianissimo', 'Italian Game: Giuoco Piano')).toBe(
      'Giuoco Pianissimo',
    );
    expect(shortName('Ruy Lopez: Open', 'Italian Game')).toBe('Ruy Lopez: Open');
    expect(shortName('Italian Game')).toBe('Italian Game');
    expect(
      alternativesText(
        [{ san: 'd3', name: 'Italian Game: Giuoco Pianissimo' }, { san: 'h3' }],
        'Italian Game',
      ),
    ).toBe('d3 (Giuoco Pianissimo), h3');
    expect(moverSwingText(-0.4, 'white')).toBe('−0.4');
    expect(moverSwingText(-0.4, 'black')).toBe('+0.4');
    expect(moverSwingText(0.01, 'white')).toBe('0.0');
  });
});

describe('computeOpeningFocus (vendored table)', () => {
  beforeAll(loadOpenings);

  const EVERGREEN =
    '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';

  it('the Evergreen game: Evans Gambit, book until 7...d3', () => {
    const c = new Chess();
    c.loadPgn(EVERGREEN);
    const sans = c.history();
    const f = computeOpeningFocus({
      sans,
      epds: epdsOf(sans),
      book: getBook()!,
      findOpening,
    });
    expect(f.openingName).toMatch(/Evans Gambit/);
    expect(f.eco).toBe('C52');
    expect(f.lastBookPly).toBe(14);
    expect(f.leftBy).toBe('white');
    expect(f.leavePly).toBe(15);
  });

  it('a real transposition stays in book and the walk continues from the named line', () => {
    // 1. Nf3 e6 2. c4 d5 is not a book move order, but reaches the Agincourt Defense
    // (1. c4 e6 2. Nf3 d5); the game then follows that variation's book.
    const sans = split('Nf3 e6 c4 d5 g3 Nf6 Bg2 dxc4');
    const book = getBook()!;
    expect(book.inBook(sans.slice(0, 4))).toBe(false);
    const f = computeOpeningFocus({ sans, epds: epdsOf(sans), book, findOpening });
    expect(f.leftBy).toBeNull();
    expect(f.lastBookPly).toBe(8);
    expect(f.openingName).toMatch(/^English Opening: Agincourt Defense/);
  });
});
