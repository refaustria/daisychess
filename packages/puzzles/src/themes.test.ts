import { describe, expect, it } from 'vitest';
import { THEME_GROUPS, THEMES, themeInfo, themeLabel, themesByGroup } from './themes.js';
import { fixturePuzzles } from '../test/fixture.js';

/** Every theme key of the 2026-10 lichess dump (sampled 238,566 rows). */
const LICHESS_THEMES =
  'short endgame middlegame crushing mate advantage long oneMove mateIn1 master mateIn2 fork kingsideAttack veryLong sacrifice advancedPawn defensiveMove pin rookEndgame discoveredAttack opening deflection quietMove hangingPiece attraction pawnEndgame backRankMate mateIn3 exposedKing promotion skewer discoveredCheck queensideAttack bishopEndgame clearance masterVsMaster queenEndgame intermezzo trappedPiece pillsburysMate operaMate zugzwang knightEndgame queenRookEndgame attackingF2F7 capturingDefender doubleCheck mateIn4 smotheredMate epauletteMate interference xRayAttack equality cornerMate hookMate enPassant swallowstailMate anastasiaMate collinearMove arabianMate triangleMate morphysMate blindSwineMate mateIn5 killBoxMate dovetailMate doubleBishopMate bodenMate superGM vukovicMate castling balestraMate underPromotion'.split(
    ' ',
  );

describe('THEMES', () => {
  it('covers every lichess theme exactly once, with our own labels and descriptions', () => {
    expect(LICHESS_THEMES).toHaveLength(73);
    expect(THEMES.map((t) => t.key).sort()).toEqual([...LICHESS_THEMES].sort());
    for (const t of THEMES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(THEME_GROUPS.some((g) => g.key === t.group)).toBe(true);
    }
  });
  it('knows every theme of the fixture', () => {
    for (const p of fixturePuzzles) for (const t of p.themes) expect(themeInfo(t)).toBeDefined();
  });
});

describe('themeInfo / themeLabel', () => {
  it('returns our label, or a readable fallback for unknown keys', () => {
    expect(themeInfo('fork')?.group).toBe('tactics');
    expect(themeInfo('nope')).toBeUndefined();
    expect(themeLabel('mateIn2')).toBe('Mate in 2');
    expect(themeLabel('brandNewTheme')).toBe('Brand new theme');
  });
});

describe('themesByGroup', () => {
  it('groups all themes in display order', () => {
    const groups = themesByGroup();
    expect(groups.map((g) => g.group)).toEqual(['mates', 'tactics', 'phase', 'length', 'special']);
    expect(groups.reduce((s, g) => s + g.themes.length, 0)).toBe(73);
  });
  it('lists only available themes; unknown ones go to special', () => {
    const groups = themesByGroup(['fork', 'short', 'newThing', '']);
    expect(groups.map((g) => [g.group, g.themes.map((t) => t.key)])).toEqual([
      ['tactics', ['fork']],
      ['length', ['short']],
      ['special', ['newThing']],
    ]);
  });
});
