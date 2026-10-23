/**
 * Minimal global hook so Playwright (and the browser console) can drive the WASM engine without UI.
 * Harmless in production: it only exposes a factory; the engine code is loaded lazily on first use.
 */
import type { WasmEngineClient, WasmEngineClientOptions } from './WasmEngineClient';

export interface ChessLabDevHook {
  createWasmEngine(options?: WasmEngineClientOptions): Promise<WasmEngineClient>;
}

declare global {
  interface Window {
    __chesslab?: ChessLabDevHook;
  }
}

window.__chesslab = {
  ...window.__chesslab,
  async createWasmEngine(options) {
    const { WasmEngineClient } = await import('./WasmEngineClient');
    return new WasmEngineClient(options);
  },
};
