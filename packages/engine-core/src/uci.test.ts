import { describe, expect, it } from 'vitest';
import {
  mergePolicy,
  parseLc0MoveStats,
  parseUciBestMove,
  parseUciInfo,
  topPolicy,
} from './index.js';

describe('parseUciInfo', () => {
  it('parses a full line', () => {
    expect(
      parseUciInfo(
        'info depth 18 seldepth 25 multipv 2 score cp 35 nodes 1234 nps 1200000 time 100 pv e2e4 e7e5 g1f3',
      ),
    ).toEqual({
      depth: 18,
      seldepth: 25,
      multipv: 2,
      score: { cp: 35 },
      nodes: 1234,
      nps: 1200000,
      time: 100,
      pv: ['e2e4', 'e7e5', 'g1f3'],
    });
  });
  it('defaults multipv to 1 and omits optional fields', () => {
    expect(parseUciInfo('info depth 5 score cp -12 pv d2d4')).toEqual({
      depth: 5,
      multipv: 1,
      score: { cp: -12 },
      pv: ['d2d4'],
    });
  });
  it('parses mate scores', () => {
    expect(parseUciInfo('info depth 9 score mate -3 pv h7h8')?.score).toEqual({ mate: -3 });
  });
  it('ignores bound tokens', () => {
    expect(parseUciInfo('info depth 9 score cp 20 lowerbound pv e2e4')?.score).toEqual({ cp: 20 });
    expect(parseUciInfo('info depth 9 score cp 20 upperbound pv e2e4')?.score).toEqual({ cp: 20 });
  });
  it('returns null for unusable lines', () => {
    expect(parseUciInfo('info depth 9 score cp 20')).toBeNull();
    expect(parseUciInfo('info depth 9 pv e2e4')).toBeNull();
    expect(parseUciInfo('info depth 9 currmove e2e4 currmovenumber 1')).toBeNull();
    expect(parseUciInfo('info string hello')).toBeNull();
    expect(parseUciInfo('bestmove e2e4')).toBeNull();
    expect(parseUciInfo('')).toBeNull();
  });
});

describe('parseUciBestMove', () => {
  it('parses move and ponder', () => {
    expect(parseUciBestMove('bestmove e2e4 ponder e7e5')).toEqual({ move: 'e2e4', ponder: 'e7e5' });
  });
  it('parses move only', () => expect(parseUciBestMove('bestmove g1f3')).toEqual({ move: 'g1f3' }));
  it('returns null for (none) and other lines', () => {
    expect(parseUciBestMove('bestmove (none)')).toBeNull();
    expect(parseUciBestMove('bestmove')).toBeNull();
    expect(parseUciBestMove('info depth 1')).toBeNull();
  });
});

describe('Lc0 specifics (ADR-019)', () => {
  it('parseUciBestMove treats the null moves 0000 and a1a1 like (none)', () => {
    expect(parseUciBestMove('bestmove a1a1')).toBeNull();
    expect(parseUciBestMove('bestmove 0000')).toBeNull();
    expect(parseUciBestMove('bestmove e2e4 ponder a1a1')).toEqual({ move: 'e2e4' });
    expect(parseUciBestMove('bestmove a7a8q')).toEqual({ move: 'a7a8q' });
  });

  it('parseLc0MoveStats reads the move and its policy prior from a VerboseMoveStats line', () => {
    expect(
      parseLc0MoveStats(
        'info string e2e4  (322 ) N:       0 (+ 0) (P: 50.22%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q:  0.04017) (U: 0.87639) (S:  0.91655) (V:  -.----) ',
      ),
    ).toEqual({ uci: 'e2e4', p: 0.5022 });
    expect(
      parseLc0MoveStats(
        'info string a7a8q (1792) N:       0 (+ 0) (P: 83.59%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q:  0.81493) (U: 1.45880) (S:  2.27373) (V:  -.----) ',
      ),
    ).toEqual({ uci: 'a7a8q', p: 0.8359 });
    expect(
      parseLc0MoveStats(
        'info string d2d4  (293 ) N:      46 (+ 0) (P: 23.34%) (WL:  0.04694) (D: 0.040) (M:  2.6) (Q:  0.04694) (U: 0.10699) (S:  0.15628) (V:  0.0468) ',
      ),
    ).toEqual({ uci: 'd2d4', p: 0.2334 });
    // Lc0's root summary, other info strings and ordinary info lines are not policy entries.
    expect(
      parseLc0MoveStats(
        'info string node  (  20) N:     151 (+ 0) (P: 89.23%) (WL:  0.03473) (D: 0.038) (M:  3.8) (Q:  0.03473) (V:  0.0402) ',
      ),
    ).toBeNull();
    expect(parseLc0MoveStats('info string fake search started')).toBeNull();
    expect(parseLc0MoveStats('info depth 1 seldepth 1 nodes 1 score cp 99 pv e2e4')).toBeNull();
    expect(parseLc0MoveStats('info string e2e4 (322) N: 0 (+ 0) (P: 150%)')).toBeNull();
    expect(parseLc0MoveStats('info string e2e4 (322) N: 0 (+ 0)')).toBeNull();
  });

  it('topPolicy returns the n most probable entries, most probable first', () => {
    const entries = [
      { uci: 'a2a3', p: 0.01 },
      { uci: 'e2e4', p: 0.5 },
      { uci: 'd2d4', p: 0.23 },
      { uci: 'c2c4', p: 0.05 },
      { uci: 'g1f3', p: 0.05 },
      { uci: 'b1c3', p: 0.02 },
    ];
    expect(topPolicy(entries).map((e) => e.uci)).toEqual(['e2e4', 'd2d4', 'c2c4', 'g1f3', 'b1c3']);
    expect(topPolicy(entries, 2)).toEqual([
      { uci: 'e2e4', p: 0.5 },
      { uci: 'd2d4', p: 0.23 },
    ]);
    expect(topPolicy([], 5)).toEqual([]);
    expect(topPolicy(entries, 0)).toEqual([]);
  });
});

describe('mergePolicy (ADR-024 policyMoves)', () => {
  const entries = [
    { uci: 'a2a3', p: 0.01 },
    { uci: 'e2e4', p: 0.5 },
    { uci: 'h2h4', p: 0.002 },
    { uci: 'd2d4', p: 0.2 },
    { uci: 'c2c4', p: 0.05 },
    { uci: 'g1f3', p: 0.04 },
    { uci: 'e2e3', p: 0.03 },
    { uci: 'b1c3', p: 0.02 },
  ];

  it('without requested moves equals topPolicy', () => {
    expect(mergePolicy(entries, [])).toEqual(topPolicy(entries, 5));
  });

  it('adds requested moves outside the top n, keeps the result sorted, skips duplicates and unknown moves', () => {
    expect(mergePolicy(entries, ['h2h4', 'e2e4', 'e7e5', 'a2a3', 'h2h4'])).toEqual([
      { uci: 'e2e4', p: 0.5 },
      { uci: 'd2d4', p: 0.2 },
      { uci: 'c2c4', p: 0.05 },
      { uci: 'g1f3', p: 0.04 },
      { uci: 'e2e3', p: 0.03 },
      { uci: 'a2a3', p: 0.01 },
      { uci: 'h2h4', p: 0.002 },
    ]);
  });

  it('respects n and handles empty input', () => {
    expect(mergePolicy(entries, ['b1c3'], 2).map((e) => e.uci)).toEqual(['e2e4', 'd2d4', 'b1c3']);
    expect(mergePolicy([], ['e2e4'])).toEqual([]);
  });
});
