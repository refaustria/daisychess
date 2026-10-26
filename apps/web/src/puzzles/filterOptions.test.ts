import { describe, expect, it } from 'vitest';
import { formatBytes, groupOpenings, pickOpeningTag, type FilterOptions } from './filterOptions';

const options: FilterOptions = {
  themes: [],
  fromIndex: true,
  families: groupOpenings(
    [
      { tag: 'Sicilian_Defense', count: 10 },
      { tag: 'Sicilian_Defense_Najdorf_Variation', count: 4 },
      { tag: 'Italian_Game', count: 3 },
    ],
    ['Sicilian_Defense', 'Italian_Game'],
  ),
};

describe('filterOptions', () => {
  it('groups variations under their family', () => {
    expect(options.families.map((f) => f.tag)).toEqual(['Italian_Game', 'Sicilian_Defense']);
    expect(options.families[1]!.variations).toEqual([
      { tag: 'Sicilian_Defense_Najdorf_Variation', count: 4 },
    ]);
  });

  it('picks the variation, else the family, else nothing', () => {
    expect(pickOpeningTag('Sicilian Defense: Najdorf Variation, English Attack', options)).toBe(
      'Sicilian_Defense_Najdorf_Variation',
    );
    expect(pickOpeningTag('Sicilian Defense: Dragon Variation', options)).toBe('Sicilian_Defense');
    expect(pickOpeningTag('Italian Game', options)).toBe('Italian_Game');
    expect(pickOpeningTag("King's Gambit", options)).toBeUndefined();
  });

  it('formats sizes', () => {
    expect(formatBytes(12_400_000)).toBe('12.4 MB');
    expect(formatBytes(340_000)).toBe('340 KB');
  });
});
