import { Chess } from 'chess.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { START_FEN } from '../store/gameStore';
import { findOpening, loadOpenings, openingForGame, toEpd } from '.';

beforeAll(loadOpenings);

function positions(san: string): string[] {
  const c = new Chess();
  const out = [toEpd(c.fen())];
  for (const m of san.split(' ').filter(Boolean)) out.push(toEpd(c.move(m).after));
  return out;
}

function state(san: string, ply?: number, startFen = START_FEN) {
  const c = new Chess(startFen);
  const moves = san
    .split(' ')
    .filter(Boolean)
    .map((m) => {
      const r = c.move(m);
      return { san: r.san, from: r.from, to: r.to, fen: r.after };
    });
  return { startFen, moves, ply: ply ?? moves.length };
}

describe('findOpening', () => {
  it('recognises the Ruy Lopez', () => {
    expect(findOpening(positions('e4 e5 Nf3 Nc6 Bb5'))).toMatchObject({
      eco: 'C60',
      name: 'Ruy Lopez',
      ply: 5,
    });
  });

  it('returns null for the empty game', () => {
    expect(findOpening(positions(''))).toBeNull();
    expect(findOpening([])).toBeNull();
  });

  it('deepest match wins', () => {
    const o = findOpening(positions('e4 e5 Nf3 Nc6 Bb5 a6'));
    expect(o?.name).toMatch(/^Ruy Lopez: Morphy Defense/);
    expect(o?.ply).toBe(6);
  });

  it('keeps the last named position after leaving theory', () => {
    expect(findOpening(positions('e4 e5 Nf3 Nc6 Bb5 a6 h3 h6 a3'))?.ply).toBeGreaterThanOrEqual(5);
  });

  it('recognises transpositions', () => {
    const a = findOpening(positions('e4 e5 Nf3 Nc6 Bb5'));
    const b = findOpening(positions('Nf3 Nc6 e4 e5 Bb5'));
    expect(b).toMatchObject({ eco: 'C60', name: 'Ruy Lopez', ply: 5 });
    expect(b?.name).toBe(a?.name);
  });
});

describe('openingForGame', () => {
  it('returns the opening as of the current ply', () => {
    const s = state('e4 e5 Nf3');
    expect(openingForGame(s)).toMatchObject({ eco: 'C40', name: "King's Knight Opening" });
    expect(openingForGame({ ...s, ply: 1 })).toMatchObject({
      eco: 'B00',
      name: "King's Pawn Game",
    });
    expect(openingForGame({ ...s, ply: 0 })).toBeNull();
  });

  it('is null for a custom start position', () => {
    const fen = '4k3/8/8/8/8/8/4P3/4K3 w - - 0 1';
    expect(openingForGame(state('e4', undefined, fen))).toBeNull();
  });
});
