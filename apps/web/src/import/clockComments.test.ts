import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  deriveClocks,
  formatClkComment,
  isCorrespondence,
  mainlineComments,
  parseClockComment,
  parseClockValue,
  parsePgnClocks,
  parseTimeControl,
} from './clockComments';

const LICHESS = `[Event "Rated blitz game"]
[Site "https://lichess.org/abcdefgh"]
[White "Ann"]
[Black "Bob"]
[Result "*"]
[TimeControl "180+2"]

1. e4 { [%clk 0:03:00] } 1... e5 { [%clk 0:03:00] } 2. Nf3 { [%clk 0:02:55.4] } 2... Nc6 { [%clk 0:02:41] } 3. Bb5 { [%clk 0:02:50.2] } *
`;

// As served by api.chess.com (TimeControl in seconds, tenths in %clk, no spaces in comments).
const CHESSCOM = `[Event "Live Chess"]
[Site "Chess.com"]
[White "ann"]
[Black "bob"]
[Result "1-0"]
[TimeControl "600"]
[Termination "ann won by resignation"]

1. d4 {[%clk 0:09:58.4]} 1... d5 {[%clk 0:09:57.1]} 2. c4 {[%clk 0:09:50]} 2... e6 {[%clk 0:09:40.6]} 1-0
`;

const moves = (pgn: string): number => {
  const c = new Chess();
  c.loadPgn(pgn);
  return c.history().length;
};

describe('parseTimeControl', () => {
  it('parses base+increment and base only', () => {
    expect(parseTimeControl('180+2')).toEqual({ initialMs: 180_000, incrementMs: 2_000 });
    expect(parseTimeControl('600')).toEqual({ initialMs: 600_000, incrementMs: 0 });
    expect(parseTimeControl('0+1')).toEqual({ initialMs: 0, incrementMs: 1_000 });
  });

  it('rejects unknown, daily and multi-stage controls', () => {
    for (const tc of [undefined, '', '-', '?', '1/86400', '40/7200:3600', 'abc']) {
      expect(parseTimeControl(tc)).toBeUndefined();
    }
  });

  it('detects correspondence', () => {
    expect(isCorrespondence('1/86400')).toBe(true);
    expect(isCorrespondence('1/259200')).toBe(true);
    expect(isCorrespondence('180+2')).toBe(false);
    expect(isCorrespondence(undefined)).toBe(false);
  });
});

describe('parseClockValue / parseClockComment', () => {
  it('parses h:mm:ss with and without tenths', () => {
    expect(parseClockValue('0:03:00')).toBe(180_000);
    expect(parseClockValue('0:02:55.4')).toBe(175_400);
    expect(parseClockValue('1:00:01')).toBe(3_601_000);
    expect(parseClockValue('2:05')).toBe(125_000);
    expect(parseClockValue('7.5')).toBe(7_500);
    expect(parseClockValue('0:61:00')).toBeUndefined();
    expect(parseClockValue('x')).toBeUndefined();
  });

  it('finds %clk and %emt among other text and commands', () => {
    expect(parseClockComment(' [%eval 0.3] [%clk 0:01:02.5] nice ')).toEqual({ clkMs: 62_500 });
    expect(parseClockComment('[%emt 0:00:12]')).toEqual({ emtMs: 12_000 });
    expect(parseClockComment('[%clk 0:00:09] [%emt 0:00:03]')).toEqual({ clkMs: 9_000, emtMs: 3_000 });
    expect(parseClockComment('just text')).toEqual({});
    expect(parseClockComment('[%clk broken]')).toEqual({});
  });
});

describe('mainlineComments', () => {
  it('maps comments to mainline plies and skips variations, NAGs and move numbers', () => {
    const pgn = `[Event "x"]

{ intro } 1. e4 $1 { a } { b } 1... e5 (1... c5 { var } 2. Nf3) 2.Nf3 ; rest of line
2... Nc6 3. Bb5 *`;
    expect(mainlineComments(pgn)).toEqual([[' a ', ' b '], [], [' rest of line'], [], []]);
  });

  it('handles comments spanning lines and stops at the result', () => {
    const pgn = '1. e4 {[%clk\n0:00:10]} 1-0 2. d4';
    expect(mainlineComments(pgn)).toEqual([['[%clk\n0:00:10]']]);
  });

  it('stops at the next game', () => {
    expect(mainlineComments('1. e4 e5\n\n[Event "2"]\n\n1. d4 *')).toHaveLength(2);
  });
});

