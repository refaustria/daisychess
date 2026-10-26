// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { create } from 'zustand';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gen = vi.hoisted(() => ({
  find: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock('../../puzzles/mistakeGenerator', () => ({
  useMistakeGenStore: create<{
    status: string;
    progress?: unknown;
    notice?: string;
    result?: unknown;
  }>()(() => ({ status: 'idle' })),
  findMistakePuzzles: gen.find,
  cancelMistakePuzzles: gen.cancel,
}));

import { resetAnalysisPause } from '../../engine/analysisPause';
import { usePlayStore } from '../../play/playStore';
import {
  clearGameLedger,
  configureGameLedger,
  getLedgerGame,
  recordReviewedGame,
} from '../../puzzles/gameLedger';
import {
  addMistakes,
  clearMistakes,
  configureMistakeStore,
  getMistake,
  listMistakes,
  newSchedule,
  type MistakeRecord,
} from '../../puzzles/mistakeStore';
import { resetMistakeSession, useMistakeSession } from '../../puzzles/mistakeSession';
import { useUiStore } from '../../store/uiStore';
import { resetPuzzleStore, usePuzzleStore } from '../../puzzles/puzzleStore';
import { useAnalysisStore } from '../../store/analysisStore';
import { useGameStore } from '../../store/gameStore';
import { useMistakeGenStore } from '../../puzzles/mistakeGenerator';
import { MistakesPanel, mistakeMoves } from './MistakesPanel';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
// White to move, mate in one with Ra8#.
const FEN = '6k1/5ppp/8/8/8/8/8/RR4K1 w - - 0 1';

function rec(id: string, createdAt: number, due: number): MistakeRecord {
  return {
    id,
    puzzle: {
      id,
      fen: FEN,
      moves: ['a1a8'],
      themes: [],
      openings: [],
      source: 'mistake',
      noIntro: true,
    },
    gameKey: 'g1',
    ply: 7,
    playedUci: 'b1b2',
    classification: 'blunder',
    evalBeforeWhite: { mate: 1 },
    evalAfterWhite: { cp: 20 },
    createdAt,
    schedule: { ...newSchedule(createdAt), due },
  };
}

const originalSetEnabled = useAnalysisStore.getState().setEnabled;

beforeEach(async () => {
  configureMistakeStore(null);
  configureGameLedger(null);
  await clearMistakes();
  await clearGameLedger();
  resetAnalysisPause();
  useAnalysisStore.setState({
    enabled: false,
    setEnabled: (enabled: boolean) => useAnalysisStore.setState({ enabled }),
  });
  useGameStore.getState().reset();
  usePlayStore.setState({ mode: 'idle' });
  resetPuzzleStore();
  resetMistakeSession();
  gen.find.mockReset();
  useMistakeGenStore.setState({ status: 'idle', progress: undefined, result: undefined });
});

afterEach(() => {
  cleanup();
  resetPuzzleStore();
  configureMistakeStore(undefined);
  configureGameLedger(undefined);
  useAnalysisStore.setState({ setEnabled: originalSetEnabled });
});

