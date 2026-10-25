import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserEngineUnsupportedReason,
  detectWasmSupport,
  NO_SIMD_REASON,
  NO_WASM_REASON,
  setWasmSupportForTests,
  SIMD_MISSING_ERROR,
  SIMD_PROBE,
  THREADS_PROBE,
  WASM_MISSING_ERROR,
  wasmSupport,
  type ValidateFn,
} from './wasmSupport';

const same = (a: BufferSource, b: Uint8Array): boolean => {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a as ArrayBuffer);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

/** A `validate` that accepts every module except the listed probes. */
const without =
  (...missing: Uint8Array[]): ValidateFn =>
  (bytes) =>
    !missing.some((m) => same(bytes, m));

afterEach(() => setWasmSupportForTests(null));

describe('detectWasmSupport', () => {
  it('everything supported', () => {
    const validate = vi.fn(without());
    expect(detectWasmSupport(validate)).toEqual({ wasm: true, simd: true, threads: true });
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it('no SIMD → not supported with the engine-style cause', () => {
    expect(detectWasmSupport(without(SIMD_PROBE))).toEqual({
      wasm: true,
      simd: false,
      threads: true,
      error: SIMD_MISSING_ERROR,
    });
  });

  it('no threads only: SIMD builds still run (no error)', () => {
    expect(detectWasmSupport(without(THREADS_PROBE))).toEqual({
      wasm: true,
      simd: true,
      threads: false,
    });
  });

  it('a validate that throws counts as unsupported; its message is the cause', () => {
    const validate: ValidateFn = () => {
      throw Object.assign(new Error('wasm-simd is not enabled'), { name: 'CompileError' });
    };
    expect(detectWasmSupport(validate)).toEqual({
      wasm: true,
      simd: false,
      threads: false,
      error: 'wasm-simd is not enabled',
    });
    // An empty message falls back to the default cause.
    expect(
      detectWasmSupport(() => {
        throw new Error('');
      }).error,
    ).toBe(SIMD_MISSING_ERROR);
  });

  it('no WebAssembly at all', () => {
    expect(detectWasmSupport(undefined)).toEqual({
      wasm: false,
      simd: false,
      threads: false,
      error: WASM_MISSING_ERROR,
    });
  });

  it('the probe modules are valid where the features exist (Node has SIMD and threads)', () => {
    expect(WebAssembly.validate(SIMD_PROBE)).toBe(true);
    expect(WebAssembly.validate(THREADS_PROBE)).toBe(true);
  });
});

describe('wasmSupport', () => {
  it('probes the global once and caches the result', () => {
    const spy = vi.spyOn(WebAssembly, 'validate');
    setWasmSupportForTests(null);
    expect(wasmSupport()).toEqual({ wasm: true, simd: true, threads: true });
    expect(wasmSupport()).toBe(wasmSupport());
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('a test override wins until cleared', () => {
    const none = { wasm: true, simd: false, threads: true, error: SIMD_MISSING_ERROR };
    setWasmSupportForTests(none);
    expect(wasmSupport()).toBe(none);
    setWasmSupportForTests(null);
    expect(wasmSupport().simd).toBe(true);
  });
});

describe('browserEngineUnsupportedReason', () => {
  it('names the missing feature, undefined when the builds can run', () => {
    expect(browserEngineUnsupportedReason({ wasm: true, simd: true, threads: false })).toBe(
      undefined,
    );
    expect(browserEngineUnsupportedReason({ wasm: true, simd: false, threads: true })).toBe(
      NO_SIMD_REASON,
    );
    expect(browserEngineUnsupportedReason(detectWasmSupport(undefined))).toBe(NO_WASM_REASON);
    setWasmSupportForTests({ wasm: true, simd: false, threads: false, error: 'x' });
    expect(browserEngineUnsupportedReason()).toBe(NO_SIMD_REASON);
  });
});
