import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs in apps/web (jsdom: import.meta.url is not a file URL).
const SOURCE = readFileSync(join(process.cwd(), 'engine-shim/stockfish-memory-shim.js'), 'utf8');

interface Run {
  imported: string[];
  created: WebAssembly.MemoryDescriptor[];
  memory: unknown;
  shimSelf: Record<string, unknown>;
}

/** Runs the shim with a fake worker scope; `Memory` records descriptors instead of allocating. */
function runShim(href: string): Run {
  const created: WebAssembly.MemoryDescriptor[] = [];
  class FakeMemory {
    constructor(d: WebAssembly.MemoryDescriptor) {
      created.push(d);
    }
  }
  const wasm = { Memory: FakeMemory as unknown };
  const imported: string[] = [];
  const shimSelf: Record<string, unknown> = { location: new URL(href) };
  const run = new Function('self', 'importScripts', 'WebAssembly', SOURCE);
  run(shimSelf, (u: string) => imported.push(u), wasm);
  const Patched = wasm.Memory as new (d: WebAssembly.MemoryDescriptor) => unknown;
  const memory = new Patched({ initial: 2048, maximum: 32768, shared: true });
  return { imported, created, memory, shimSelf };
}

describe('stockfish-memory-shim.js', () => {
  it('caps the maximum of the shared memory and runs the engine script next to it', () => {
    const r = runShim(
      'https://c.test/assets/engine/stockfish-19.0.1/stockfish-memory-shim.js?engine=stockfish-19-lite.js&maxPages=8192#x',
    );
    expect(r.imported).toEqual(['https://c.test/assets/engine/stockfish-19.0.1/stockfish-19-lite.js']);
    expect(r.created).toEqual([{ initial: 2048, maximum: 8192, shared: true }]);
    expect(r.shimSelf.__chesslabMemory).toMatchObject({ maximum: 8192 });
  });

  it('never lowers the maximum below the initial size; without maxPages nothing is patched', () => {
    const low = runShim('https://c.test/e/stockfish-memory-shim.js?engine=stockfish-19-lite.js&maxPages=100');
    expect(low.created[0]).toMatchObject({ initial: 2048, maximum: 2048 });
    const none = runShim('https://c.test/e/stockfish-memory-shim.js?engine=stockfish-19-lite.js');
    expect(none.created).toEqual([{ initial: 2048, maximum: 32768, shared: true }]);
  });

  it('refuses other scripts', () => {
    expect(() => runShim('https://c.test/e/stockfish-memory-shim.js?engine=https://evil.test/x.js')).toThrow(
      /invalid engine/,
    );
  });
});
