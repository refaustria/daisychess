import { describe, expect, it } from 'vitest';
import { analysisShapes, type ShapeInput } from './shapes';

const base: ShapeInput = { enabled: true, terminal: false, previewing: false, inSync: true, best: 'e2e4', hover: null };

describe('analysisShapes', () => {
  it('draws the best move in green', () => {
    expect(analysisShapes(base)).toEqual([{ orig: 'e2', dest: 'e4', brush: 'green' }]);
  });
  it('draws up to 3 hovered moves', () => {
    const s = analysisShapes({ ...base, hover: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] });
    expect(s.map((x) => x.brush)).toEqual(['blue', 'paleBlue', 'paleBlue']);
  });
  it('draws nothing when disabled, terminal, previewing or out of sync', () => {
    for (const o of [{ enabled: false }, { terminal: true }, { previewing: true }, { inSync: false }]) {
      expect(analysisShapes({ ...base, ...o })).toEqual([]);
    }
    expect(analysisShapes({ ...base, best: undefined })).toEqual([]);
  });
});
