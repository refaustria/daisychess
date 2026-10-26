import { dailyIndex, STARTER_MAX_BYTES, StarterSchema, type Starter } from '@daisychess/puzzles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import raw from './data/starter.json?raw';
import {
  dailyPuzzle,
  loadStarter,
  setStarterImporter,
  starterCounts,
  starterPuzzles,
} from './starter';

const FEN = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';

function tinyStarter(): Starter {
  return {
    format: 1,
    dataset: 'test',
    themes: ['backRankMate', 'mate', 'short'],
    openings: ['Italian_Game', 'Italian_Game_Two_Knights'],
    rows: [
      ['a1', FEN, 'g1h1 d1d8', 1200, 70, [0, 1], [0, 1], 'abc/black#12'],
      ['a2', FEN, 'g1f1 d1d8', 1400, 75, [1, 2], [0], ''],
      ['a3', FEN, 'g1h1 d1d8', 1600, 75, [1], [], ''],
    ],
    daily: [2, 0],
  };
}

afterEach(() => {
  setStarterImporter(null);
  vi.restoreAllMocks();
});

describe('bundled starter.json', () => {
  it('stays within the 1 MB budget and validates', () => {
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(STARTER_MAX_BYTES);
    const s = StarterSchema.parse(JSON.parse(raw));
    expect(s.rows.length).toBeGreaterThanOrEqual(5000);
    expect(s.rows.length).toBeLessThanOrEqual(6000);
    expect(s.daily.length).toBeGreaterThan(500);
  });

  it('loads through the lazy import and gives a daily puzzle in 1300–2000', async () => {
    const loaded = await loadStarter();
    expect(loaded).not.toBeNull();
    expect(loaded!.puzzles).toHaveLength(loaded!.starter.rows.length);
    const p = await dailyPuzzle('2026-10-26');
    expect(p?.source).toBe('lichess');
    expect(p!.rating).toBeGreaterThanOrEqual(1300);
    expect(p!.rating).toBeLessThanOrEqual(2000);
    expect(p!.moves.length).toBeGreaterThanOrEqual(2);
  });
});

describe('starter loading', () => {
  it('decodes rows with the starter dictionary', async () => {
    setStarterImporter(async () => tinyStarter());
    const puzzles = await starterPuzzles();
    expect(puzzles).toHaveLength(3);
    expect(puzzles[0]).toEqual({
      id: 'a1',
      fen: FEN,
      moves: ['g1h1', 'd1d8'],
      rating: 1200,
      rd: 70,
      themes: ['backRankMate', 'mate'],
      openings: ['Italian_Game', 'Italian_Game_Two_Knights'],
      game: 'abc/black#12',
      source: 'lichess',
    });
    expect(puzzles[1]!.game).toBeUndefined();
  });

  it('loads once and shares the result', async () => {
    const importer = vi.fn(async () => tinyStarter());
    setStarterImporter(importer);
    await Promise.all([loadStarter(), loadStarter(), starterPuzzles()]);
    await loadStarter();
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('treats an invalid starter as missing and retries a failed load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    setStarterImporter(async () => {
      calls++;
      if (calls === 1) throw new Error('chunk load failed');
      if (calls === 2) return { ...tinyStarter(), daily: [99] };
      return tinyStarter();
    });
    expect(await loadStarter()).toBeNull();
    expect(await loadStarter()).toBeNull();
    expect(await dailyPuzzle('2026-01-01')).not.toBeNull();
    expect(calls).toBe(3);
  });

  it('treats a row with an out-of-range theme index as an invalid starter', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = tinyStarter();
    s.rows[0]![5] = [9];
    setStarterImporter(async () => s);
    expect(await starterPuzzles()).toEqual([]);
    expect(await dailyPuzzle('2026-01-01')).toBeNull();
  });
});

describe('dailyPuzzle', () => {
  it('picks starter.daily[dailyIndex(date)] and is the same for Date and key', async () => {
    setStarterImporter(async () => tinyStarter());
    // daily = [2, 0]: day 0 → row 2, day 1 → row 0.
    expect((await dailyPuzzle('2026-01-01'))?.id).toBe('a3');
    expect((await dailyPuzzle('2026-01-02'))?.id).toBe('a1');
    expect((await dailyPuzzle(new Date(Date.UTC(2026, 0, 2, 23, 59))))?.id).toBe('a1');
    expect(dailyIndex('2026-01-03', 2)).toBe(0);
  });

  it('is null with an empty daily pool', async () => {
    setStarterImporter(async () => ({ ...tinyStarter(), daily: [] }));
    expect(await dailyPuzzle('2026-01-01')).toBeNull();
  });
});

describe('starterCounts', () => {
  it('counts themes and opening tags', async () => {
    setStarterImporter(async () => tinyStarter());
    expect(await starterCounts()).toEqual({
      themes: { backRankMate: 1, mate: 3, short: 1 },
      openings: { Italian_Game: 2, Italian_Game_Two_Knights: 1 },
    });
  });

  it('is empty without a starter', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStarterImporter(async () => null);
    expect(await starterCounts()).toEqual({ themes: {}, openings: {} });
  });
});
