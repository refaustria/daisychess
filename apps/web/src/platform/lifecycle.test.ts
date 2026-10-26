import { describe, expect, it, vi } from 'vitest';
import { BACKGROUND_GRACE_MS, createLifecycle, type LifecycleEnv } from './lifecycle';

function setup() {
  let pending: { fn: () => void; ms: number } | null = null;
  const events: string[] = [];
  const env: LifecycleEnv = {
    dispatch: (e) => events.push(e.type),
    trimPool: vi.fn(() => Promise.resolve()),
    setTimer: (fn, ms) => ((pending = { fn, ms }), pending),
    clearTimer: () => (pending = null),
  };
  return {
    env,
    events,
    fire: () => pending?.fn(),
    pending: () => pending,
    on: createLifecycle(env),
  };
}

describe('lifecycle', () => {
  it('releases the engines after the grace period and resumes on return', () => {
    const t = setup();
    t.on(false);
    expect(t.pending()?.ms).toBe(BACKGROUND_GRACE_MS);
    expect(t.events).toEqual([]);
    t.fire();
    expect(t.events).toEqual(['pagehide']);
    expect(t.env.trimPool).toHaveBeenCalledTimes(1);
    t.on(true);
    expect(t.events).toEqual(['pagehide', 'pageshow']);
  });

  it('a short inactive phase releases nothing and resumes nothing', () => {
    const t = setup();
    t.on(false);
    t.on(true);
    expect(t.pending()).toBeNull();
    expect(t.events).toEqual([]);
    expect(t.env.trimPool).not.toHaveBeenCalled();
  });

  it('ignores repeated state changes', () => {
    const t = setup();
    t.on(false);
    t.fire();
    t.on(false);
    t.on(true);
    t.on(true);
    expect(t.events).toEqual(['pagehide', 'pageshow']);
  });
});
