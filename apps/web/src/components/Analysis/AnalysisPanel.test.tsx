// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnalysisStore } from '../../store/analysisStore';
import { usePreviewStore } from '../../store/previewStore';
import { AnalysisPanel, formatNps, scoreTone } from './AnalysisPanel';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const setSettings = vi.fn();

beforeEach(() => {
  setSettings.mockClear();
  usePreviewStore.setState({ fen: null, moves: [], hover: null });
  useAnalysisStore.setState({
    enabled: true,
    status: 'analysing',
    engineName: 'Stockfish 19 Lite WASM',
    capabilities: { threads: true, build: 'multi-thread', threadCount: 4 },
    settings: { depth: 22, multipv: 2, backend: 'wasm' },
    remoteLimits: undefined,
    fen: START,
    terminal: null,
    lines: [
      { multipv: 1, score: { cp: 35 }, depth: 18, pv: ['e2e4', 'e7e5', 'g1f3'], nps: 1_900_000 },
      { multipv: 2, score: { cp: -80 }, depth: 18, pv: ['d2d4', 'd7d5'] },
    ],
    setSettings,
  });
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
    useAnalysisStore.setState({
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

  it('segmented control switches the backend', () => {
    render(<AnalysisPanel />);
    const group = screen.getByRole('radiogroup');
    const browser = within(group).getByRole('radio', { name: 'Browser' });
    const server = within(group).getByRole('radio', { name: 'Server' });
    expect(browser.getAttribute('aria-checked')).toBe('true');
    expect(server.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(browser);
    expect(setSettings).not.toHaveBeenCalled();
    fireEvent.click(server);
    expect(setSettings).toHaveBeenLastCalledWith({ backend: 'remote' });
    expect(screen.getByTestId('backend-badge').textContent).toBe('Browser');
  });

  it('applies the server limits to the selects in server mode', () => {
    useAnalysisStore.setState({
      settings: { depth: 0, multipv: 5, threads: 16, backend: 'remote' },
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
});
