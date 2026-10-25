import type { EngineDescriptor, Limits } from '@daisychess/engine-core';

/**
 * Engine descriptors as a client with `limits` must see them: `defaults.threads/hash` (used when
 * `analyze` omits them) and `maxNodes` clamped to the limits, so an `analyze` without explicit
 * values can never run above what the client may request explicitly. Returns copies.
 */
export function clampEngines(
  engines: readonly EngineDescriptor[],
  limits: Limits,
): EngineDescriptor[] {
  return engines.map((e) => {
    const d: EngineDescriptor = {
      ...e,
      defaults: {
        threads: Math.min(e.defaults.threads, limits.maxThreads),
        hash: Math.min(e.defaults.hash, limits.maxHash),
      },
    };
    if (e.maxNodes !== undefined && limits.maxNodes !== undefined) {
      d.maxNodes = Math.min(e.maxNodes, limits.maxNodes);
    }
    return d;
  });
}
