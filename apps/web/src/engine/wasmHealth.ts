/**
 * Session-wide health of the browser (WASM) engines (ADR-015), shared by every
 * {@link WasmEngineClient}: out-of-memory / worker failures degrade all later instances to the
 * single-threaded build, a second failure disables the browser engine until the user retries.
 * Also counts live engine instances (worker groups) for the dev hook and tests.
 *
 * Small and dependency-free on purpose: the stores import it eagerly, the engine code is lazy.
 */

export type WasmFailureKind = 'oom' | 'worker';

/** A failure of a browser engine; `retryable` = a fresh (degraded) instance may succeed. */
export class WasmEngineError extends Error {
  readonly kind: WasmFailureKind;
  readonly retryable: boolean;
  constructor(message: string, kind: WasmFailureKind, retryable: boolean) {
    super(message);
    this.name = 'WasmEngineError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

/** True for errors after which a fresh engine instance should be created once (no error shown). */
export function isRetryableEngineError(err: unknown): boolean {
  return (err as { retryable?: unknown } | null)?.retryable === true;
}

/**
 * `oom` for "Out of memory" (Safari's `RangeError` from `WebAssembly.Memory`, Emscripten's
 * `Aborted(OOM)`), `worker` for other worker/runtime failures (worker `error` event, abort,
 * unreadable message); null for everything else (timeouts, dispose, invalid input).
 */
export function classifyWasmFailure(err: unknown): WasmFailureKind | null {
  if (err instanceof WasmEngineError) return err.kind;
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (/out of memory|\bOOM\b|RangeError: (Array buffer allocation failed|WebAssembly\.Memory)/i.test(msg))
    return 'oom';
  if (/Stockfish (worker error|aborted|worker sent an unreadable message)/.test(msg)) return 'worker';
  return null;
}

export interface WasmHealth {
  /** A failure happened: new instances use the single-threaded build with one thread. */
  degraded: boolean;
  /** Set after the degraded retry failed too: instances refuse to load (until {@link allowWasmRetry}). */
  disabled?: string;
  /** One-line notice for the engine panel (set once, when degrading). */
  notice?: string;
  /** Engine workers (instances) alive now, the peak since the last reset, and all created. */
  live: number;
  peak: number;
  created: number;
}

export const degradedNotice = (kind: WasmFailureKind): string =>
  kind === 'oom'
    ? 'Browser engine restarted with 1 thread after running out of memory'
    : 'Browser engine restarted with 1 thread after an engine error';

const initial = (): WasmHealth => ({ degraded: false, live: 0, peak: 0, created: 0 });
let state: WasmHealth = initial();
const listeners = new Set<(h: WasmHealth) => void>();

function update(patch: Partial<WasmHealth>): void {
  state = { ...state, ...patch };
  for (const l of [...listeners]) l(state);
}

export function wasmHealth(): WasmHealth {
  return state;
}

export function subscribeWasmHealth(listener: (h: WasmHealth) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** First failure of a full-size instance: later instances are single-threaded; shows the notice. */
export function markWasmDegraded(kind: WasmFailureKind): void {
  if (state.degraded) return;
  update({ degraded: true, notice: degradedNotice(kind) });
}

/** The degraded instance failed too: no more automatic attempts this session. */
export function disableWasm(message: string): void {
  if (state.disabled !== undefined) return;
  update({ degraded: true, disabled: message, notice: undefined });
}

/** Explicit user retry: allows one more (degraded) attempt. */
export function allowWasmRetry(): void {
  if (state.disabled !== undefined) update({ disabled: undefined });
}

export function clearWasmNotice(): void {
  if (state.notice !== undefined) update({ notice: undefined });
}

export function wasmInstanceStarted(): void {
  const live = state.live + 1;
  update({ live, peak: Math.max(state.peak, live), created: state.created + 1 });
}

export function wasmInstanceStopped(): void {
  update({ live: Math.max(0, state.live - 1) });
}

/** Resets the peak to the current number of live instances (dev hook). */
export function resetWasmPeak(): void {
  update({ peak: state.live });
}

/** Tests: forgets degradation, notices and counters. */
export function resetWasmHealth(): void {
  state = initial();
  for (const l of [...listeners]) l(state);
}
