// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPuzzleStore, usePuzzleStore } from '../../puzzles/puzzleStore';
import { Filters } from './Filters';

vi.mock('../../puzzles/filterOptions', () => ({
  loadFilterOptions: () =>
    Promise.resolve({
      themes: [{ tag: 'fork', count: 3 }],
      endgames: [
        { tag: 'endgame', count: 1234 },
        { tag: 'rookEndgame', count: 56 },
      ],
      families: [],
      fromIndex: true,
    }),
}));
vi.mock('./OfflineKeep', () => ({ OfflineKeep: () => null }));

describe('Filters endgame select', () => {
  beforeEach(() => {
    resetPuzzleStore({
      nextPuzzle: () => Promise.resolve(null),
      load: () => ({
        rating: { rating: 1500, rd: 350, vol: 0.09, n: 0 },
        difficulty: 'normal',
        filter: {},
      }),
      settle: () => ({ rating: 1500, rd: 350, vol: 0.09, n: 1 }),
      saveDifficulty: () => undefined,
      saveFilter: () => undefined,
      markSeen: () => undefined,
    });
  });
  afterEach(cleanup);

  it('shows counts, sets the endgame filter and the chip text, and clears it', async () => {
    render(<Filters />);
    const select = (await screen.findByLabelText('Endgames')) as HTMLSelectElement;
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Endgames only (1,234)' })).toBeTruthy(),
    );
    expect(screen.getByRole('option', { name: 'Rook endgames (56)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Pawn endgames' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'rookEndgame' } });
    expect(usePuzzleStore.getState().filter).toEqual({ endgame: 'rookEndgame' });
    expect(screen.getByTestId('puzzle-filter-active').textContent).toContain('Rook endgames');
    fireEvent.change(select, { target: { value: '' } });
    expect(usePuzzleStore.getState().filter).toEqual({});
  });
});
