import { describe, expect, it } from 'vitest';
import { HEAD, PAWN_HEIGHT, pawnProfile, profileMaxRadius } from '../scripts/hero/profile';

describe('pawnProfile', () => {
  const pts = pawnProfile();

  it('starts at the centre of the base and ends at the top of the head on the axis', () => {
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    const last = pts[pts.length - 1]!;
    expect(last.x).toBe(0);
    expect(last.y).toBeCloseTo(PAWN_HEIGHT, 6);
  });

  it('never has a negative radius and stays within the base radius', () => {
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(0.7);
    }
    expect(profileMaxRadius(pts)).toBeGreaterThan(0.6);
  });

  it('rises monotonically (a lathe profile must not fold back)', () => {
    for (let i = 1; i < pts.length; i++) expect(pts[i]!.y).toBeGreaterThanOrEqual(pts[i - 1]!.y - 1e-9);
  });

  it('ends in a sphere of the head radius', () => {
    const head = pts.filter((p) => p.y > HEAD.y);
    for (const p of head) expect(Math.hypot(p.x, p.y - HEAD.y)).toBeCloseTo(HEAD.r, 6);
  });

  it('scales the sample count with the detail arguments and clamps silly values', () => {
    expect(pawnProfile(12, 40).length).toBeGreaterThan(pawnProfile(4, 10).length);
    const minimal = pawnProfile(0, 0);
    expect(minimal.length).toBeGreaterThan(10);
    expect(minimal[minimal.length - 1]!.y).toBeCloseTo(PAWN_HEIGHT, 6);
  });

  it('has no NaN values', () => {
    for (const p of pawnProfile(16, 64)) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});
