// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearGameLedger,
  configureGameLedger,
  getLedgerGame,
  recordReviewedGame,
} from '../../puzzles/gameLedger';
import { MY_NAMES_KEY } from '../../puzzles/userSide';
import { PuzzleNamesField } from './PuzzleNamesField';
import { SettingsPanel } from './SettingsPanel';

beforeEach(async () => {
  localStorage.clear();
  configureGameLedger(null);
  await clearGameLedger();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  configureGameLedger(undefined);
});

describe('PuzzleNamesField', () => {
  it('saves the cleaned names and re-matches ledger games without a side', async () => {
    await recordReviewedGame({
      gameKey: 'k',
      startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      moves: ['e4', 'e5'],
      headers: { White: 'Opp', Black: 'Club_Me' },
      source: 'pgn',
      reviewedAt: 1,
    });
    render(<PuzzleNamesField />);
    const input = screen.getByLabelText('My names');
    const save = screen.getByRole('button', { name: 'Save names' });
    expect(save).toHaveProperty('disabled', true);
    fireEvent.change(input, { target: { value: ' club_me , club_me; Other ' } });
    fireEvent.click(save);
    expect(JSON.parse(localStorage.getItem(MY_NAMES_KEY) ?? 'null')).toEqual(['club_me', 'Other']);
    expect((input as HTMLInputElement).value).toBe('club_me, Other');
    await waitFor(() => screen.getByText('Saved. Your side is now known in 1 more game.'));
    expect((await getLedgerGame('k'))?.userSide).toBe('black');
    expect(screen.getByRole('button', { name: 'Save names' })).toHaveProperty('disabled', true);
  });

  it('shows the stored names and removes them when cleared', () => {
    localStorage.setItem(MY_NAMES_KEY, JSON.stringify(['Me']));
    render(<PuzzleNamesField />);
    const input = screen.getByLabelText('My names') as HTMLInputElement;
    expect(input.value).toBe('Me');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save names' }));
    expect(localStorage.getItem(MY_NAMES_KEY)).toBeNull();
    screen.getByText('Names removed.');
  });

  it('is part of the Settings panel under "Puzzles"', () => {
    render(<SettingsPanel />);
    expect(screen.getByRole('form', { name: 'Puzzles' })).toBeTruthy();
    expect(screen.getByLabelText('My names')).toBeTruthy();
  });
});
