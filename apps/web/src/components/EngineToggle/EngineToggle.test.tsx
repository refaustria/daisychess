// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { engineStatusText } from './EngineToggle';

const base = { enabled: true, status: 'analysing' as const, lines: [], terminal: null };

describe('engineStatusText', () => {
  it('describes each state', () => {
    expect(engineStatusText({ ...base, enabled: false, status: 'idle' })).toBe('Off');
    expect(engineStatusText({ ...base, status: 'loading' })).toBe('Loading engine…');
    expect(engineStatusText({ ...base, status: 'error', error: 'boom' })).toBe('Error: boom');
    expect(
      engineStatusText({
        ...base,
        engineName: 'Stockfish 19 Lite WASM Multithreaded',
        capabilities: { threads: true, build: 'x', threadCount: 4 },
        lines: [{ multipv: 1, depth: 18, score: { cp: 1 }, pv: [] }],
      }),
    ).toBe('Stockfish 19 · 4 threads · depth 18');
    expect(
      engineStatusText({
        ...base,
        engineName: 'SF',
        capabilities: { threads: false, build: 'x', threadCount: 1 },
      }),
    ).toBe('SF · 1 thread');
  });
});
