// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SyzygyTables } from '@daisychess/endgames';
import { resetAnalysisPause } from '../../engine/analysisPause';
import { LESSONS } from '../../endgames/data/lessons';
import {
  emptyProgress,
  ENDGAMES_KEY,
  recordAttempt,
  serializeProgress,
} from '../../endgames/endgamesProgress';
import { configureLessonStore, resetLessonStore, useLessonStore } from '../../endgames/lessonStore';
import {
  boardMove,
  coreTables,
  installKit,
  makeKit,
  settled,
  type Kit,
} from '../../endgames/lessonTestKit';
import { openEndgames, useEndgamesNav } from '../../endgames/navigate';
import { configureTablebase, resetTablebaseStore } from '../../endgames/tablebaseStore';
import { usePuzzleStore } from '../../puzzles/puzzleStore';
import { useAnalysisStore } from '../../store/analysisStore';
import { useGameStore } from '../../store/gameStore';
import { useUiStore } from '../../store/uiStore';
import { DAY_MS } from '../../trainer/schedule';
import { EndgamesPanel } from './EndgamesPanel';

let tables: SyzygyTables;
let kit: Kit;
const KQK = LESSONS[0]!;

beforeAll(() => {
  tables = coreTables();
});

beforeEach(() => {
  localStorage.clear();
  resetAnalysisPause();
  useAnalysisStore.setState({
    enabled: false,
    setEnabled: (enabled: boolean) => useAnalysisStore.setState({ enabled }),
  });
  kit = makeKit(tables);
  installKit(kit, 'online');
});

afterEach(() => {
  cleanup();
  resetLessonStore();
  configureLessonStore(null);
  configureTablebase(null);
  resetTablebaseStore();
  useEndgamesNav.setState({ group: null, seq: 0 });
});

