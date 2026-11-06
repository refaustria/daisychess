import { describe, expect, it } from 'vitest';
import fixture from '../../test/fixtures/lichess-krpvkr-win.json';
import { LICHESS_CATEGORIES, LichessTablebaseSchema, normalizeLichess } from './lichess.js';
import { TB_CATEGORIES } from './types.js';

/** Real answer of tablebase.lichess.ovh for this FEN (fetched 2026-11-06). */
const FEN = '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1';

const clone = (): typeof fixture => JSON.parse(JSON.stringify(fixture)) as typeof fixture;

describe('LichessTablebaseSchema', () => {
  it('accepts the real API answer', () => {
    expect(LichessTablebaseSchema.safeParse(fixture).success).toBe(true);
  });

  it('rejects malformed answers', () => {
    expect(LichessTablebaseSchema.safeParse({}).success).toBe(false);
    expect(LichessTablebaseSchema.safeParse({ ...clone(), category: 'won' }).success).toBe(false);
    const bad = clone();
    bad.moves[0]!.uci = 'c1d9';
    expect(LichessTablebaseSchema.safeParse(bad).success).toBe(false);
  });

  it('knows every lichess category, the exact ones a subset', () => {
    expect(LICHESS_CATEGORIES).toContain('maybe-win');
    for (const c of TB_CATEGORIES) expect(LICHESS_CATEGORIES).toContain(c);
  });
});

describe('normalizeLichess', () => {
  it('normalises the real answer', () => {
    const pos = normalizeLichess(fixture, FEN);
    expect(pos).not.toBeNull();
    expect(pos!.fen).toBe(FEN);
    expect(pos!.category).toBe('win');
    expect(pos!.dtm).toBe(41);
    expect(pos!.dtz).toBe(15);
    expect(pos!.moves).toHaveLength(14);
    expect(pos!.moves[0]).toEqual({
      uci: 'c1d1',
      san: 'Rd1+',
      category: 'loss',
      dtz: -14,
      dtm: -40,
      zeroing: false,
      checkmate: false,
      stalemate: false,
    });
    const draw = pos!.moves.find((m) => m.uci === 'c1a1')!;
    expect(draw).toMatchObject({ category: 'draw', dtz: 0, dtm: 0 });
  });

  it('gives null for invalid JSON', () => {
    expect(normalizeLichess(null, FEN)).toBeNull();
    expect(normalizeLichess('win', FEN)).toBeNull();
    expect(normalizeLichess({ category: 'win' }, FEN)).toBeNull();
  });

  it('gives null for unknown and maybe-* positions or moves', () => {
    for (const c of ['unknown', 'maybe-win', 'maybe-loss']) {
      expect(normalizeLichess({ ...clone(), category: c }, FEN)).toBeNull();
      const m = clone();
      m.moves[3]!.category = c;
      expect(normalizeLichess(m, FEN)).toBeNull();
    }
  });

  it('folds syzygy-win/loss into win/loss', () => {
    const j = clone();
    j.category = 'syzygy-win';
    j.moves[0]!.category = 'syzygy-loss';
    const pos = normalizeLichess(j, FEN)!;
    expect(pos.category).toBe('win');
    expect(pos.moves[0]!.category).toBe('loss');
  });

  it('keeps cursed-win/blessed-loss and prefers precise_dtz, omitting nulls', () => {
    const pos = normalizeLichess(
      {
        category: 'cursed-win',
        dtz: 102,
        precise_dtz: 101,
        dtm: null,
        moves: [
          { uci: 'a1a2', san: 'Ra2', category: 'blessed-loss', dtz: -100, precise_dtz: null },
          { uci: 'a1a3', san: 'Ra3', category: 'draw', zeroing: true },
        ],
      },
      FEN,
    )!;
    expect(pos.category).toBe('cursed-win');
    expect(pos.dtz).toBe(101);
    expect(pos.dtm).toBeUndefined();
    expect(pos.moves[0]).toEqual({
      uci: 'a1a2',
      san: 'Ra2',
      category: 'blessed-loss',
      dtz: -100,
      zeroing: false,
      checkmate: false,
      stalemate: false,
    });
    expect(pos.moves[1]!.dtz).toBeUndefined();
    expect(pos.moves[1]!.zeroing).toBe(true);
  });

  it('accepts a checkmated position without moves', () => {
    const pos = normalizeLichess(
      { category: 'loss', dtz: 0, dtm: 0, checkmate: true, moves: [] },
      FEN,
    );
    expect(pos).toEqual({ fen: FEN, category: 'loss', dtz: 0, dtm: 0, moves: [] });
  });
});
