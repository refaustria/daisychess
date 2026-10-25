// @vitest-environment jsdom
import {
  EXPIRED_MESSAGE,
  NODE_OFFLINE_MESSAGE,
  NO_TOKEN_MESSAGE,
  TOKEN_REJECTED_MESSAGE,
} from '../../server/tokenMessages';
import { useSettingsStore } from '../../store/settingsStore';
import { useUiStore } from '../../store/uiStore';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useLiveStore } from '../../live/liveStore';
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
    expect(status.textContent).toBe(NO_TOKEN_MESSAGE);
    fireEvent.click(screen.getByTestId('open-token-settings'));
    expect(useUiStore.getState().activeTab).toBe('settings');
  });

  it('a stored but refused token says it was rejected', () => {
    useSettingsStore.getState().setServerToken('abc');
    const key = 'remote:stockfish';
    useAnalysisStore.setState({
      enabled: true,
      enabledEngines: [key],
      instances: {
        [key]: { key, status: 'error', lines: [], backendError: UNAUTHORIZED_MESSAGE },
      },
    });
    render(<EngineToggle />);
    expect(screen.getByTestId('engine-status').textContent).toBe(TOKEN_REJECTED_MESSAGE);
    useSettingsStore.getState().setServerToken('');
  });
});

describe('engine node (ADR-020)', () => {
  const remote = {
    ...base,
    remote: true,
    backendStatus: 'ready' as const,
    engineName: 'Stockfish 19 (native)',
    capabilities: { threads: true as const, build: 'x', threadCount: 4 },
  };

  it('names the private node and its operator; legacy servers say "server"', () => {
    expect(engineStatusText({ ...remote, node: { name: 'fast-box', shared: false } })).toBe(
      'Stockfish 19 · on fast-box · 4 threads',
    );
    expect(
      engineStatusText({ ...remote, node: { name: 'fast-box', operator: 'bojan', shared: false } }),
    ).toBe('Stockfish 19 · on fast-box · bojan · 4 threads');
    expect(engineStatusText(remote)).toBe('Stockfish 19 · server · 4 threads');
  });

  it('marks the community pool', () => {
    expect(
      engineStatusText({ ...remote, node: { name: 'pool-1', operator: 'vol', shared: true } }),
    ).toBe('Stockfish 19 · on pool-1 · vol · community pool · 4 threads');
  });

  it('shows the pool privacy notice once, until accepted', () => {
    const key = 'remote:stockfish';
    const setNode = (shared: boolean) =>
      useAnalysisStore.setState({
        enabled: true,
        enabledEngines: [key],
        instances: {
          [key]: { key, status: 'analysing', lines: [], backendStatus: 'ready', node: { name: 'p', shared } },
        },
      });
    useSettingsStore.getState().set({ poolNoticeAccepted: false });
    setNode(false);
    render(<EngineToggle />);
    expect(screen.queryByTestId('pool-notice')).toBeNull();
    cleanup();
    setNode(true);
    render(<EngineToggle />);
    expect(screen.getByTestId('pool-notice').textContent).toContain(
      "Don't use the pool for private games.",
    );
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(useSettingsStore.getState().poolNoticeAccepted).toBe(true);
    expect(screen.queryByTestId('pool-notice')).toBeNull();
    cleanup();
    render(<EngineToggle />);
    expect(screen.queryByTestId('pool-notice')).toBeNull();
    useSettingsStore.getState().set({ poolNoticeAccepted: false });
  });

  it('shows a precise denial with the settings button for expired tokens only', () => {
    const key = 'remote:stockfish';
    const show = (backendError: string) => {
      useAnalysisStore.setState({
        enabled: true,
        enabledEngines: [key],
        instances: { [key]: { key, status: 'error', lines: [], backendError } },
      });
      render(<EngineToggle />);
    };
    show(EXPIRED_MESSAGE);
    expect(screen.getByTestId('engine-status').textContent).toBe(EXPIRED_MESSAGE);
    expect(screen.queryByTestId('open-token-settings')).not.toBeNull();
    cleanup();
    show(NODE_OFFLINE_MESSAGE);
    expect(screen.getByTestId('engine-status').textContent).toBe(NODE_OFFLINE_MESSAGE);
    expect(screen.queryByTestId('open-token-settings')).toBeNull();
  });
});

describe('EngineToggle during a live lichess game', () => {
  it('is off and disabled with the fair-play tooltip, even if the analysis store says on', () => {
    useAnalysisStore.setState({ enabled: true });
    useLiveStore.setState({ status: 'playing' });
    const { container } = render(<EngineToggle />);
    const sw = screen.getByRole('switch', { name: 'Engine' }) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(sw.checked).toBe(false);
    expect(container.querySelector('label')?.getAttribute('title')).toBe(
      'Disabled during a live game (lichess fair play)',
    );
    cleanup();
    useLiveStore.setState({ status: 'seeking' });
    render(<EngineToggle />);
    expect((screen.getByRole('switch', { name: 'Engine' }) as HTMLInputElement).disabled).toBe(true);
    cleanup();
    useLiveStore.setState({ status: 'finished' });
    useAnalysisStore.setState({ enabled: false });
    render(<EngineToggle />);
    expect((screen.getByRole('switch', { name: 'Engine' }) as HTMLInputElement).disabled).toBe(false);
    useLiveStore.setState({ status: 'idle' });
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
