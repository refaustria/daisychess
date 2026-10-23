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

  it('describes the server backend', () => {
    const remote = { ...base, settings: { depth: 22, multipv: 1, backend: 'remote' as const } };
    expect(engineStatusText({ ...remote, status: 'loading', backendStatus: 'connecting' })).toBe(
      'Connecting to server…',
    );
    expect(
      engineStatusText({
        ...remote,
        engineName: 'Stockfish 19 (native)',
        capabilities: { threads: true, build: 'x', threadCount: 4 },
        backendStatus: 'ready',
      }),
    ).toBe('Stockfish 19 · server · 4 threads');
    expect(
      engineStatusText({
        ...remote,
        status: 'error',
        error: 'raw',
        backendError: 'Server unreachable',
      }),
    ).toBe('Server unreachable');
    expect(
      engineStatusText({
        ...remote,
        status: 'error',
        error: 'raw',
        backendError: 'Connection lost',
      }),
    ).toBe('Connection lost');
    expect(engineStatusText({ ...remote, status: 'analysing', backendStatus: 'closed' })).toBe(
      'Connection lost',
    );
    expect(engineStatusText({ ...remote, status: 'error', error: 'boom' })).toBe('boom');
  });
});
