import { describe, expect, it } from 'vitest';
import { analysisShapes, reviewShapes, type ShapeInput } from './shapes';

const base: ShapeInput = {
  enabled: true,
  terminal: false,
  previewing: false,
  inSync: true,
  best: 'e2e4',
  hover: null,
};

describe('analysisShapes', () => {
  it('draws the best move in green', () => {
    expect(analysisShapes(base)).toEqual([{ orig: 'e2', dest: 'e4', brush: 'green' }]);
  });
  it('draws up to 3 hovered moves', () => {
    const s = analysisShapes({ ...base, hover: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] });
    expect(s.map((x) => x.brush)).toEqual(['blue', 'paleBlue', 'paleBlue']);
  });
  it('draws nothing when disabled, terminal, previewing or out of sync', () => {
    for (const o of [
      { enabled: false },
      { terminal: true },
      { previewing: true },
      { inSync: false },
    ]) {
      expect(analysisShapes({ ...base, ...o })).toEqual([]);
    }
    expect(analysisShapes({ ...base, best: undefined })).toEqual([]);
  });
});

describe('reviewShapes', () => {
  it('draws a blunder in red and the best move in green', () => {
    expect(
      reviewShapes({
        previewing: false,
        move: { playedUci: 'g8f6', bestUci: 'g7g6', classification: 'blunder' },
      }),
    ).toEqual([
      { orig: 'g8', dest: 'f6', brush: 'red' },
      { orig: 'g7', dest: 'g6', brush: 'green' },
    ]);
  });
  it('colours the played move by class', () => {
    const brush = (classification: 'inaccuracy' | 'mistake' | 'good') =>
      reviewShapes({
        previewing: false,
        move: { playedUci: 'e2e4', bestUci: 'd2d4', classification },
      })[0]?.brush;
    expect(brush('inaccuracy')).toBe('yellow');
    expect(brush('mistake')).toBe('red');
    expect(brush('good')).toBe('paleGreen');
  });
  it('draws a single green arrow when the best move was played', () => {
    expect(
      reviewShapes({
        previewing: false,
        move: { playedUci: 'e2e4', bestUci: 'e2e4', classification: 'best' },
      }),
    ).toEqual([{ orig: 'e2', dest: 'e4', brush: 'green' }]);
  });
  it('draws nothing while previewing or without a reviewed move', () => {
    const move = { playedUci: 'e2e4', classification: 'best' as const };
    expect(reviewShapes({ previewing: true, move })).toEqual([]);
    expect(reviewShapes({ previewing: false })).toEqual([]);
    expect(reviewShapes({ previewing: false, move })).toEqual([
      { orig: 'e2', dest: 'e4', brush: 'green' },
    ]);
  });
});
