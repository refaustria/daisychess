// @vitest-environment jsdom
import type { TbPosition } from '@daisychess/endgames';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { resetTablebaseStore, useTablebaseStore } from '../../endgames/tablebaseStore';
import { useAnalysisStore } from '../../store/analysisStore';
import { ConnectedEvalBar, EvalBar, evalDisplay } from './EvalBar';

afterEach(cleanup);

const fill = () => screen.getByTestId('eval-white');
const label = () => screen.getByTestId('eval-label');

describe('evalDisplay', () => {
  it('maps scores to share and label', () => {
    expect(evalDisplay({ cp: 0 }, null)).toEqual({
      share: 50,
      label: '0.00',
      aria: 'Evaluation 0.00',
    });
    const plus = evalDisplay({ cp: 170 }, null);
    expect(plus.label).toBe('+1.70');
    expect(plus.share).toBeGreaterThan(60);
    expect(evalDisplay({ cp: -170 }, null).share).toBeCloseTo(100 - plus.share, 5);
    expect(evalDisplay({ mate: 4 }, null)).toMatchObject({ share: 98, label: 'M4' });
    expect(evalDisplay({ mate: -3 }, null)).toMatchObject({ share: 2, label: '-M3' });
    expect(evalDisplay(null, null)).toEqual({
      share: 50,
      label: null,
      aria: 'Evaluation unavailable',
    });
  });

  it('shows results for terminal positions', () => {
    expect(evalDisplay(null, 'checkmate', '6k1/8/8/8/8/8/8/R5K1 b - - 0 1')).toMatchObject({
      share: 100,
      label: '1-0',
    });
    expect(evalDisplay(null, 'checkmate', '6k1/8/8/8/8/8/8/r5K1 w - - 0 1')).toMatchObject({
      share: 0,
      label: '0-1',
    });
    expect(evalDisplay(null, 'stalemate')).toMatchObject({ share: 50, label: '½-½' });
  });
});

describe('EvalBar', () => {
  it('is neutral without a score', () => {
    render(<EvalBar orientation="white" />);
    const bar = screen.getByTestId('eval-bar');
    expect(bar.getAttribute('aria-label')).toBe('Evaluation unavailable');
    expect(fill().style.height).toBe('50%');
    expect(screen.queryByTestId('eval-label')).toBeNull();
  });

  it('grows White from the bottom and labels the stronger side (white orientation)', () => {
    render(<EvalBar orientation="white" score={{ cp: 30 }} fen="x" />);
    const bar = screen.getByTestId('eval-bar');
    expect(bar.getAttribute('aria-label')).toBe('Evaluation +0.30');
    expect(bar.dataset.fen).toBe('x');
    expect(fill().style.bottom).toBe('0px');
    expect(fill().style.top).toBe('');
    expect(Number.parseFloat(fill().style.height)).toBeGreaterThan(50);
    expect(label().textContent).toBe('+0.30');
    expect(label().className).toMatch(/bottom/);
  });

  it('flips with the board: White from the top for black orientation', () => {
    render(<EvalBar orientation="black" score={{ cp: 30 }} />);
    expect(fill().style.top).toBe('0px');
    expect(fill().style.bottom).toBe('');
    expect(label().className).toMatch(/top/);
  });

  it('puts a Black advantage label at Black’s end', () => {
    const { rerender } = render(<EvalBar orientation="white" score={{ mate: -2 }} />);
    expect(label().textContent).toBe('-M2');
    expect(label().className).toMatch(/top/);
    expect(fill().style.height).toBe('2%');
    rerender(<EvalBar orientation="black" score={{ mate: -2 }} />);
    expect(label().className).toMatch(/bottom/);
  });
});

