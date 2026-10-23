// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnalysisStore, type EngineInstanceState } from '../../store/analysisStore';
import { usePreviewStore } from '../../store/previewStore';
import { AnalysisPanel, formatNps, scoreTone } from './AnalysisPanel';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const setSettings = vi.fn();
const setEngineEnabled = vi.fn(() => true);
const probeServer = vi.fn(async () => undefined);
const SINGLE = 'wasm:lite-single';
const REMOTE = 'remote:stockfish';

const browserInstance: EngineInstanceState = {
  key: SINGLE,
  status: 'analysing',
  engineName: 'Stockfish 19 Lite WASM',
  capabilities: { threads: true, build: 'multi-thread', threadCount: 4 },
  lines: [
    { multipv: 1, score: { cp: 35 }, depth: 18, pv: ['e2e4', 'e7e5', 'g1f3'], nps: 1_900_000 },
    { multipv: 2, score: { cp: -80 }, depth: 18, pv: ['d2d4', 'd7d5'] },
  ],
};

const serverInstance: EngineInstanceState = {
  key: REMOTE,
  status: 'analysing',
  engineName: 'Stockfish 19',
  capabilities: { threads: true, build: 'Stockfish 19@0.1.0', threadCount: 4 },
  backendStatus: 'ready',
  lines: [{ multipv: 1, score: { cp: 28 }, depth: 30, pv: ['d2d4', 'g8f6'], nps: 9_000_000 }],
};

function single(instance: EngineInstanceState = browserInstance) {
  useAnalysisStore.setState({
    enabledEngines: [instance.key],
    instances: { [instance.key]: instance },
  });
}

beforeEach(() => {
  setSettings.mockClear();
  setEngineEnabled.mockClear();
  probeServer.mockClear();
  usePreviewStore.setState({ fen: null, moves: [], hover: null });
  useAnalysisStore.setState({
    enabled: true,
    settings: { depth: 22, multipv: 2 },
    fen: START,
    terminal: null,
    serverProbe: { status: 'idle' },
    engineHint: undefined,
    setSettings,
    setEngineEnabled,
    probeServer,
  });
  single();
});
afterEach(cleanup);

