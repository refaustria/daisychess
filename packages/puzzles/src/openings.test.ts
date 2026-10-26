import { describe, expect, it } from 'vitest';
import { openingFamily, openingTag, openingTagsForName } from './openings.js';

describe('openingTag', () => {
  it('maps names to lichess tags', () => {
    expect(openingTag("Queen's Pawn Game: Accelerated London System")).toBe(
      'Queens_Pawn_Game_Accelerated_London_System',
    );
    expect(openingTag('Sicilian Defense')).toBe('Sicilian_Defense');
    expect(openingTag('Sicilian Defense: Najdorf Variation, English Attack')).toBe(
      'Sicilian_Defense_Najdorf_Variation_English_Attack',
    );
    expect(openingTag('Caro-Kann Defense: Advance Variation')).toBe(
      'Caro-Kann_Defense_Advance_Variation',
    );
    expect(openingTag('  King’s  Gambit ')).toBe('Kings_Gambit');
  });
});

describe('openingFamily', () => {
  const families = [
    'Sicilian_Defense',
    'Queens_Pawn_Game',
    'Queens_Gambit',
    'Queens_Gambit_Declined',
  ];
  it('finds the longest family prefix of a tag', () => {
    expect(openingFamily('Sicilian_Defense_Open', families)).toBe('Sicilian_Defense');
    expect(openingFamily('Sicilian_Defense', families)).toBe('Sicilian_Defense');
    expect(openingFamily('Queens_Gambit_Declined_Exchange_Variation', families)).toBe(
      'Queens_Gambit_Declined',
    );
    expect(openingFamily('Queens_Pawn_Gamex', families)).toBeUndefined();
    expect(openingFamily('Italian_Game', families)).toBeUndefined();
  });
});

describe('openingTagsForName', () => {
  it('splits a name into the family and the first-level variation tag', () => {
    expect(openingTagsForName('Sicilian Defense: Najdorf Variation, English Attack')).toEqual({
      family: 'Sicilian_Defense',
      variation: 'Sicilian_Defense_Najdorf_Variation',
    });
    expect(openingTagsForName("Queen's Pawn Game: Accelerated London System")).toEqual({
      family: 'Queens_Pawn_Game',
      variation: 'Queens_Pawn_Game_Accelerated_London_System',
    });
    expect(openingTagsForName('Sicilian Defense')).toEqual({ family: 'Sicilian_Defense' });
  });
});
