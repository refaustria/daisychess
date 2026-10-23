// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EvalBar, evalDisplay } from './EvalBar';

afterEach(cleanup);

const fill = () => screen.getByTestId('eval-white');
const label = () => screen.getByTestId('eval-label');

describe('evalDisplay', () => {
  it('maps scores to share and label', () => {
    expect(evalDisplay({ cp: 0 }, null)).toEqual({ share: 50, label: '0.00', aria: 'Evaluation 0.00' });
    const plus = evalDisplay({ cp: 170 }, null);
    expect(plus.label).toBe('+1.70');
    expect(plus.share).toBeGreaterThan(60);
    expect(evalDisplay({ cp: -170 }, null).share).toBeCloseTo(100 - plus.share, 5);
    expect(evalDisplay({ mate: 4 }, null)).toMatchObject({ share: 98, label: 'M4' });
    expect(evalDisplay({ mate: -3 }, null)).toMatchObject({ share: 2, label: '-M3' });
    expect(evalDisplay(null, null)).toEqual({ share: 50, label: null, aria: 'Evaluation unavailable' });
  });

  it('shows results for terminal positions', () => {
    expect(evalDisplay(null, 'checkmate', '6k1/8/8/8/8/8/8/R5K1 b - - 0 1')).toMatchObject({ share: 100, label: '1-0' });
    expect(evalDisplay(null, 'checkmate', '6k1/8/8/8/8/8/8/r5K1 w - - 0 1')).toMatchObject({ share: 0, label: '0-1' });
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
