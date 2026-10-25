/**
 * Browser engine memory budget (ADR-015).
 *
 * Every Stockfish WASM instance owns a 128 MiB `WebAssembly.Memory` (2 GiB maximum; shared for the
 * multi-threaded builds) plus one Web Worker per search thread, each with its own compiled module
 * and JS heap. Measured in headless Chromium: ~+60 MiB RSS for `lite-single`, ~+80 MiB for `lite`
 * with 1 thread, ~+110 MiB with 2 and ~+155 MiB with 4 threads per instance. iOS/iPadOS Safari caps
 * the memory of a page far below desktop browsers and answers the next allocation with
 * `RangeError: Out of memory` in the worker, so memory-constrained devices get one browser engine
 * at a time with at most two threads.
 *
 * Pure: the environment is passed in ({@link currentMemoryEnv} reads it from `navigator`).
 */

export interface MemoryEnv {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  /** `navigator.deviceMemory` in GiB (Chromium only: 0.25 … 8, rounded); undefined elsewhere. */
  deviceMemory?: number;
  hardwareConcurrency: number;
}

export type MemoryBudgetReason = 'ios' | 'low-memory';

export interface MemoryBudget {
  /** Browser engines (WASM instances) the live analysis may run at once. */
  maxInstances: number;
  /** Threads of a multi-threaded browser build (default and, when constrained, the cap). */
  maxThreads: number;
  /** iOS/iPadOS or a low-memory device: engines are released while paused, threads are capped. */
  constrained: boolean;
  reason?: MemoryBudgetReason;
}

/** `deviceMemory` at or below this (GiB) counts as a low-memory device. */
export const LOW_DEVICE_MEMORY_GB = 2;
/**
 * Maximum of the multi-threaded builds' shared `WebAssembly.Memory` on constrained devices, in
 * 64 KiB pages (8192 = 512 MiB instead of the build's 2 GiB; initial stays 128 MiB). Enough for
 * the default 16 MB hash and up to ~256 MB; applied through the worker shim
 * (`engine-shim/stockfish-memory-shim.js`).
 */
export const CONSTRAINED_MAX_MEMORY_PAGES = 8192;
/** Thread cap of the multi-threaded builds on constrained devices. */
export const CONSTRAINED_MAX_THREADS = 2;
/** Upper bound of the default thread count (more threads rarely pay off in the browser). */
export const MAX_DEFAULT_THREADS = 4;
/** Browser engines on devices without a constraint (one multi- and one single-threaded build). */
export const DEFAULT_MAX_INSTANCES = 2;

/** Default thread count of the multi-threaded builds: `min(cores - 1, 4)`, at least 1. */
export function defaultThreadCount(hardwareConcurrency: number): number {
  const cores = Number.isFinite(hardwareConcurrency) ? Math.floor(hardwareConcurrency) : 1;
  return Math.max(1, Math.min(cores - 1, MAX_DEFAULT_THREADS));
}

/**
 * iPhone, iPod or iPad, including iPadOS 13+ which reports a Mac user agent and `MacIntel`
 * platform but has touch points (no Mac has a touch screen).
 */
export function isAppleMobile(env: Pick<MemoryEnv, 'userAgent' | 'platform' | 'maxTouchPoints'>): boolean {
  if (/\b(iPad|iPhone|iPod)\b/.test(env.userAgent) || /^(iPad|iPhone|iPod)/.test(env.platform)) {
    return true;
  }
  const macLike = env.platform === 'MacIntel' || /\bMacintosh\b/.test(env.userAgent);
  return macLike && env.maxTouchPoints > 1;
}

export function isLowMemory(env: Pick<MemoryEnv, 'deviceMemory'>): boolean {
  const m = env.deviceMemory;
  return typeof m === 'number' && Number.isFinite(m) && m > 0 && m <= LOW_DEVICE_MEMORY_GB;
}

/**
 * `{ maxInstances: 1, maxThreads: min(2, default) }` on iOS/iPadOS and low-memory devices,
 * otherwise `{ maxInstances: 2, maxThreads: default }` (default = {@link defaultThreadCount}).
 */
export function memoryBudget(env: MemoryEnv): MemoryBudget {
  const threads = defaultThreadCount(env.hardwareConcurrency);
  const reason: MemoryBudgetReason | undefined = isAppleMobile(env)
    ? 'ios'
    : isLowMemory(env)
      ? 'low-memory'
      : undefined;
  if (!reason) return { maxInstances: DEFAULT_MAX_INSTANCES, maxThreads: threads, constrained: false };
  return {
    maxInstances: 1,
    maxThreads: Math.min(CONSTRAINED_MAX_THREADS, threads),
    constrained: true,
    reason,
  };
}

/** Picker reason when enabling another browser engine would exceed the budget. */
export function budgetReason(budget: Pick<MemoryBudget, 'maxInstances'>): string {
  return budget.maxInstances === 1
    ? 'Memory budget: one browser engine at a time on this device'
    : `Memory budget: at most ${budget.maxInstances} browser engines at a time on this device`;
}

/** The thread cap to enforce (only constrained devices are capped; elsewhere the user decides). */
export function threadCap(budget: MemoryBudget | undefined): number | undefined {
  return budget?.constrained ? budget.maxThreads : undefined;
}

/** Shared-memory maximum (pages) to enforce, or undefined (build default) when unconstrained. */
export function memoryPagesCap(budget: MemoryBudget | undefined): number | undefined {
  return budget?.constrained ? CONSTRAINED_MAX_MEMORY_PAGES : undefined;
}

/** Reads the environment of this page (defaults for non-browser runtimes). */
export function currentMemoryEnv(): MemoryEnv {
  // `deviceMemory` is not in the DOM typings (Chromium-only API).
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: unknown }) | undefined;
  const deviceMemory = nav?.deviceMemory;
  return {
    userAgent: nav?.userAgent ?? '',
    platform: nav?.platform ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    ...(typeof deviceMemory === 'number' ? { deviceMemory } : {}),
    hardwareConcurrency: nav?.hardwareConcurrency || 1,
  };
}

export function currentMemoryBudget(): MemoryBudget {
  return memoryBudget(currentMemoryEnv());
}
