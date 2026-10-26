// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { useDrillStore } from '../trainer/drillStore';
import { shouldKeepAwake, startKeepAwake } from './keepAwake';

afterEach(() => {
  usePlayStore.setState({ mode: 'idle' });
  useLiveStore.setState({ status: 'idle' });
  useDrillStore.setState({ status: 'idle' });
});

describe('keep awake', () => {
  it('is wanted while a game, live game or drill runs', () => {
    expect(shouldKeepAwake()).toBe(false);
    usePlayStore.setState({ mode: 'playing' });
    expect(shouldKeepAwake()).toBe(true);
    usePlayStore.setState({ mode: 'idle' });
    useLiveStore.setState({ status: 'playing' });
    expect(shouldKeepAwake()).toBe(true);
    useLiveStore.setState({ status: 'idle' });
    useDrillStore.setState({ status: 'running' });
    expect(shouldKeepAwake()).toBe(true);
  });

  it('toggles the plugin only on changes and sleeps again on stop', () => {
    const port = {
      keepAwake: vi.fn(() => Promise.resolve()),
      allowSleep: vi.fn(() => Promise.resolve()),
    };
    const stop = startKeepAwake(port);
    expect(port.keepAwake).not.toHaveBeenCalled();
    usePlayStore.setState({ mode: 'playing' });
    useLiveStore.setState({ status: 'playing' });
    expect(port.keepAwake).toHaveBeenCalledTimes(1);
    usePlayStore.setState({ mode: 'idle' });
    expect(port.allowSleep).not.toHaveBeenCalled();
    useLiveStore.setState({ status: 'finished' });
    expect(port.allowSleep).toHaveBeenCalledTimes(1);
    usePlayStore.setState({ mode: 'playing' });
    expect(port.keepAwake).toHaveBeenCalledTimes(2);
    stop();
    expect(port.allowSleep).toHaveBeenCalledTimes(2);
  });
});