describe('AnalysisPanel', () => {
  it('renders header and SAN lines', () => {
    render(<AnalysisPanel />);
    expect(screen.getByText('Stockfish 19')).toBeTruthy();
    expect(screen.getByText(/4 threads/)).toBeTruthy();
    expect(screen.getByText(/1\.9 MN\/s/)).toBeTruthy();
    const rows = screen.getAllByTestId('analysis-line');
    expect(rows).toHaveLength(2);
    expect(within(rows[0] as HTMLElement).getByTestId('analysis-eval').textContent).toBe('+0.35');
    expect(within(rows[0] as HTMLElement).getByTestId('analysis-pv').textContent).toBe(
      '1. e4 e5 2. Nf3',
    );
    expect(within(rows[1] as HTMLElement).getByTestId('analysis-eval').textContent).toBe('-0.80');
  });

  it('renders nothing when the engine is off', () => {
    useAnalysisStore.setState({ enabled: false });
    const { container } = render(<AnalysisPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('settings selects call setSettings', () => {
    render(<AnalysisPanel />);
    fireEvent.change(screen.getByLabelText('Depth'), { target: { value: '0' } });
    expect(setSettings).toHaveBeenLastCalledWith({ depth: 0 });
    fireEvent.change(screen.getByLabelText('Lines'), { target: { value: '3' } });
    expect(setSettings).toHaveBeenLastCalledWith({ multipv: 3 });
    fireEvent.change(screen.getByLabelText('Threads'), { target: { value: '2' } });
    expect(setSettings).toHaveBeenLastCalledWith({ threads: 2 });
  });

  it('disables threads without engine support', () => {
    single({
      ...browserInstance,
      capabilities: { threads: false, build: 'single', threadCount: 1 },
    });
    render(<AnalysisPanel />);
    expect((screen.getByLabelText('Threads') as HTMLSelectElement).disabled).toBe(true);
  });

  it('hover sets arrows, click starts a preview', () => {
    render(<AnalysisPanel />);
    const row = screen.getAllByTestId('analysis-line')[1];
    fireEvent.mouseEnter(row as HTMLElement);
    expect(usePreviewStore.getState().hover).toEqual(['d2d4', 'd7d5']);
    fireEvent.mouseLeave(row as HTMLElement);
    expect(usePreviewStore.getState().hover).toBeNull();
    fireEvent.click(row as HTMLElement);
    expect(usePreviewStore.getState().fen).toContain('3p4');
    expect(usePreviewStore.getState().moves).toEqual(['d4', 'd5']);
  });

  it('formats helpers', () => {
    expect(formatNps(950)).toBe('950 N/s');
    expect(formatNps(12_400)).toBe('12 kN/s');
    expect(formatNps(undefined)).toBeNull();
    expect(scoreTone({ cp: 10 })).toBe('neutral');
    expect(scoreTone({ mate: -2 })).toBe('negative');
    expect(scoreTone({ cp: 200 })).toBe('positive');
  });

  it('engine picker lists the registry, probes the server and toggles engines', () => {
    useAnalysisStore.setState({
      serverProbe: {
        status: 'ok',
        lastProbe: 1,
        engines: [
          {
            id: 'stockfish',
            name: 'Stockfish 19',
            enabled: true,
            defaults: { threads: 4, hash: 256 },
          },
          { id: 'lc0', name: 'Lc0', enabled: false, defaults: { threads: 2, hash: 128 } },
        ],
      },
    });
    render(<AnalysisPanel />);
    expect(screen.queryByTestId('engine-picker')).toBeNull();
    const button = screen.getByRole('button', { name: /Engines/ });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(probeServer).toHaveBeenCalledTimes(1);
    const picker = screen.getByTestId('engine-picker');
    const box = (name: RegExp) =>
      within(picker).getByRole('checkbox', { name }) as HTMLInputElement;
    // jsdom is not cross-origin isolated: the multi-threaded build is greyed out with a reason.
    const [lite] = within(picker).getAllByRole('checkbox') as HTMLInputElement[];
    expect(lite!.disabled).toBe(true);
    expect(within(picker).getByText(/cross-origin isolated/)).toBeTruthy();
    expect(box(/browser, 1 thread/).checked).toBe(true);
    expect(box(/Lc0 \(server\)/).disabled).toBe(true);
    expect(within(picker).getByText('Disabled on the server')).toBeTruthy();
    const server = box(/Stockfish 19 \(server\)/);
    expect(server.disabled).toBe(false);
    fireEvent.click(server);
    expect(setEngineEnabled).toHaveBeenLastCalledWith(REMOTE, true);
    fireEvent.click(box(/browser, 1 thread/));
    expect(setEngineEnabled).toHaveBeenLastCalledWith(SINGLE, false);
    expect(screen.getByTestId('backend-badge').textContent).toBe('Browser');
    // Escape closes the popover.
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('engine-picker')).toBeNull();
  });

  it('engine picker shows the guard hint and a probe error', () => {
    useAnalysisStore.setState({
      serverProbe: { status: 'error', error: 'Server unreachable', lastProbe: 1 },
    });
    render(<AnalysisPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Engines/ }));
    act(() =>
      useAnalysisStore.setState({ engineHint: 'At most 2 server engines can run at once' }),
    );
    expect(screen.getByTestId('engine-hint').textContent).toMatch(/At most 2/);
    expect(screen.getByText('Server unavailable: Server unreachable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Check the server again' }));
    expect(probeServer).toHaveBeenLastCalledWith({ force: true });
  });

  it('single engine: no tabs and no compare strip', () => {
    render(<AnalysisPanel />);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByTestId('compare-strip')).toBeNull();
  });

  it('two engines: compare strip with each top line, tabs switch the lines', () => {
    useAnalysisStore.setState({
      enabledEngines: [SINGLE, REMOTE],
      instances: { [SINGLE]: browserInstance, [REMOTE]: serverInstance },
    });
    render(<AnalysisPanel />);
    const chips = screen.getAllByTestId('compare-chip');
    expect(chips.map((c) => c.getAttribute('data-engine'))).toEqual([SINGLE, REMOTE]);
    expect(chips[0]!.textContent).toMatch(/^SF\d+ browser\+0\.35d18e4$/);
    expect(chips[1]!.textContent).toBe('SF19 server+0.28d30d4');
    expect(screen.getAllByTestId('compare-eval').map((e) => e.textContent)).toEqual([
      '+0.35',
      '+0.28',
    ]);

    const tabs = within(screen.getByRole('tablist', { name: 'Engine results' })).getAllByRole(
      'tab',
    );
    expect(tabs).toHaveLength(2);
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]!.textContent).toBe('SF19server');
    expect(tabs[1]!.querySelector('[data-status]')!.getAttribute('data-status')).toBe('analysing');
    expect(screen.getAllByTestId('analysis-line')).toHaveLength(2);
    expect(screen.getByTestId('backend-badge').textContent).toBe('Browser');

    fireEvent.click(tabs[1]!);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('engine-tabpanel').getAttribute('data-engine')).toBe(REMOTE);
    const rows = screen.getAllByTestId('analysis-line');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByTestId('analysis-pv').textContent).toBe('1. d4 Nf6');
    expect(screen.getByTestId('backend-badge').textContent).toBe('Server');
    expect(screen.getByTestId('analysis-meta').textContent).toMatch(/depth 30 · 9\.0 MN\/s/);

    // Hover arrows come from the selected tab's lines.
    fireEvent.mouseEnter(rows[0]!);
    expect(usePreviewStore.getState().hover).toEqual(['d2d4', 'g8f6']);

    // Keyboard navigation and the compare chips select tabs too.
    fireEvent.keyDown(tabs[1]!, { key: 'ArrowRight' });
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(chips[1]!);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('an engine error shows in its tab and chip', () => {
    useAnalysisStore.setState({
      enabledEngines: [SINGLE, REMOTE],
      instances: {
        [SINGLE]: browserInstance,
        [REMOTE]: { key: REMOTE, status: 'error', lines: [], backendError: 'Server unreachable' },
      },
    });
    render(<AnalysisPanel />);
    const chips = screen.getAllByTestId('compare-chip');
    expect(chips[1]!.textContent).toContain('Server unreachable');
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    expect(screen.getByText('Server unreachable', { selector: 'p' })).toBeTruthy();
  });

  it('applies the server limits to the selects in server mode', () => {
    useAnalysisStore.setState({ settings: { depth: 0, multipv: 5, threads: 16 } });
    single({
      ...serverInstance,
      remoteLimits: {
        maxDepth: 22,
        maxMultipv: 3,
        maxThreads: 4,
        maxHash: 256,
        maxMovetimeMs: 1000,
        maxSessionsPerConnection: 1,
      },
    });
    render(<AnalysisPanel />);
    expect(screen.getByTestId('backend-badge').textContent).toBe('Server');
    const opts = (label: string) =>
      Array.from(screen.getByLabelText(label).querySelectorAll('option')).map((o) => o.value);
    expect(opts('Depth')).toEqual(['10', '14', '18', '22', '0']);
    expect(opts('Lines')).toEqual(['1', '2', '3']);
    expect(opts('Threads')).toEqual(['1', '2', '3', '4']);
    expect((screen.getByLabelText('Lines') as HTMLSelectElement).value).toBe('3');
    expect((screen.getByLabelText('Threads') as HTMLSelectElement).value).toBe('4');
  });

  it('keeps a non-preset depth within the server limit and shows the clamped depth beyond it', () => {
    const limits = {
      maxDepth: 22,
      maxMultipv: 3,
      maxThreads: 4,
      maxHash: 256,
      maxMovetimeMs: 1000,
      maxSessionsPerConnection: 1,
    };
    single({ ...serverInstance, remoteLimits: limits });
    useAnalysisStore.setState({ settings: { depth: 16, multipv: 1 } });
    const { unmount } = render(<AnalysisPanel />);
    expect((screen.getByLabelText('Depth') as HTMLSelectElement).value).toBe('16');
    unmount();
    useAnalysisStore.setState({ settings: { depth: 40, multipv: 1 } });
    render(<AnalysisPanel />);
    expect((screen.getByLabelText('Depth') as HTMLSelectElement).value).toBe('22');
  });
});
