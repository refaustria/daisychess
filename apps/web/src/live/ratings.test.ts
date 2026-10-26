import { describe, expect, it } from 'vitest';
import { parsePerfs } from './ratings';

describe('parsePerfs', () => {
  it('keeps the five time controls with provisional flag and games', () => {
    expect(
      parsePerfs({
        perfs: {
          blitz: { games: 10, rating: 1500.4, prov: true },
          rapid: { games: 50, rating: 1600 },
          puzzle: { rating: 2000 },
          classical: { games: 1 },
        },
      }),
    ).toEqual({
      blitz: { rating: 1500, provisional: true, games: 10 },
      rapid: { rating: 1600, provisional: false, games: 50 },
    });
  });
  it('tolerates garbage', () => {
    expect(parsePerfs(null)).toEqual({});
    expect(parsePerfs({ perfs: 3 })).toEqual({});
  });
});
