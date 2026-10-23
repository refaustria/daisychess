// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { usePlayStore } from '../../play/playStore';
import { UNAUTHORIZED_MESSAGE, useAnalysisStore } from '../../store/analysisStore';
import { EngineToggle, engineStatusText } from './EngineToggle';

afterEach(cleanup);

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
    const remote = { ...base, remote: true };
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

  it('shows the access-token error with a hint to open Settings', () => {
    const key = 'remote:stockfish';
    useAnalysisStore.setState({
      enabled: true,
      enabledEngines: [key],
      instances: {
        [key]: { key, status: 'error', lines: [], backendError: UNAUTHORIZED_MESSAGE },
      },
    });
    render(<EngineToggle />);
    const status = screen.getByTestId('engine-status');
    expect(status.textContent).toBe('Access token required or wrong (see Settings)');
    expect(status.getAttribute('title')).toMatch(/Settings tab/);
  });
});

describe('EngineToggle while playing', () => {
  it('disables the switch with a tooltip, and re-enables it afterwards', () => {
    usePlayStore.setState({ mode: 'playing' });
    const { container } = render(<EngineToggle />);
    const sw = screen.getByRole('switch', { name: 'Engine' }) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(container.querySelector('label')?.getAttribute('title')).toBe(
      'Paused while playing against the engine',
    );
    cleanup();
    usePlayStore.setState({ mode: 'idle' });
    render(<EngineToggle />);
    expect((screen.getByRole('switch', { name: 'Engine' }) as HTMLInputElement).disabled).toBe(
      false,
    );
  });
});
