import { beforeEach, describe, expect, it } from 'vitest';
import { useGameStore } from './gameStore';
import { usePreviewStore } from './previewStore';

beforeEach(() => {
  useGameStore.getState().reset();
  usePreviewStore.setState({ fen: null, moves: [], hover: null });
});

describe('previewStore', () => {
  it('starts and clears a preview without touching the game', () => {
    const before = useGameStore.getState().moves;
    usePreviewStore.getState().start('8/8/8/8/8/8/8/K6k w - - 0 1', ['Kb1']);
    expect(usePreviewStore.getState().fen).toBe('8/8/8/8/8/8/8/K6k w - - 0 1');
    expect(usePreviewStore.getState().moves).toEqual(['Kb1']);
    expect(useGameStore.getState().moves).toBe(before);
    usePreviewStore.getState().clear();
    expect(usePreviewStore.getState().fen).toBeNull();
  });
  it('tracks hover', () => {
    usePreviewStore.getState().setHover(['e2e4']);
    expect(usePreviewStore.getState().hover).toEqual(['e2e4']);
    usePreviewStore.getState().setHover(null);
    expect(usePreviewStore.getState().hover).toBeNull();
  });
  it('steps a line, clamped to its ends, with the last move as arrow', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    const p = usePreviewStore.getState();
    p.stepLine(1); // no line: nothing happens
    expect(usePreviewStore.getState().fen).toBeNull();
    p.startLine(start, ['e4', 'e5', 'Nf3']);
    expect(usePreviewStore.getState().fen).toBe(start);
    expect(usePreviewStore.getState().lineIndex).toBe(0);
    expect(usePreviewStore.getState().lineArrow).toBeNull();
    usePreviewStore.getState().stepLine(1);
    expect(usePreviewStore.getState().lineIndex).toBe(1);
    expect(usePreviewStore.getState().lineArrow).toBe('e2e4');
    expect(usePreviewStore.getState().fen).toContain('4P3');
    usePreviewStore.getState().stepLine(5);
    expect(usePreviewStore.getState().lineIndex).toBe(3);
    expect(usePreviewStore.getState().lineArrow).toBe('g1f3');
    usePreviewStore.getState().stepLine(-1);
    expect(usePreviewStore.getState().lineArrow).toBe('e7e5');
    usePreviewStore.getState().stepLine(-9);
    expect(usePreviewStore.getState().lineIndex).toBe(0);
    expect(usePreviewStore.getState().fen).toBe(start);
    usePreviewStore.getState().clear();
    expect(usePreviewStore.getState().line).toBeNull();
  });
  it('cuts a line at an illegal move', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    usePreviewStore.getState().startLine(start, ['e4', 'Qh5']);
    expect(usePreviewStore.getState().line?.sans).toEqual(['e4']);
  });
  it('is cleared when the game position changes', () => {
    usePreviewStore.getState().start('x', []);
    useGameStore.getState().makeMove('e2', 'e4');
    expect(usePreviewStore.getState().fen).toBeNull();
  });
});
