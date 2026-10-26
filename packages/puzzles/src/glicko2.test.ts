import { describe, expect, it } from 'vitest';
import {
  formatPuzzleRating,
  GLICKO_DEFAULT,
  glicko2Update,
  MAX_RD,
  PUZZLE_TAU,
} from './glicko2.js';

describe('glicko2Update', () => {
  it("reproduces Glickman's reference example (τ = 0.5)", () => {
    const r = glicko2Update(
      { rating: 1500, rd: 200, vol: 0.06 },
      [
        { rating: 1400, rd: 30, score: 1 },
        { rating: 1550, rd: 100, score: 0 },
        { rating: 1700, rd: 300, score: 0 },
      ],
      0.5,
    );
    // The paper rounds its intermediate values (μ' = −0.2069, φ' = 0.8722); computed exactly the
    // result is 1464.0507 / 151.5165 / 0.059996, within 0.01 of the printed 1464.06 / 151.52.
    expect(Math.abs(r.rating - 1464.06)).toBeLessThan(0.01);
    expect(Math.abs(r.rd - 151.52)).toBeLessThan(0.01);
    expect(Math.abs(r.vol - 0.05999)).toBeLessThan(0.00001);
  });

  it('defaults to τ = 0.75 and moves the rating towards the result', () => {
    expect(PUZZLE_TAU).toBe(0.75);
    const win = glicko2Update(GLICKO_DEFAULT, [{ rating: 1500, rd: 75, score: 1 }]);
    const loss = glicko2Update(GLICKO_DEFAULT, [{ rating: 1500, rd: 75, score: 0 }]);
    expect(win.rating).toBeGreaterThan(1500);
    expect(loss.rating).toBeLessThan(1500);
    expect(win.rating - 1500).toBeCloseTo(1500 - loss.rating, 6);
    expect(win.rd).toBeLessThan(350);
    expect(glicko2Update(GLICKO_DEFAULT, [{ rating: 1500, rd: 75, score: 1 }], 0.75)).toEqual(win);
  });

  it('converges towards the true strength over one-puzzle periods', () => {
    let p = { ...GLICKO_DEFAULT };
    let seed = 1;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 60; i++) {
      const pr = 1500 + Math.round(rnd() * 600);
      const win = rnd() < 1 / (1 + 10 ** ((pr - 1800) / 400)) ? 1 : 0;
      p = glicko2Update(p, [{ rating: pr, rd: 75, score: win }]);
    }
    expect(p.rating).toBeGreaterThan(1600);
    expect(p.rating).toBeLessThan(2000);
    expect(p.rd).toBeLessThan(120);
  });

  it('only grows the RD without results, capped at 350', () => {
    const r = glicko2Update({ rating: 1600, rd: 100, vol: 0.06 }, []);
    expect(r.rating).toBe(1600);
    expect(r.rd).toBeGreaterThan(100);
    expect(r.vol).toBe(0.06);
    expect(glicko2Update({ rating: 1600, rd: 349.9, vol: 0.5 }, []).rd).toBe(MAX_RD);
  });

  it('handles extreme surprises (volatility iteration branch) and bad input', () => {
    const r = glicko2Update({ rating: 1000, rd: 50, vol: 0.06 }, [
      { rating: 2800, rd: 30, score: 1 },
    ]);
    expect(Number.isFinite(r.rating)).toBe(true);
    expect(r.rating).toBeGreaterThan(1000);
    expect(r.vol).toBeGreaterThan(0.06);
    const p = { rating: 1500, rd: 200, vol: 0.06 };
    expect(glicko2Update(p, [{ rating: NaN, rd: 30, score: 1 }])).toEqual(p);
    expect(glicko2Update({ ...p, rd: 0 }, [{ rating: 1500, rd: 30, score: 1 }])).toEqual({
      ...p,
      rd: 0,
    });
  });
});

describe('formatPuzzleRating', () => {
  it('formats "1620 ± 85"', () => {
    expect(formatPuzzleRating({ rating: 1619.6, rd: 84.5 })).toBe('1620 ± 85');
  });
});
