import { describe, expect, it } from 'vitest';
import { scholarSummary } from '../review/testFixtures';
import type { MaiaHint } from './hints';
import { hintLines, hintShortText, levelSource, levelText, pct, typicalMistakes } from './hintText';

const hint = (over: Partial<MaiaHint> = {}): MaiaHint => ({
  ply: 6,
  rating: 1500,
  top: [
    { uci: 'g1f3', san: 'Nf3', p: 0.41 },
    { uci: 'd2d3', san: 'd3', p: 0.2 },
    { uci: 'f1c4', san: 'Bc4', p: 0.08 },
  ],
  playedP: 0.08,
  playedIsTop: false,
  entries: 5,
  minP: 0.04,
  ...over,
});
const L1500 = { rating: 1500 };

describe('hint text', () => {
  it('percentages', () => {
    expect(pct(0.41)).toBe('41%');
    expect(pct(0.004)).toBe('<1%');
    expect(pct(1)).toBe('100%');
  });

  it('"At 1500, 41% would play Nf3 here" with the played move and its share', () => {
    expect(
      hintLines(hint(), { playedSan: 'Bc4', bestSan: 'Nf3', classification: 'blunder' }, L1500),
    ).toEqual(['At 1500, 41% would play Nf3 here (Bc4?? in the game: 8%).']);
    // Played move outside the top 5: bounded by the smallest probability shown.
    expect(
      hintLines(
        hint({ playedP: undefined }),
        { playedSan: 'a4', bestSan: 'Nf3', classification: 'mistake' },
        L1500,
      ),
    ).toEqual(['At 1500, 41% would play Nf3 here (a4? in the game: under 4%).']);
  });

  it('exact shares when the server returned the requested moves (playedExact, ADR-024)', () => {
    // Without policyMoves the played move outside the top 5 is "under 4%" (above); with them the
    // exact share is known and shown, and the engine move gets its exact share too.
    expect(
      hintLines(
        hint({ playedP: 0.012, playedExact: true, bestP: 0.021, bestExact: true }),
        { playedSan: 'a4', bestSan: 'Qh5', classification: 'mistake' },
        L1500,
      ),
    ).toEqual([
      'At 1500, 41% would play Nf3 here (a4? in the game: 1%).',
      'The engine move Qh5 is hard to find: only 2% at 1500.',
    ]);
  });

  it('"A very common mistake at 1500" when the mistake is Maia\'s top move', () => {
    const h = hint({
      top: [
        { uci: 'g8f6', san: 'Nf6', p: 0.38 },
        { uci: 'g7g6', san: 'g6', p: 0.3 },
      ],
      playedP: 0.38,
      bestP: 0.3,
      playedIsTop: true,
    });
    expect(
      hintLines(h, { playedSan: 'Nf6', bestSan: 'g6', classification: 'mistake' }, L1500),
    ).toEqual(['A very common mistake at 1500: 38% of players play this.']);
    expect(
      hintLines(h, { playedSan: 'Nf6', bestSan: 'g6', classification: 'blunder' }, L1500)[0],
    ).toBe('A very common blunder at 1500: 38% of players play this.');
  });

  it('"The engine move Qh5 is hard to find" when humans rarely choose it', () => {
    expect(
      hintLines(
        hint({ bestP: 0.03 }),
        { playedSan: 'Bc4', bestSan: 'Qh5', classification: 'mistake' },
        L1500,
      ),
    ).toEqual([
      'At 1500, 41% would play Nf3 here (Bc4? in the game: 8%).',
      'The engine move Qh5 is hard to find: only 3% at 1500.',
    ]);
    // Not even in the top 5, whose smallest share is below 5%.
    expect(
      hintLines(
        hint({ minP: 0.02 }),
        { playedSan: 'Bc4', bestSan: 'Qh5', classification: 'mistake' },
        L1500,
      )[1],
    ).toBe('The engine move Qh5 is hard to find: under 2% at 1500.');
    // Commonly found engine move: no second line.
    expect(
      hintLines(
        hint({ bestP: 0.2 }),
        { playedSan: 'Bc4', bestSan: 'd3', classification: 'mistake' },
        L1500,
      ),
    ).toHaveLength(1);
  });

  it('time trouble: an unusual move is called a slip', () => {
    expect(
      hintLines(
        hint({ minP: 0.06, playedP: 0.07 }),
        { playedSan: 'Bc4', bestSan: 'Nf3', classification: 'blunder' },
        L1500,
        { timeTrouble: true },
      ),
    ).toEqual([
      'At 1500, 41% would play Nf3 here (Bc4?? in the game: 7%).',
      'Unusual at 1500 — likely a time-trouble slip.',
    ]);
  });

  it('shows the clamped level with its note', () => {
    const lines = hintLines(
      hint({ rating: 1900 }),
      { playedSan: 'Bc4', bestSan: 'Nf3', classification: 'mistake' },
      { rating: 1900, note: "Maia's highest level" },
    );
    expect(lines[0]).toBe(
      "At 1900 (Maia's highest level), 41% would play Nf3 here (Bc4? in the game: 8%).",
    );
    expect(levelText({ rating: 1500 })).toBe('1500');
    expect(levelSource({ rating: 1500, source: 'pgn', elo: 1523 })).toBe(
      'Maia 1500 — from the PGN rating 1523',
    );
    expect(levelSource({ rating: 1500, source: 'setting' })).toBe(
      'Maia 1500 — your level setting (no rating in the PGN)',
    );
  });

  it('short version for the tour only for a common mistake', () => {
    expect(hintShortText(hint({ playedIsTop: true }))).toBe('common at 1500');
    expect(hintShortText(hint())).toBeUndefined();
    expect(hintShortText(undefined)).toBeUndefined();
  });

  it('typical mistakes per side', () => {
    const summary = scholarSummary();
    // Scholar: ply 5 (white) inaccuracy — not counted; ply 6 (black) blunder.
    expect(typicalMistakes(summary, {})).toEqual({
      white: { typical: 0, unusual: 0, pending: 0 },
      black: { typical: 0, unusual: 0, pending: 1 },
    });
    expect(typicalMistakes(summary, { 6: hint({ playedIsTop: true }) }).black).toEqual({
      typical: 1,
      unusual: 0,
      pending: 0,
    });
    expect(typicalMistakes(summary, { 6: hint() }).black).toEqual({
      typical: 0,
      unusual: 1,
      pending: 0,
    });
  });
});
