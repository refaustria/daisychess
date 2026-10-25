// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { timedMoves } from '../../clock/testMoves';
import { START_FEN } from '../../store/gameStore';
import { TimeGraph } from './TimeGraph';

afterEach(cleanup);

const game = {
  startFen: START_FEN,
  moves: timedMoves(
    ['e4', 'e5', 'Nf3', 'Nc6'],
    [{ remainingMs: 60_000 }, { remainingMs: 60_000 }, { remainingMs: 40_000 }, undefined],
  ),
  timeControl: { initialMs: 60_000, incrementMs: 0 },
};

describe('TimeGraph', () => {
  it('draws one line per side, the threshold and the cursor, with a summary label', () => {
    const { container } = render(<TimeGraph game={game} ply={2} onSeek={() => {}} />);
    expect(container.querySelector('[data-series="white"]')?.getAttribute('points')).toBeTruthy();
    expect(container.querySelector('[data-series="black"]')?.getAttribute('points')).toBeTruthy();
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(
      'Clock graph over 4 moves: White ends with 0:40, Black with 1:00 remaining.',
    );
  });

  it('click seeks to the nearest ply', () => {
    const onSeek = vi.fn();
    render(<TimeGraph game={game} ply={0} onSeek={onSeek} />);
    const svg = screen.getByTestId('time-graph');
    svg.getBoundingClientRect = () =>
      ({ left: 0, width: 400, top: 0, height: 50, right: 400, bottom: 50 }) as DOMRect;
    fireEvent.click(svg, { clientX: 300 });
    expect(onSeek).toHaveBeenLastCalledWith(3);
  });

  it('renders nothing without clock data', () => {
    const { container } = render(
      <TimeGraph game={{ ...game, moves: timedMoves(['e4'], []), timeControl: undefined }} ply={0} onSeek={() => {}} />,
    );
    expect(container.innerHTML).toBe('');
  });
});