describe('course list', () => {
  it('lists every lesson by group with done and due marks and "Train due"', () => {
    const now = Date.now();
    let p = recordAttempt(emptyProgress(), 'kq-vs-k', { success: true, mistakes: 0, now });
    p = recordAttempt(p, 'kr-vs-k', { success: false, mistakes: 0, now: now - DAY_MS });
    p = recordAttempt(p, 'lucena', { success: true, mistakes: 1, now: now - DAY_MS });
    localStorage.setItem(ENDGAMES_KEY, serializeProgress(p));
    resetLessonStore();
    render(<EndgamesPanel />);
    for (const g of ['basic_mates', 'king_pawn', 'queen_pawn', 'rook_pawn']) {
      expect(screen.getByTestId(`endgames-group-${g}`)).toBeTruthy();
    }
    expect(screen.getAllByRole('listitem')).toHaveLength(LESSONS.length);
    expect(screen.getByTestId('lesson-kq-vs-k').dataset.mark).toBe('done');
    expect(screen.getByTestId('lesson-kq-vs-k').textContent).toContain('✓ done');
    expect(screen.getByTestId('lesson-kr-vs-k').dataset.mark).toBe('due');
    expect(screen.getByTestId('lesson-lucena').textContent).toContain('✓ due');
    expect(screen.getByTestId('lesson-kbn-vs-k').dataset.mark).toBe('new');
    expect(screen.getByTestId('lesson-kbn-vs-k').textContent).toContain('advanced');
    expect(screen.getByTestId('endgames-due-count').textContent).toBe('2');
    expect(screen.getByTestId('endgames-stats').textContent).toBe(
      `2 of ${LESSONS.length} lessons done`,
    );
    // The accessible name carries the goal and the mark.
    expect(
      screen.getByRole('button', { name: 'King and queen against king White to win ✓ done' }),
    ).toBeTruthy();
  });

  it('"Train due" is disabled without due lessons and starts the earliest due one', async () => {
    render(<EndgamesPanel />);
    expect((screen.getByTestId('endgames-train-due') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const p = recordAttempt(emptyProgress(), 'kr-vs-k', { success: false, mistakes: 0, now: 1 });
    localStorage.setItem(ENDGAMES_KEY, serializeProgress(p));
    resetLessonStore();
    render(<EndgamesPanel />);
    fireEvent.click(screen.getByTestId('endgames-train-due'));
    await waitFor(() => expect(screen.getByTestId('lesson-title').textContent).toContain('rook'));
  });

  it('opening the tab on a group focuses its heading (tour "Train this endgame")', async () => {
    render(<EndgamesPanel />);
    act(() => openEndgames('rook_pawn'));
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Rook endings'));
    expect(useEndgamesNav.getState().group).toBeNull();
    expect(useUiStore.getState().activeTab).toBe('endgames');
  });

  it('a rook lesson offline without the pack shows the download card with the size', async () => {
    installKit(kit, 'local');
    render(<EndgamesPanel />);
    fireEvent.click(screen.getByTestId('lesson-lucena'));
    await waitFor(() => expect(screen.getByTestId('lesson-view')).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId('lesson-status').textContent).toMatch(
        /Needs the rook endgames download \(20\.9 MB\) to play offline\./,
      ),
    );
    const card = screen.getByTestId('rook-pack');
    expect(within(card).getByRole('button', { name: 'Download (20.9 MB)' })).toBeTruthy();
    expect(screen.getByTestId('lesson-start')).toBeTruthy();
  });
});

describe('lesson view', () => {
  async function open() {
    render(<EndgamesPanel />);
    fireEvent.click(screen.getByTestId(`lesson-${KQK.id}`));
    await waitFor(() => expect(screen.getByTestId('lesson-view')).toBeTruthy());
    await act(settled);
  }

  it('shows the text, goal and budget and a polite status line', async () => {
    await open();
    expect(screen.getByTestId('lesson-title').textContent).toBe(KQK.title);
    expect(screen.getByText(KQK.text)).toBeTruthy();
    expect(screen.getByTestId('lesson-budget').textContent).toBe(
      'Goal: checkmate within 14 moves · 14 left · tables on this device',
    );
    const status = screen.getByTestId('lesson-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toBe('Your move (White).');
  });

  it('Hint shows the next plan sentence and counts as a mistake', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Hint' }));
    await waitFor(() => expect(screen.getByTestId('lesson-hints')).toBeTruthy());
    const items = within(screen.getByTestId('lesson-hints')).getAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([KQK.hints[0]]);
    expect(useLessonStore.getState().game?.hints).toBe(1);
    expect(screen.getByTestId('lesson-status').textContent).toMatch(/^Hint: move the highlighted/);
    fireEvent.click(screen.getByRole('button', { name: 'Hint' }));
    await waitFor(() =>
      expect(within(screen.getByTestId('lesson-hints')).getAllByRole('listitem')).toHaveLength(2),
    );
  });

  it('the typed SAN input plays a move; an illegal one shows an alert', async () => {
    await open();
    const input = screen.getByLabelText('Move, e.g. Qd5');
    fireEvent.change(input, { target: { value: 'Ke2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('alert').textContent).toBe('Ke2 is not a legal move here.');
    fireEvent.change(input, { target: { value: 'Qb5+' } });
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await act(settled);
    expect(useGameStore.getState().moves[0]?.san).toBe('Qb5+');
    expect(useGameStore.getState().moves).toHaveLength(2);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('a thrown move shows the result with Take back, Restart and the summary buttons', async () => {
    await open();
    act(() => void boardMove('b1e4'));
    await act(settled);
    expect(screen.getByTestId('lesson-status').textContent).toMatch(
      /^Qe4\+\? throws away the win — the position is a draw now\. .+ keeps it\.$/,
    );
    expect(screen.getByTestId('lesson-summary')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take back' }));
    await act(settled);
    expect(useLessonStore.getState().status).toBe('running');
    expect(useGameStore.getState().moves).toHaveLength(0);
  });

  it('"Endgame puzzles" opens the Puzzles tab with the group theme', async () => {
    let filter: unknown;
    usePuzzleStore.setState({
      openWithFilter: async (f) => {
        filter = f;
      },
    });
    await open();
    act(() => void boardMove('b1e4'));
    await act(settled);
    fireEvent.click(screen.getByRole('button', { name: 'Endgame puzzles' }));
    expect(filter).toEqual({ endgame: 'endgame' });
  });

  it('Stop returns to the course list', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByTestId('endgames-course')).toBeTruthy();
    expect(useLessonStore.getState().status).toBe('idle');
  });
});
