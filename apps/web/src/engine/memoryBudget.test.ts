import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  budgetReason,
  currentMemoryBudget,
  currentMemoryEnv,
  defaultThreadCount,
  isAppleMobile,
  isLowMemory,
  memoryBudget,
  threadCap,
  type MemoryEnv,
} from './memoryBudget';

const DESKTOP: MemoryEnv = {
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36',
  platform: 'Linux x86_64',
  maxTouchPoints: 0,
  deviceMemory: 8,
  hardwareConcurrency: 16,
};
const MAC: MemoryEnv = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  platform: 'MacIntel',
  maxTouchPoints: 0,
  hardwareConcurrency: 8,
};
const IPAD_DESKTOP_UA: MemoryEnv = { ...MAC, maxTouchPoints: 5 };
const IPHONE: MemoryEnv = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  platform: 'iPhone',
  maxTouchPoints: 5,
  hardwareConcurrency: 6,
};

describe('memoryBudget', () => {
  it('defaultThreadCount: min(cores - 1, 4), at least 1', () => {
    expect([16, 5, 4, 2, 1, 0, Number.NaN].map(defaultThreadCount)).toEqual([4, 4, 3, 1, 1, 1, 1]);
  });

  it('detects iOS/iPadOS, also with the desktop user agent of iPadOS 13+', () => {
    expect(isAppleMobile(IPHONE)).toBe(true);
    expect(isAppleMobile(IPAD_DESKTOP_UA)).toBe(true);
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 12_0)', platform: '', maxTouchPoints: 0 })).toBe(true);
    expect(isAppleMobile(MAC)).toBe(false);
    expect(isAppleMobile(DESKTOP)).toBe(false);
  });

  it('low memory: deviceMemory ≤ 2 GiB; unknown is not low', () => {
    expect(isLowMemory({ deviceMemory: 2 })).toBe(true);
    expect(isLowMemory({ deviceMemory: 0.5 })).toBe(true);
    expect(isLowMemory({ deviceMemory: 4 })).toBe(false);
    expect(isLowMemory({})).toBe(false);
    expect(isLowMemory({ deviceMemory: Number.NaN })).toBe(false);
  });

  it('iOS and low-memory devices: one instance, at most 2 threads', () => {
    expect(memoryBudget(IPAD_DESKTOP_UA)).toEqual({
      maxInstances: 1,
      maxThreads: 2,
      constrained: true,
      reason: 'ios',
    });
    expect(memoryBudget({ ...DESKTOP, deviceMemory: 2 })).toEqual({
      maxInstances: 1,
      maxThreads: 2,
      constrained: true,
      reason: 'low-memory',
    });
    // Fewer cores than the cap: the default stays lower.
    expect(memoryBudget({ ...IPHONE, hardwareConcurrency: 2 }).maxThreads).toBe(1);
  });

  it('other devices: two instances, the default thread count', () => {
    expect(memoryBudget(DESKTOP)).toEqual({ maxInstances: 2, maxThreads: 4, constrained: false });
    expect(memoryBudget({ ...MAC, hardwareConcurrency: 3 })).toEqual({
      maxInstances: 2,
      maxThreads: 2,
      constrained: false,
    });
  });

  it('threadCap only caps constrained devices; budgetReason texts', () => {
    expect(threadCap(memoryBudget(IPHONE))).toBe(2);
    expect(threadCap(memoryBudget(DESKTOP))).toBeUndefined();
    expect(threadCap(undefined)).toBeUndefined();
    expect(budgetReason({ maxInstances: 1 })).toBe(
      'Memory budget: one browser engine at a time on this device',
    );
    expect(budgetReason({ maxInstances: 3 })).toMatch(/at most 3 browser engines/);
  });
});

describe('currentMemoryEnv', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads navigator (deviceMemory only when present)', () => {
    vi.stubGlobal('navigator', {
      userAgent: IPAD_DESKTOP_UA.userAgent,
      platform: 'MacIntel',
      maxTouchPoints: 5,
      hardwareConcurrency: 8,
    });
    expect(currentMemoryEnv()).toEqual({ ...IPAD_DESKTOP_UA });
    expect(currentMemoryBudget()).toMatchObject({ constrained: true, reason: 'ios' });
    vi.stubGlobal('navigator', { ...DESKTOP });
    expect(currentMemoryEnv()).toEqual(DESKTOP);
  });

  it('defaults without navigator', () => {
    vi.stubGlobal('navigator', undefined);
    expect(currentMemoryEnv()).toEqual({
      userAgent: '',
      platform: '',
      maxTouchPoints: 0,
      hardwareConcurrency: 1,
    });
  });
});
