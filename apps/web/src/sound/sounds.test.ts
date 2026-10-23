// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { newMoveKind, playMoveSound, startMoveSounds } from './sounds';

beforeEach(() => {
  useGameStore.getState().reset();
  useSettingsStore.getState().reset();
});

describe('sounds', () => {
  it('does not throw without AudioContext', () => {
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    expect(() => {
      playMoveSound('move');
      playMoveSound('capture');
      playMoveSound('check');
    }).not.toThrow();
  });

  it('does not throw when sound is disabled', () => {
    useSettingsStore.getState().set({ sound: false });
    expect(() => playMoveSound('move')).not.toThrow();
  });

  it('classifies only freshly played moves', () => {
    const g = useGameStore.getState();
    const kinds: (string | null)[] = [];
    const stop = useGameStore.subscribe((next, prev) => kinds.push(newMoveKind(prev, next)));
    g.makeMove('e2', 'e4');
    g.makeMove('d7', 'd5');
    g.makeMove('e4', 'd5');
    g.prev(); // navigation back
    g.next(); // navigation forward reuses the record
    g.undo();
    stop();
    expect(kinds).toEqual(['move', 'move', 'capture', null, null, null]);
  });

  it('subscription is safe to start and stop', () => {
    const stop = startMoveSounds();
    expect(() => useGameStore.getState().makeMove('e2', 'e4')).not.toThrow();
    stop();
  });
});
