import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('package entry', () => {
  it('exports the public API of ADR-023 §2', () => {
    for (const name of [
      'PuzzleRowSchema',
      'ShardSchema',
      'PuzzleIndexSchema',
      'StarterSchema',
      'parseCsvLine',
      'rowFromCsv',
      'decodeRow',
      'hardFilter',
      'selectCurated',
      'pickStarter',
      'pickDailyPool',
      'shardByBand',
      'buildIndex',
      'solutionState',
      'checkMove',
      'glicko2Update',
      'choosePuzzle',
      'chooseShards',
      'difficultyWindow',
      'dailyIndex',
      'rushPlan',
      'THEMES',
      'openingTag',
      'openingFamily',
      'mistakeCandidates',
      'cutSolution',
    ]) {
      expect(api, name).toHaveProperty(name);
    }
  });
});
