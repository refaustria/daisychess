/**
 * Minimal global hook so Playwright (and the browser console) can drive the WASM engine without UI.
 * Harmless in production: it only exposes a factory; the engine code is loaded lazily on first use.
 */
import type { WasmEngineClient, WasmEngineClientOptions } from './WasmEngineClient';
import type { RemoteEngineClient, RemoteEngineClientOptions } from './RemoteEngineClient';
import { browserEnginePool, type EnginePoolStats } from './wasmPool';
import { resetWasmPeak, wasmHealth, type WasmHealth } from './wasmHealth';

/** Browser engine instances (worker groups): alive now, peak since the last reset, all created. */
export interface WasmInstanceStats extends Pick<WasmHealth, 'live' | 'peak' | 'created'> {
  degraded: boolean;
  disabled?: string;
  pool: EnginePoolStats;
}

export interface DaisyChessDevHook {
  createWasmEngine(options?: WasmEngineClientOptions): Promise<WasmEngineClient>;
  createRemoteEngine(options?: RemoteEngineClientOptions): Promise<RemoteEngineClient>;
  /** Engine instance counters (ADR-015; e2e asserts the peak). */
  wasmInstances(): WasmInstanceStats;
  resetWasmPeak(): void;
}

declare global {
  interface Window {
    __daisychess?: DaisyChessDevHook;
  }
}

window.__daisychess = {
  ...window.__daisychess,
  async createWasmEngine(options) {
    const { WasmEngineClient } = await import('./WasmEngineClient');
    return new WasmEngineClient(options);
  },
  createRemoteEngine: async (options) => new (await import('./RemoteEngineClient')).RemoteEngineClient(options),
  wasmInstances: () => {
    const h = wasmHealth();
    return {
      live: h.live,
      peak: h.peak,
      created: h.created,
      degraded: h.degraded,
      ...(h.disabled !== undefined ? { disabled: h.disabled } : {}),
      pool: browserEnginePool.stats,
    };
  },
  resetWasmPeak,
  runReview: async (options) => (await import('../review/reviewDevHook')).runReview(options),
};