describe('MistakesPanel', () => {
  it('explains how it works when empty', async () => {
    render(<MistakesPanel />);
    await waitFor(() => expect(screen.getByTestId('mistakes-empty')).toBeTruthy());
    expect(screen.getByTestId('mistakes-empty').textContent).toContain('My names');
    expect(screen.getByTestId('mistakes-stats').textContent).toContain('0 due');
    expect((screen.getByRole('button', { name: 'Train due' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('lists puzzles newest first with game info and deletes one', async () => {
    await recordReviewedGame({
      gameKey: 'g1',
      startFen: START,
      moves: [],
      headers: { White: 'Alice', Black: 'Bob', Date: '2026.10.01' },
      source: 'pgn',
      userSide: 'white',
      reviewedAt: 1,
    });
    await addMistakes([rec('m:old', 1000, Date.now() + 1e9), rec('m:new', 2000, Date.now() + 1e9)]);
    render(<MistakesPanel />);
    const list = await screen.findByTestId('mistakes-list');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain('Alice vs Bob');
    expect(items[0]!.textContent).toContain('2026.10.01');
    expect(items[0]!.textContent).toContain('Move 4.');
    expect(items[0]!.textContent).toContain('you played Rb2, best Ra8#');
    fireEvent.click(within(items[0]!).getByRole('button', { name: /^Delete puzzle/ }));
    await waitFor(() =>
      expect(within(screen.getByTestId('mistakes-list')).getAllByRole('listitem')).toHaveLength(1),
    );
    expect((await listMistakes()).map((m) => m.id)).toEqual(['m:old']);
  });

  it('asks the side of games with an unknown side once', async () => {
    await recordReviewedGame({
      gameKey: 'g2',
      startFen: START,
      moves: [],
      headers: { White: 'Carl', Black: 'Dora' },
      source: 'pgn',
      reviewedAt: 1,
    });
    render(<MistakesPanel />);
    const prompt = await screen.findByTestId('mistakes-side-prompt');
    expect(prompt.textContent).toContain('Which side did you play in Carl vs Dora?');
    fireEvent.click(within(prompt).getByRole('button', { name: /^Skip/ }));
    await waitFor(() => expect(screen.queryByTestId('mistakes-side-prompt')).toBeNull());
    expect((await getLedgerGame('g2'))?.sideSkipped).toBe(true);
  });

  it('trains due puzzles one after another and records the results', async () => {
    await addMistakes([rec('m:a', 1000, 0), rec('m:b', 2000, 0)]);
    render(<MistakesPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-stats').textContent).toContain('2 due'),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Train due' }));
    });
    expect(screen.getByTestId('mistakes-session').textContent).toContain('Puzzle 1 of 2');
    expect(usePuzzleStore.getState().rated).toBe(false);
    act(() => {
      useGameStore.getState().makeMove('a1', 'a8');
    });
    await waitFor(async () => {
      expect((await getMistake('m:a'))?.schedule.due).toBeGreaterThan(Date.now());
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next due' }));
    });
    expect(screen.getByTestId('mistakes-session').textContent).toContain('Puzzle 2 of 2');
  });

  it('starts and cancels the search with progress, notice and a result summary', async () => {
    await addMistakes([rec('m:a', 1000, Date.now() + 1e9)]);
    render(<MistakesPanel />);
    const find = await screen.findByRole('button', { name: 'Find puzzles in my games' });
    await waitFor(() => expect((find as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(find);
    expect(gen.find).toHaveBeenCalledTimes(1);
    act(() => {
      useMistakeGenStore.setState({
        status: 'running',
        notice: 'Waiting for the running review to finish…',
        progress: {
          gamesTotal: 3,
          gamesDone: 1,
          candidatesTotal: 4,
          candidatesDone: 2,
          searches: 5,
          found: 1,
          skipped: 1,
        },
      });
    });
    const progress = screen.getByTestId('mistakes-progress');
    expect(progress.textContent).toContain('Games 1/3, candidates 2/4, found 1');
    expect(progress.textContent).toContain('Waiting for the running review');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel search' }));
    expect(gen.cancel).toHaveBeenCalled();
    act(() => {
      useMistakeGenStore.setState({
        status: 'done',
        result: {
          status: 'done',
          added: [rec('m:x', 1, 0)],
          skipped: {},
          gamesScanned: 2,
          gamesWithoutReview: ['k1'],
          searches: 5,
        },
      });
    });
    const result = screen.getByTestId('mistakes-result');
    expect(result.textContent).toContain('1 new puzzle from 2 games');
    expect(result.textContent).toContain('1 of your games has no review yet');
  });

  it('opens the ledger game at the mistake ply and shows the Moves tab', async () => {
    await recordReviewedGame({
      gameKey: 'g1',
      startFen: START,
      moves: ['e4', 'e5', 'Nf3', 'Nc6'],
      headers: { White: 'Alice', Black: 'Bob' },
      source: 'pgn',
      userSide: 'white',
      reviewedAt: 1,
    });
    await addMistakes([{ ...rec('m:g', 1000, Date.now() + 1e9), ply: 3 }]);
    useUiStore.getState().setActiveTab('puzzles');
    render(<MistakesPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /^Open game/ }));
    const g = useGameStore.getState();
    expect(g.moves).toHaveLength(4);
    expect(g.ply).toBe(3);
    expect(g.headers.White).toBe('Alice');
    expect(useUiStore.getState().activeTab).toBe('moves');
  });

  it('keeps the training queue when the panel is left and resumes it', async () => {
    await addMistakes([rec('m:a', 1000, 0), rec('m:b', 2000, 0)]);
    const first = render(<MistakesPanel />);
    await waitFor(() =>
      expect(screen.getByTestId('mistakes-stats').textContent).toContain('2 due'),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Train due' }));
    });
    first.unmount();
    expect(useMistakeSession.getState().active).toBe(true);
    render(<MistakesPanel />);
    expect(screen.getByTestId('mistakes-session').textContent).toContain('Puzzle 1 of 2');
  });

  it('mistakeMoves resolves SAN for puzzles with an opponent intro', () => {
    const r = rec('m:i', 1, 0);
    r.puzzle = {
      ...r.puzzle,
      noIntro: false,
      fen: '6k1/5ppp/8/8/8/8/8/RR4K1 b - - 0 1',
      moves: ['g8h8', 'a1a8'],
    };
    r.playedUci = 'b1b2';
    expect(mistakeMoves(r)).toEqual({ played: 'Rb2', best: 'Ra8#' });
  });
});
