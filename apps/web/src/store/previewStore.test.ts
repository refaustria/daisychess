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
  it('is cleared when the game position changes', () => {
    usePreviewStore.getState().start('x', []);
    useGameStore.getState().makeMove('e2', 'e4');
    expect(usePreviewStore.getState().fen).toBeNull();
  });
});
