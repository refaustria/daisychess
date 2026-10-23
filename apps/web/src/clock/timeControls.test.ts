import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_TIME_CONTROLS,
  customSetting,
  groupedTimeControls,
  LOCAL_TIME_CONTROLS,
  presetOf,
  sanitizeSetting,
  SEEK_TIME_CONTROLS,
  timeCategory,
  timeControlLabel,
  toSetting,
} from './timeControls';
import * as legacy from '../live/timeControls';

const s = (sec: number, inc = 0) => [sec * 1000, inc * 1000] as const;

describe('timeCategory (lichess: initial + 40 × increment)', () => {
  it.each([
    [s(15), 'UltraBullet'],
    [s(29), 'UltraBullet'],
    [s(30), 'Bullet'],
    [s(0, 0.5), 'UltraBullet'], // 20 s
    [s(60), 'Bullet'],
    [s(120, 1), 'Bullet'], // 160 s
    [s(179), 'Bullet'],
    [s(180), 'Blitz'],
    [s(60, 3), 'Blitz'], // 180 s
    [s(300, 3), 'Blitz'], // 420 s
    [s(479), 'Blitz'],
    [s(480), 'Rapid'],
    [s(600, 5), 'Rapid'], // 800 s
    [s(900, 10), 'Rapid'], // 1300 s
    [s(1499), 'Rapid'],
    [s(1500), 'Classical'],
    [s(1800), 'Classical'],
    [s(600, 30), 'Classical'], // 1800 s
  ] as const)('%j → %s', ([initial, inc], cat) => {
    expect(timeCategory(initial, inc)).toBe(cat);
  });
});

describe('local presets', () => {
  it('labels and grouping by category', () => {
    expect(LOCAL_TIME_CONTROLS.map((t) => t.label)).toEqual([
      '1+0 · Bullet',
      '2+1 · Bullet',
      '3+0 · Blitz',
      '3+2 · Blitz',
      '5+0 · Blitz',
      '5+3 · Blitz',
      '10+0 · Rapid',
      '10+5 · Rapid',
      '15+10 · Rapid',
      '30+0 · Classical',
      '30+20 · Classical',
    ]);
    expect(groupedTimeControls().map((g) => [g.category, g.list.map((t) => t.id)])).toEqual([
      ['Bullet', ['1+0', '2+1']],
      ['Blitz', ['3+0', '3+2', '5+0', '5+3']],
      ['Rapid', ['10+0', '10+5', '15+10']],
      ['Classical', ['30+0', '30+20']],
    ]);
  });

  it('custom values are clamped (0.25–180 min, 0–60 s) and labelled', () => {
    expect(customSetting(0.25, 0)).toEqual({ initialMs: 15_000, incrementMs: 0 });
    expect(customSetting(0.1, -3)).toEqual({ initialMs: 15_000, incrementMs: 0 });
    expect(customSetting(500, 99)).toEqual({ initialMs: 180 * 60_000, incrementMs: 60_000 });
    expect(customSetting(Number.NaN, 2.4)).toEqual({ initialMs: 15_000, incrementMs: 2000 });
    expect(timeControlLabel(customSetting(0.25, 0))).toBe('0.25+0 · UltraBullet');
    expect(timeControlLabel(customSetting(0.5, 0))).toBe('0.5+0 · Bullet');
    expect(timeControlLabel(toSetting({ minutes: 3, increment: 2 }))).toBe('3+2 · Blitz');
  });

  it('presetOf and sanitizeSetting', () => {
    expect(presetOf({ initialMs: 180_000, incrementMs: 2000 })?.id).toBe('3+2');
    expect(presetOf({ initialMs: 181_000, incrementMs: 2000 })).toBeUndefined();
    expect(presetOf(null)).toBeUndefined();
    expect(sanitizeSetting(null)).toBeNull();
    expect(sanitizeSetting('3+2')).toBeNull();
    expect(sanitizeSetting({ initialMs: '1', incrementMs: 0 })).toBeNull();
    expect(sanitizeSetting({ initialMs: 1, incrementMs: 0 })).toEqual({
      initialMs: 15_000,
      incrementMs: 0,
    });
    expect(sanitizeSetting({ initialMs: 300_000, incrementMs: 3000 })).toEqual({
      initialMs: 300_000,
      incrementMs: 3000,
    });
  });

  it('the old live path re-exports the same lists', () => {
    expect(legacy.SEEK_TIME_CONTROLS).toBe(SEEK_TIME_CONTROLS);
    expect(legacy.CHALLENGE_TIME_CONTROLS).toBe(CHALLENGE_TIME_CONTROLS);
    expect(legacy.clockLabel({ limit: 300, increment: 3 })).toBe('5+3');
  });
});
