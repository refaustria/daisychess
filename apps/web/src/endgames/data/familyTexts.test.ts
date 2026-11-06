import { ENDGAME_FAMILIES } from '@daisychess/endgames';
import { describe, expect, it } from 'vitest';
import { ENDGAME_FAMILY_TEXTS, endgameTextFor } from './familyTexts';

describe('endgame family texts', () => {
  it('has exactly one entry per family, including other', () => {
    expect(ENDGAME_FAMILY_TEXTS.map((t) => t.key).sort()).toEqual([...ENDGAME_FAMILIES].sort());
  });

  it.each(ENDGAME_FAMILY_TEXTS.map((t) => [t.key, t] as const))(
    '%s respects the length rules',
    (_key, t) => {
      expect(t.title.length).toBeGreaterThan(2);
      expect(t.text.length).toBeGreaterThanOrEqual(120);
      expect(t.text.length).toBeLessThanOrEqual(420);
      const sentences = t.text.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length).toBeGreaterThanOrEqual(2);
      expect(sentences.length).toBeLessThanOrEqual(3);
    },
  );

  it('looks up by key and falls back to other', () => {
    expect(endgameTextFor('rook')?.title).toBe('Rook endgame');
    expect(endgameTextFor('nonsense')?.key).toBe('other');
  });
});
