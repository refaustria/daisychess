import { afterEach, describe, expect, it } from 'vitest';
import { usePlayStore } from '../play/playStore';
import { useLiveStore } from './liveStore';
import { humanGameLock, humanGameLockReason, isHumanGameRunning, lockText } from './lock';

afterEach(() => {
  usePlayStore.setState({ mode: 'idle' });
  useLiveStore.setState({ status: 'idle' });
});

describe('human game lock', () => {
  it('one rule for the engine game and the live game', () => {
    expect(humanGameLock({ mode: 'idle' }, { status: 'idle' })).toBeNull();
    expect(humanGameLock({ mode: 'playing' }, { status: 'idle' })).toBe('engine');
    expect(humanGameLock({ mode: 'finished' }, { status: 'seeking' })).toBe('live');
    expect(humanGameLock({ mode: 'idle' }, { status: 'playing' })).toBe('live');
    expect(humanGameLock({ mode: 'idle' }, { status: 'finished' })).toBeNull();
    expect(humanGameLock({ mode: 'idle' }, { status: 'error' })).toBeNull();
  });

  it('reads the stores', () => {
    expect(isHumanGameRunning()).toBe(false);
    useLiveStore.setState({ status: 'playing' });
    expect(humanGameLockReason()).toBe('live');
    expect(lockText('live')).toBe('Disabled during a live game (lichess fair play)');
    expect(lockText('engine')).toBe('Paused while playing against the engine');
    expect(lockText(null)).toBeUndefined();
  });
});