describe('evalDisplay with a tablebase result (ADR-025 §4)', () => {
  it('exact share, M<n> or TB, the caption and the aria text', () => {
    expect(
      evalDisplay({ cp: 120 }, null, 'x', { result: 'white', mateIn: 14, exact50: true }),
    ).toEqual({
      share: 100,
      label: 'M14',
      aria: 'Tablebase: White wins, mate in 14',
      caption: 'tablebase',
    });
    expect(
      evalDisplay(null, null, 'x', { result: 'black', mateIn: 3, exact50: true }),
    ).toMatchObject({
      share: 0,
      label: '-M3',
      aria: 'Tablebase: Black wins, mate in 3',
    });
    expect(
      evalDisplay({ cp: 300 }, null, 'x', { result: 'white', dtz: 9, exact50: true }),
    ).toMatchObject({
      share: 100,
      label: 'TB',
      aria: 'Tablebase: White wins',
    });
    expect(evalDisplay({ cp: 300 }, null, 'x', { result: 'draw', exact50: true })).toEqual({
      share: 50,
      label: 'TB',
      aria: 'Tablebase: draw',
      caption: 'tablebase',
    });
    expect(evalDisplay(null, null, 'x', { result: 'draw', exact50: false })).toMatchObject({
      aria: 'Tablebase: draw (50-move rule)',
    });
    // A finished game still shows its result; null keeps the engine score.
    expect(evalDisplay(null, 'stalemate', 'x', { result: 'white', exact50: true })).toMatchObject({
      label: '½-½',
    });
    expect(evalDisplay({ cp: 30 }, null, 'x', null)).toMatchObject({ label: '+0.30' });
  });

  it('renders the caption and marks the bar', () => {
    render(
      <EvalBar
        orientation="white"
        score={{ cp: 50 }}
        tablebase={{ result: 'draw', exact50: true }}
        stale
      />,
    );
    const bar = screen.getByTestId('eval-bar');
    expect(bar.getAttribute('aria-label')).toBe('Tablebase: draw');
    expect(bar.dataset.tablebase).toBe('true');
    expect(screen.getByTestId('eval-caption').textContent).toBe('tablebase');
    expect(label().textContent).toBe('TBtablebase');
    // An exact result is never shown as stale.
    expect(label().className).not.toMatch(/stale/);
  });
});

describe('ConnectedEvalBar with the tablebase store', () => {
  const KQK = '8/8/8/8/8/2k5/8/KQ6 w - - 0 1';
  const POS: TbPosition = { fen: KQK, category: 'win', dtm: 17, moves: [] };

  afterEach(() => {
    resetTablebaseStore();
    useAnalysisStore.setState({ enabled: false });
  });

  it('the exact value of the analysis FEN wins over the engine score', () => {
    useAnalysisStore.setState({ enabled: true, fen: KQK, terminal: null });
    useTablebaseStore.setState({
      current: { fen: KQK, status: 'done', answer: { pos: POS, source: 'local' } },
    });
    render(<ConnectedEvalBar />);
    expect(screen.getByTestId('eval-bar').getAttribute('aria-label')).toBe(
      'Tablebase: White wins, mate in 9',
    );
    expect(label().textContent).toBe('M9tablebase');
    // An answer for another FEN is not used.
    act(() =>
      useTablebaseStore.setState({
        current: {
          fen: '8/8/8/8/8/2k5/8/K1Q5 w - - 0 1',
          status: 'done',
          answer: { pos: POS, source: 'local' },
        },
      }),
    );
    expect(screen.getByTestId('eval-bar').dataset.tablebase).toBeUndefined();
  });

  it('nothing from the tablebase while the analysis is off', () => {
    useAnalysisStore.setState({ enabled: false, fen: KQK, terminal: null });
    useTablebaseStore.setState({
      current: { fen: KQK, status: 'done', answer: { pos: POS, source: 'local' } },
    });
    render(<ConnectedEvalBar />);
    expect(screen.getByTestId('eval-bar').getAttribute('aria-label')).toBe(
      'Evaluation unavailable',
    );
  });
});
