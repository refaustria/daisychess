/**
 * Native smoke check (ADR-022, CI job `mobile`): only in a mobile bundle built with
 * `VITE_MOBILE_SMOKE=1`; `main.tsx` imports this module behind that compile-time flag, so neither
 * the web build nor a store build contains it.
 *
 * It reports what the WebView gives the app and whether the single-threaded WASM engine answers,
 * as one console line. Capacitor forwards console output to logcat (tag `Capacitor/Console`) on
 * Android and to the app's stdout on iOS, where the CI job reads it
 * (`apps/mobile/scripts/check-smoke-log.mjs`).
 */
import type { BestMove } from '@daisychess/engine-core';
import { nativePlatform } from './index';

/** Prefix of the result line; the CI checker looks for exactly this. */
export const SMOKE_MARKER = 'DAISYCHESS_SMOKE';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export interface SmokeResult {
  platform: string;
  origin: string;
  isSecureContext: boolean;
  crossOriginIsolated: boolean;
  engine: 'wasm:lite-single';
  bestmove: string | null;
  ms: number;
  error?: string;
}

/** The part of the WASM client the check drives (injectable for unit tests). */
export interface SmokeEngine {
  load(): Promise<void>;
  analyze(
    fen: string,
    opts: { depth: number },
  ): AsyncIterable<unknown> & {
    readonly bestMove: Promise<BestMove | null>;
  };
  dispose(): Promise<void>;
}

export interface SmokeOptions {
  createEngine?: () => Promise<SmokeEngine>;
  log?: (line: string) => void;
  depth?: number;
  timeoutMs?: number;
}

async function defaultEngine(): Promise<SmokeEngine> {
  const { WasmEngineClient } = await import('../engine/WasmEngineClient');
  return new WasmEngineClient({ build: 'lite-single' });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Runs the check once and logs `DAISYCHESS_SMOKE <json>`; never throws. */
export async function runSmoke(options: SmokeOptions = {}): Promise<SmokeResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const t0 = performance.now();
  const result: SmokeResult = {
    platform: nativePlatform() ?? 'web',
    origin: globalThis.location?.origin ?? '',
    isSecureContext: globalThis.isSecureContext === true,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    engine: 'wasm:lite-single',
    bestmove: null,
    ms: 0,
  };
  let engine: SmokeEngine | undefined;
  try {
    const search = async () => {
      engine = await (options.createEngine ?? defaultEngine)();
      await engine.load();
      const handle = engine.analyze(START_FEN, { depth: options.depth ?? 10 });
      for await (const info of handle) void info;
      return (await handle.bestMove)?.move ?? null;
    };
    result.bestmove = await withTimeout(search(), options.timeoutMs ?? 120_000);
    if (result.bestmove === null) result.error = 'engine returned no bestmove';
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.ms = Math.round(performance.now() - t0);
    await engine?.dispose().catch(() => undefined);
  }
  log(`${SMOKE_MARKER} ${JSON.stringify(result)}`);
  return result;
}
