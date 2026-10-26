import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, lineIsLegal, parseCsvLine, rowFromCsv } from './csv.js';
import { fixtureLines, fixturePuzzles } from '../test/fixture.js';

const LINE =
  '00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1811,76,95,10282,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#48,,';

describe('parseCsvLine', () => {
  it('splits a lichess line into 11 fields', () => {
    const f = parseCsvLine(LINE);
    expect(f).toHaveLength(CSV_COLUMNS.length);
    expect(f[0]).toBe('00008');
    expect(f[9]).toBe('');
  });
  it('drops a trailing CR and handles RFC 4180 quotes', () => {
    expect(parseCsvLine('a,b\r')).toEqual(['a', 'b']);
    expect(parseCsvLine('"x,y",z,"say ""hi"""')).toEqual(['x,y', 'z', 'say "hi"']);
    expect(parseCsvLine('')).toEqual(['']);
  });
});

describe('lineIsLegal', () => {
  it('accepts a legal line and rejects illegal moves or FENs', () => {
    const fen = 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24';
    expect(lineIsLegal(fen, ['f2g3', 'e6e7'])).toBe(true);
    expect(lineIsLegal(fen, ['f2g3', 'e6e8'])).toBe(false);
    expect(lineIsLegal('not a fen', ['e2e4'])).toBe(false);
  });
});

describe('rowFromCsv', () => {
  it('parses a row', () => {
    const r = rowFromCsv(LINE);
    expect(r).toEqual({
      ok: true,
      puzzle: {
        id: '00008',
        fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
        moves: ['f2g3', 'e6e7', 'b2b1', 'b3c1', 'b1c1', 'h6c1'],
        rating: 1811,
        rd: 76,
        popularity: 95,
        nbPlays: 10282,
        themes: ['crushing', 'hangingPiece', 'long', 'middlegame'],
        openings: [],
        game: '787zsVup/black#48',
      },
    });
  });

  it('accepts fields as well as a line', () => {
    expect(rowFromCsv(parseCsvLine(LINE)).ok).toBe(true);
  });

  it('parses every row of the fixture (real data, all legal)', () => {
    expect(fixtureLines).toHaveLength(301);
    expect(fixturePuzzles).toHaveLength(300);
    expect(fixturePuzzles.some((p) => p.openings.length === 2)).toBe(true);
  });

  const reject = (mut: (f: string[]) => void, reason: string) => {
    const f = parseCsvLine(LINE);
    mut(f);
    expect(rowFromCsv(f)).toEqual({ ok: false, reason });
  };

  it('rejects the header, wrong column counts and bad fields', () => {
    expect(rowFromCsv(fixtureLines[0]!)).toEqual({ ok: false, reason: 'header' });
    expect(rowFromCsv('a,b,c')).toEqual({ ok: false, reason: 'columns' });
    reject((f) => (f[0] = 'bad id!'), 'id');
    reject((f) => (f[3] = '18.5'), 'number');
    reject((f) => (f[6] = ''), 'number');
    reject((f) => (f[1] = `${'p'.repeat(95)} w - - 0 1`), 'fen');
    reject((f) => (f[1] = 'r6k/pp2r2p b'), 'fen');
    reject((f) => (f[2] = 'f2g3'), 'moves');
    reject((f) => (f[2] = Array(21).fill('e2e4').join(' ')), 'moves');
    reject((f) => (f[2] = 'f2g3 E6E7'), 'moves');
    reject((f) => (f[7] = 'mate <script>'), 'themes');
    reject((f) => (f[9] = 'Sicilian/Defense'), 'openings');
    reject((f) => (f[2] = 'f2g3 e6e8'), 'illegal');
  });

  it('skips the legality check when asked (cheap pre-filter)', () => {
    const f = parseCsvLine(LINE);
    f[2] = 'f2g3 e6e8';
    expect(rowFromCsv(f, { checkLegality: false }).ok).toBe(true);
  });

  it('keeps only lichess game URLs', () => {
    const f = parseCsvLine(LINE);
    f[8] = 'https://example.com/x';
    const r = rowFromCsv(f);
    expect(r.ok && r.puzzle.game).toBe('');
  });
});
