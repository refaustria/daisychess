import { beforeEach, describe, expect, it } from 'vitest';
import {
  allowWasmRetry,
  classifyWasmFailure,
  clearWasmNotice,
  degradedNotice,
  disableWasm,
  isRetryableEngineError,
  markWasmDegraded,
  resetWasmHealth,
  resetWasmPeak,
  subscribeWasmHealth,
  WasmEngineError,
  wasmHealth,
  wasmInstanceStarted,
  wasmInstanceStopped,
} from './wasmHealth';

beforeEach(() => resetWasmHealth());

describe('wasmHealth', () => {
  it('classifies out-of-memory and worker failures', () => {
    const e = (m: string) => new Error(m);
    expect(
      classifyWasmFailure(
        e('Stockfish worker error: RangeError: Out of memory (https://x/stockfish-19-lite.js:12)'),
      ),
    ).toBe('oom');
    expect(classifyWasmFailure(e('Stockfish aborted: Aborted(OOM)'))).toBe('oom');
    expect(classifyWasmFailure(Object.assign(new RangeError('WebAssembly.Memory(): could not allocate memory'), {}))).toBe('oom');
    expect(classifyWasmFailure(e('Stockfish worker error: RuntimeError: unreachable'))).toBe('worker');
    expect(classifyWasmFailure(e('Stockfish aborted: Aborted(x)'))).toBe('worker');
    expect(classifyWasmFailure(e('Stockfish worker sent an unreadable message'))).toBe('worker');
    expect(classifyWasmFailure(e("Engine did not answer with 'uciok' within 5 ms"))).toBeNull();
    expect(classifyWasmFailure(e('Engine has been disposed'))).toBeNull();
    expect(classifyWasmFailure(new WasmEngineError('x', 'worker', true))).toBe('worker');
    expect(classifyWasmFailure('Out of memory')).toBe('oom');
  });

  it('isRetryableEngineError', () => {
    expect(isRetryableEngineError(new WasmEngineError('x', 'oom', true))).toBe(true);
    expect(isRetryableEngineError(new WasmEngineError('x', 'oom', false))).toBe(false);
    expect(isRetryableEngineError(new Error('x'))).toBe(false);
    expect(isRetryableEngineError(null)).toBe(false);
  });

  it('degrades once with one notice, disables, re-allows on explicit retry', () => {
    const seen: (string | undefined)[] = [];
    const unsub = subscribeWasmHealth((h) => seen.push(h.notice));
    markWasmDegraded('oom');
    markWasmDegraded('worker');
    expect(wasmHealth()).toMatchObject({ degraded: true, notice: degradedNotice('oom') });
    expect(seen).toEqual([degradedNotice('oom')]);
    clearWasmNotice();
    expect(wasmHealth().notice).toBeUndefined();
    disableWasm('boom');
    disableWasm('other');
    expect(wasmHealth().disabled).toBe('boom');
    allowWasmRetry();
    expect(wasmHealth()).toMatchObject({ degraded: true, disabled: undefined });
    unsub();
    expect(degradedNotice('worker')).toMatch(/after an engine error/);
  });

  it('counts live instances, peak and created', () => {
    wasmInstanceStarted();
    wasmInstanceStarted();
    wasmInstanceStopped();
    expect(wasmHealth()).toMatchObject({ live: 1, peak: 2, created: 2 });
    resetWasmPeak();
    expect(wasmHealth().peak).toBe(1);
    wasmInstanceStopped();
    wasmInstanceStopped();
    expect(wasmHealth().live).toBe(0);
  });
});
