// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scholarSummary } from '../../review/testFixtures';
import { EvalGraph, whiteSeries } from './EvalGraph';

afterEach(cleanup);

describe('EvalGraph', () => {
  it('converts to White POV', () => {
    const s = whiteSeries(scholarSummary());
    expect(s).toHaveLength(8);
    expect(s[6]).toBe(100); // Black's Nf6 allows mate in 1: White wins
    expect(s[7]).toBe(100);
  });

  it('renders a point per ply, markers, label and cursor', () => {
    const { container } = render(
      <EvalGraph summary={scholarSummary()} ply={4} onSeek={() => {}} />,
    );
    expect(container.querySelectorAll('[data-point]')).toHaveLength(8);
    expect(container.querySelectorAll('[data-marker]')).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/over 7 moves/);
    expect(screen.getByTestId('eval-cursor').getAttribute('x1')).toBe(String((4 / 7) * 300));
  });

  it('click seeks to the nearest ply', () => {
    const onSeek = vi.fn();
    render(<EvalGraph summary={scholarSummary()} ply={0} onSeek={onSeek} />);
    const svg = screen.getByTestId('eval-graph');
    svg.getBoundingClientRect = () =>
      ({
        left: 100,
        width: 700,
        top: 0,
        height: 80,
        right: 800,
        bottom: 80,
        x: 100,
        y: 0,
      }) as DOMRect;
    fireEvent.click(svg, { clientX: 450 }); // halfway -> ply 3.5 -> 4
    expect(onSeek).toHaveBeenCalledWith(4);
    fireEvent.click(svg, { clientX: 10 });
    expect(onSeek).toHaveBeenLastCalledWith(0);
  });
});