describe('deriveClocks', () => {
  const tc = { initialMs: 180_000, incrementMs: 2_000 };

  it('derives spent time from %clk with the increment; lichess first moves spent 0', () => {
    const out = deriveClocks(
      [{ clkMs: 180_000 }, { clkMs: 180_000 }, { clkMs: 170_000 }, { clkMs: 150_000 }],
      tc,
    );
    expect(out).toEqual([
      { remainingMs: 180_000, spentMs: 0 },
      { remainingMs: 180_000, spentMs: 0 },
      { remainingMs: 170_000, spentMs: 12_000 },
      { remainingMs: 150_000, spentMs: 32_000 },
    ]);
  });

  it('uses the initial time for each side’s first move (chess.com tenths)', () => {
    const out = deriveClocks([{ clkMs: 598_400 }, { clkMs: 597_100 }], {
      initialMs: 600_000,
      incrementMs: 0,
    });
    expect(out).toEqual([
      { remainingMs: 598_400, spentMs: 1_600 },
      { remainingMs: 597_100, spentMs: 2_900 },
    ]);
  });

  it('derives remaining time from %emt only', () => {
    const out = deriveClocks([{ emtMs: 5_000 }, { emtMs: 10_000 }, { emtMs: 20_000 }], tc);
    expect(out).toEqual([
      { remainingMs: 177_000, spentMs: 5_000 },
      { remainingMs: 172_000, spentMs: 10_000 },
      { remainingMs: 159_000, spentMs: 20_000 },
    ]);
  });

  it('keeps %emt only without a time control', () => {
    expect(deriveClocks([{ emtMs: 5_000 }, undefined], undefined)).toEqual([
      { spentMs: 5_000 },
      undefined,
    ]);
  });

  it('leaves plies without comments undefined and resumes at the next %clk', () => {
    const out = deriveClocks(
      [{ clkMs: 178_000 }, undefined, undefined, { clkMs: 170_000 }, { clkMs: 160_000 }],
      tc,
    );
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBeUndefined();
    // Black's previous value is unknown (ply 2 missing): remaining only.
    expect(out[3]).toEqual({ remainingMs: 170_000 });
    // White's chain broke at ply 3: remaining only.
    expect(out[4]).toEqual({ remainingMs: 160_000 });
  });

  it('never reports negative spent time', () => {
    expect(deriveClocks([{ clkMs: 100_000 }, undefined, { clkMs: 110_000 }], tc)[2]).toEqual({
      remainingMs: 110_000,
      spentMs: 0,
    });
  });

  it('starts with Black when the position does', () => {
    const out = deriveClocks([{ clkMs: 170_000 }, { clkMs: 175_000 }, { clkMs: 160_000 }], tc, 'b');
    expect(out[2]).toEqual({ remainingMs: 160_000, spentMs: 12_000 });
  });
});

describe('parsePgnClocks', () => {
  it('lichess sample with tenths', () => {
    const r = parsePgnClocks(LICHESS, { TimeControl: '180+2' }, moves(LICHESS));
    expect(r.timeControl).toEqual({ initialMs: 180_000, incrementMs: 2_000 });
    expect(r.clocks).toEqual([
      { remainingMs: 180_000, spentMs: 0 },
      { remainingMs: 180_000, spentMs: 0 },
      { remainingMs: 175_400, spentMs: 6_600 },
      { remainingMs: 161_000, spentMs: 21_000 },
      { remainingMs: 170_200, spentMs: 7_200 },
    ]);
  });

  it('chess.com sample', () => {
    const r = parsePgnClocks(CHESSCOM, { TimeControl: '600' }, moves(CHESSCOM));
    expect(r.clocks.map((c) => c?.remainingMs)).toEqual([598_400, 597_100, 590_000, 580_600]);
    expect(r.clocks.map((c) => c?.spentMs)).toEqual([1_600, 2_900, 8_400, 16_500]);
  });

  it('daily games carry no live clock', () => {
    const pgn = '1. e4 {[%clk 23:59:59]} 1... e5 {[%clk 23:10:00]} *';
    expect(parsePgnClocks(pgn, { TimeControl: '1/86400' }, 2)).toEqual({ clocks: [] });
  });

  it('without comments or with a mismatching move count there are no clocks', () => {
    expect(parsePgnClocks('1. e4 e5 *', { TimeControl: '60+0' }, 2)).toEqual({
      timeControl: { initialMs: 60_000, incrementMs: 0 },
      clocks: [],
    });
    expect(parsePgnClocks('1. e4 {[%clk 0:01:00]} *', {}, 2)).toEqual({ clocks: [] });
  });

  it('without a TimeControl header keeps the raw remaining times', () => {
    const r = parsePgnClocks('1. e4 {[%clk 0:05:00]} 1... e5 *', {}, 2);
    expect(r).toEqual({ clocks: [{ remainingMs: 300_000 }, undefined] });
  });
});

describe('formatClkComment', () => {
  it('writes h:mm:ss with tenths when present', () => {
    expect(formatClkComment(180_000)).toBe('0:03:00');
    expect(formatClkComment(175_400)).toBe('0:02:55.4');
    expect(formatClkComment(3_601_000)).toBe('1:00:01');
    expect(formatClkComment(-5)).toBe('0:00:00');
  });
});
