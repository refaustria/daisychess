/**
 * Cheap WebAssembly feature probe for the browser engines: every Stockfish 19 build shipped
 * (`lite`, `lite-single`, `full`) is compiled with SIMD, and the multi-threaded ones also need
 * shared memory + atomics. Probing two tiny modules with `WebAssembly.validate` (synchronous, no
 * compilation, no worker) lets the registry, the review, the drill and play say why the browser
 * engine cannot run instead of spawning a worker that dies with an unhandled `CompileError` and
 * leaves the UCI handshake to time out after 30 s.
 *
 * Small and dependency-free: the stores import it eagerly.
 */

/** `(func (result v128) i32.const 0 i8x16.splat i8x16.popcnt)` — validates only with SIMD. */
export const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

/** Shared memory + `i32.atomic.load` — validates only with the threads proposal. */
export const THREADS_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65,
  0, 254, 16, 2, 0, 26, 11,
]);

export interface WasmSupport {
  /** `WebAssembly` exists at all. */
  wasm: boolean;
  /** Fixed-width SIMD (needed by every shipped build). */
  simd: boolean;
  /** Shared memory and atomics (needed by the multi-threaded builds). */
  threads: boolean;
  /**
   * Short technical cause when the browser engines cannot run at all (SIMD or WebAssembly
   * missing), e.g. "wasm-simd is not enabled"; undefined when they can.
   */
  error?: string;
}

export type ValidateFn = (bytes: BufferSource) => boolean;

/** The engine's own words when SIMD is missing (WebKit's CompileError text). */
export const SIMD_MISSING_ERROR = 'wasm-simd is not enabled';
export const WASM_MISSING_ERROR = 'WebAssembly is not available';

/** Picker / panel reasons (registry). */
export const NO_SIMD_REASON = 'This browser lacks WebAssembly SIMD';
export const NO_WASM_REASON = 'This browser lacks WebAssembly';
export const NO_THREADS_REASON = 'This browser lacks WebAssembly threads';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Probes `validate` (pure; `undefined` = no WebAssembly). A `validate` that throws counts as
 * "not supported" and its message becomes the cause.
 */
export function detectWasmSupport(validate: ValidateFn | undefined): WasmSupport {
  if (typeof validate !== 'function') {
    return { wasm: false, simd: false, threads: false, error: WASM_MISSING_ERROR };
  }
  const probe = (bytes: BufferSource): { ok: boolean; error?: string } => {
    try {
      return { ok: validate(bytes) === true };
    } catch (err) {
      return { ok: false, error: message(err) || undefined };
    }
  };
  const simd = probe(SIMD_PROBE);
  const threads = probe(THREADS_PROBE);
  return {
    wasm: true,
    simd: simd.ok,
    threads: threads.ok,
    ...(simd.ok ? {} : { error: simd.error ?? SIMD_MISSING_ERROR }),
  };
}

let cached: WasmSupport | null = null;
let override: WasmSupport | null = null;

/** Support of this browser (probed once; `WebAssembly.validate` of the global). */
export function wasmSupport(): WasmSupport {
  if (override) return override;
  if (!cached) {
    const wa = (globalThis as { WebAssembly?: { validate?: ValidateFn } }).WebAssembly;
    const validate = wa?.validate;
    cached = detectWasmSupport(typeof validate === 'function' ? validate.bind(wa) : undefined);
  }
  return cached;
}

/** Tests: forces a result (`null` = probe the real global again). */
export function setWasmSupportForTests(s: WasmSupport | null): void {
  override = s;
  cached = null;
}

/** Registry reason why no browser build can run (undefined: SIMD available). */
export function browserEngineUnsupportedReason(s: WasmSupport = wasmSupport()): string | undefined {
  if (!s.wasm) return NO_WASM_REASON;
  if (!s.simd) return NO_SIMD_REASON;
  return undefined;
}
