import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, minLimits, type Limits } from './index.js';

const big: Limits = {
  maxDepth: 60,
  maxMultipv: 5,
  maxThreads: 16,
  maxHash: 2048,
  maxMovetimeMs: 600_000,
  maxSessionsPerConnection: 4,
  maxNodes: 1_000_000,
};
const small: Limits = {
  maxDepth: 20,
  maxMultipv: 1,
  maxThreads: 2,
  maxHash: 64,
  maxMovetimeMs: 60_000,
  maxSessionsPerConnection: 1,
  maxNodes: 1_000,
};

describe('minLimits', () => {
  it('takes the element-wise minimum, in either argument order', () => {
    expect(minLimits(big, small)).toEqual(small);
    expect(minLimits(small, big)).toEqual(small);
    const mixed = minLimits(
      { ...big, maxDepth: 10, maxHash: 4096 },
      { ...small, maxDepth: 30, maxHash: 128 },
    );
    expect(mixed).toMatchObject({ maxDepth: 10, maxHash: 128 });
  });

  it('an absent maxNodes takes the other side; absent on both stays absent', () => {
    const noNodes: Limits = { ...big };
    delete noNodes.maxNodes;
    expect(minLimits(noNodes, small).maxNodes).toBe(1_000);
    expect(minLimits(small, noNodes).maxNodes).toBe(1_000);
    expect('maxNodes' in minLimits(noNodes, noNodes)).toBe(false);
  });

  it('returns a new object and leaves the inputs untouched', () => {
    const a = { ...DEFAULT_LIMITS };
    const b = { ...DEFAULT_LIMITS };
    const out = minLimits(a, b);
    expect(out).toEqual(DEFAULT_LIMITS);
    expect(out).not.toBe(a);
    expect(a).toEqual(DEFAULT_LIMITS);
  });
});
