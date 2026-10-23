import { describe, expect, it } from 'vitest';
import { splitPgnGames } from './pgn';

const g1 = '[Event "A"]\n[White "W1"]\n[Black "B1"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 1-0';
const g2 = '[Event "B"]\n[White "W2"]\n[Black "B2"]\n[Result "0-1"]\n\n1. f3 e5 2. g4 Qh4# 0-1';

describe('splitPgnGames', () => {
  it('returns [] for empty input', () => {
    expect(splitPgnGames('  \n ')).toEqual([]);
  });
  it('splits a two-game file', () => {
    const games = splitPgnGames(`${g1}\n\n${g2}\n`);
    expect(games).toEqual([g1, g2]);
  });
  it('keeps a single game intact', () => {
    expect(splitPgnGames(g1 + '\n')).toEqual([g1]);
  });
  it('handles tagless input', () => {
    expect(splitPgnGames('1. e4 e5 2. Nf3 *')).toEqual(['1. e4 e5 2. Nf3 *']);
    expect(splitPgnGames('1. e4 e5 *\n\n1. d4 d5 *')).toEqual(['1. e4 e5 *', '1. d4 d5 *']);
  });
  it('splits tagged games without an Event tag', () => {
    const a = '[White "A"]\n[Black "B"]\n\n1. e4 e5 *';
    const b = '[White "C"]\n[Black "D"]\n\n1. d4 d5 *';
    expect(splitPgnGames(`${a}\n\n${b}`)).toEqual([a, b]);
    expect(splitPgnGames(a)).toEqual([a]);
  });
  it('handles Windows line endings', () => {
    const crlf = `${g1}\n\n${g2}`.replace(/\n/g, '\r\n');
    expect(splitPgnGames(crlf)).toEqual([g1, g2]);
  });
});
