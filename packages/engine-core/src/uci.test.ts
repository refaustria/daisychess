import { describe, expect, it } from 'vitest';
import { parseUciBestMove, parseUciInfo } from './index.js';

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
