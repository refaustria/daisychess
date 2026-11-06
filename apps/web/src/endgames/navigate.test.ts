import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEndgameTrainHandler, setEndgameTrainHandler } from '../review/tourStore';
import { useUiStore } from '../store/uiStore';
import {
  clearEndgamesGroup,
  openEndgames,
  registerLessonStop,
  stopEndgameLesson,
  useEndgamesNav,
} from './navigate';

afterEach(() => {
  useUiStore.setState({ activeTab: 'moves' });
  useEndgamesNav.setState({ group: null, seq: 0 });
  setEndgameTrainHandler(undefined);
});

describe('openEndgames', () => {
  it('shows the Endgames tab on the requested group', () => {
    openEndgames('rook_pawn');
    expect(useUiStore.getState().activeTab).toBe('endgames');
    expect(useEndgamesNav.getState()).toEqual({ group: 'rook_pawn', seq: 1 });
    clearEndgamesGroup();
    expect(useEndgamesNav.getState().group).toBeNull();
    openEndgames();
    expect(useEndgamesNav.getState()).toEqual({ group: null, seq: 2 });
  });

  it('is the tour card handler of "Train this endgame" (as App registers it)', () => {
    setEndgameTrainHandler(openEndgames);
    getEndgameTrainHandler()!('king_pawn');
    expect(useUiStore.getState().activeTab).toBe('endgames');
    expect(useEndgamesNav.getState().group).toBe('king_pawn');
  });
});

describe('the lesson stop registry', () => {
  it('calls the registered stop; unregistering is idempotent and keeps a newer one', () => {
    stopEndgameLesson(); // nothing registered: no-op
    const a = vi.fn();
    const b = vi.fn();
    const offA = registerLessonStop(a);
    stopEndgameLesson();
    expect(a).toHaveBeenCalledTimes(1);
    const offB = registerLessonStop(b);
    offA();
    stopEndgameLesson();
    expect(b).toHaveBeenCalledTimes(1);
    offB();
    stopEndgameLesson();
    expect(b).toHaveBeenCalledTimes(1);
  });
});
