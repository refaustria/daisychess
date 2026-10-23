import { describe, expect, it } from 'vitest';
import { afterMove, createClock, engineMoveTime, remainingAt, runSide, tick } from './gameClock';

const base = () => createClock({ initialMs: 60_000, incrementMs: 2000 }, 1000);

describe('gameClock', () => {
  it('starts stopped with the initial time on both sides', () => {
    const c = base();
    expect(c).toMatchObject({
      w: 60_000,
      b: 60_000,
      runningSide: null,
      flagged: null,
      lastTickAt: 1000,
    });
    expect(tick(c, 5000)).toMatchObject({ w: 60_000, b: 60_000, lastTickAt: 5000 });
    expect(tick(c, 1000)).toBe(c);
  });

  it('only the running side loses time; ticks are additive', () => {
    const c = runSide(base(), 'w', 1000);
    expect(remainingAt(c, 'w', 3500)).toBe(57_500);
    expect(remainingAt(c, 'b', 3500)).toBe(60_000);
    const t1 = tick(c, 2000);
    const t2 = tick(t1, 3500);
    expect(t2).toMatchObject({ w: 57_500, b: 60_000, runningSide: 'w', lastTickAt: 3500 });
    // A non-monotonic timestamp never adds time.
    expect(tick(t2, 3000).w).toBe(57_500);
  });

  it('afterMove charges the mover, adds the increment and starts the opponent', () => {
    let c = runSide(base(), 'w', 1000);
    c = afterMove(c, 'w', 6000); // White used 5 s, +2 s
    expect(c).toMatchObject({ w: 57_000, b: 60_000, runningSide: 'b' });
    c = afterMove(c, 'b', 7000);
    expect(c).toMatchObject({ w: 57_000, b: 61_000, runningSide: 'w' });
  });

  it('a throttled tick still charges the whole elapsed time (background tab)', () => {
    let c = runSide(base(), 'b', 0);
    c = tick(c, 45_000); // one late tick after 45 s
    expect(c.b).toBe(15_000);
  });

  it('flags at zero, stops, and a late move does not save the mover', () => {
    let c = runSide(base(), 'w', 0);
    c = tick(c, 60_000);
    expect(c).toMatchObject({ w: 0, runningSide: null, flagged: 'w' });
    const late = afterMove(runSide(base(), 'w', 0), 'w', 61_000);
    expect(late).toMatchObject({ w: 0, flagged: 'w', runningSide: null });
    expect(runSide(c, 'b', 70_000)).toMatchObject({ flagged: 'w', runningSide: null, b: 60_000 });
  });

  it('runSide(null) stops the clock after charging', () => {
    const c = runSide(runSide(base(), 'b', 0), null, 4000);
    expect(c).toMatchObject({ b: 56_000, runningSide: null });
    expect(tick(c, 10_000).b).toBe(56_000);
  });
});

describe('engineMoveTime = min(configured, max(50, remaining/30 + 0.8 × increment))', () => {
  it.each([
    [3000, 600_000, 0, 3000], // plenty of time: the configured time
    [3000, 60_000, 0, 2000], // 1+0: 60 s / 30
    [3000, 15_000, 0, 500],
    [3000, 15_000, 2000, 2100], // 500 + 1600
    [3000, 1000, 2000, 500], // capped at half the remaining time
    [3000, 900, 0, 50], // floor
    [3000, 0, 0, 50],
    [100, 15_000, 0, 100],
  ])('configured %i, remaining %i, inc %i → %i', (cfg, rem, inc, want) => {
    expect(engineMoveTime(cfg, rem, inc)).toBe(want);
  });

  it('full strength (3 s) on a 15-second clock lasts 80 moves (the 50 ms floor ends it near move 90)', () => {
    let rem = 15_000;
    for (let i = 0; i < 80; i++) {
      const t = engineMoveTime(3000, rem, 0) + 20; // 20 ms overhead per move
      rem -= t;
      expect(rem).toBeGreaterThan(0);
    }
  });
});
