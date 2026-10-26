// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayStore } from '../play/playStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { moveHaptic, startHaptics } from './haptics';
import type { HapticsPort } from './native';

function fake() {
  const port = {
    impact: vi.fn<(kind: string) => Promise<void>>(() => Promise.resolve()),
    notify: vi.fn<(kind: string) => Promise<void>>(() => Promise.resolve()),
  } satisfies HapticsPort;
  return port;
}

beforeEach(() => {
  useGameStore.getState().reset();
  useSettingsStore.getState().reset();
});

describe('haptics', () => {
  it('maps move kinds to impact strengths', async () => {
    const p = fake();
    await moveHaptic(p, 'move');
    await moveHaptic(p, 'capture');
    await moveHaptic(p, 'check');
    expect(p.impact.mock.calls.map((c) => c[0])).toEqual(['light', 'medium', 'heavy']);
  });

  it('fires for played moves but not for navigation', () => {
    const p = fake();
    const stop = startHaptics(p);
    const g = useGameStore.getState();
    g.makeMove('e2', 'e4');
    g.makeMove('d7', 'd5');
    g.makeMove('e4', 'd5');
    g.prev();
    g.next();
    stop();
    expect(p.impact.mock.calls.map((c) => c[0])).toEqual(['light', 'light', 'medium']);
  });

  it('is silent when the setting is off', () => {
    const p = fake();
    useSettingsStore.getState().set({ haptics: false });
    const stop = startHaptics(p);
    useGameStore.getState().makeMove('e2', 'e4');
    stop();
    expect(p.impact).not.toHaveBeenCalled();
  });

  it('signals the end of an engine game once', () => {
    const p = fake();
    const stop = startHaptics(p);
    usePlayStore.setState({ mode: 'finished' });
    usePlayStore.setState({ mode: 'finished' });
    stop();
    expect(p.notify).toHaveBeenCalledTimes(1);
    usePlayStore.setState({ mode: 'idle' });
  });

  it('swallows plugin failures', () => {
    const p = fake();
    p.impact.mockRejectedValue(new Error('no haptics'));
    const stop = startHaptics(p);
    expect(() => useGameStore.getState().makeMove('e2', 'e4')).not.toThrow();
    stop();
  });
});
