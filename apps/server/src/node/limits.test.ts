import { describe, expect, it } from 'vitest';
import type { EngineDescriptor, Limits } from '@daisychess/engine-core';
import { clampEngines } from './limits.js';

const limits: Limits = {
  maxDepth: 20,
  maxMultipv: 1,
  maxThreads: 2,
  maxHash: 32,
  maxMovetimeMs: 10_000,
  maxSessionsPerConnection: 1,
  maxNodes: 100,
};

describe('clampEngines', () => {
  it('clamps defaults and maxNodes to the limits and returns copies', () => {
    const engines: EngineDescriptor[] = [
      { id: 'sf', name: 'SF', enabled: true, defaults: { threads: 8, hash: 256 } },
      {
        id: 'maia',
        name: 'Maia',
        enabled: true,
        defaults: { threads: 1, hash: 16 },
        style: 'human',
        rating: 1500,
        maxNodes: 1_000,
      },
    ];
    const out = clampEngines(engines, limits);
    expect(out[0]!.defaults).toEqual({ threads: 2, hash: 32 });
    expect(out[1]).toEqual({ ...engines[1], maxNodes: 100 });
    expect(out[0]).not.toBe(engines[0]);
    expect(engines[0]!.defaults).toEqual({ threads: 8, hash: 256 });
  });
  it('leaves maxNodes alone when the limits have none', () => {
    const noNodes: Limits = { ...limits };
    delete noNodes.maxNodes;
    const e: EngineDescriptor = {
      id: 'm',
      name: 'M',
      enabled: true,
      defaults: { threads: 1, hash: 16 },
      maxNodes: 1,
    };
    expect(clampEngines([e], noNodes)[0]!.maxNodes).toBe(1);
  });
});
