// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Chess } from 'chess.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getBook, loadOpenings } from '../../openings';
import { FakePlayEngine } from '../../play/fakePlayEngine';
import { configurePlay, resetPlay, usePlayStore } from '../../play/playStore';
import { useUiStore } from '../../store/uiStore';
import { FakeReviewEngine } from '../../review/fakeEngine';
import { useGameStore } from '../../store/gameStore';
import { configureDrill, resetDrill, useDrillStore } from '../../trainer/drillStore';
import { feedbackText, lineText, OpeningsPanel } from './OpeningsPanel';

let engine: FakeReviewEngine;
const fenAfter = (san: string) => {
  const c = new Chess();
  for (const m of san.split(' ').filter(Boolean)) c.move(m);
  return c.fen();
};
const game = () => useGameStore.getState();
function play(san: string) {
  const m = new Chess(game().moves.at(-1)?.fen ?? game().startFen).move(san);
  act(() => {
    game().makeMove(m.from, m.to, m.promotion);
  });
}

beforeAll(loadOpenings);

beforeEach(async () => {
  game().reset();
  await resetPlay();
  engine = new FakeReviewEngine();
  const data: Record<string, string> = {};
  await configureDrill({
    createEngine: async () => ({
      engine,
      runsOn: { kind: 'browser' },
      dispose: () => engine.dispose(),
    }),
    appDelayMs: () => 0,
    random: () => 0,
    now: () => Date.now(),
    storage: { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) },
    book: getBook,
    search: { movetime: 10 },
  });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await resetDrill();
    await resetPlay();
  });
});

const search = () => screen.getByRole('searchbox', { name: 'Search openings' });
const pickItalian = () => {
  fireEvent.change(search(), { target: { value: 'Italian' } });
  const list = screen.getByRole('list', { name: 'Openings' });
  const first = within(list).getAllByRole('button')[0]!;
  expect(first.textContent).toMatch(/^C50Italian Game\d+ sub-variations/);
  fireEvent.click(first);
};

describe('OpeningsPanel: picker', () => {
  it('lists opening families without a query and searches by name and ECO', () => {
    render(<OpeningsPanel />);
    expect(screen.getByText(/Showing opening families/)).toBeTruthy();
    const families = within(screen.getByRole('list', { name: 'Openings' })).getAllByRole('button');
    expect(families.length).toBeGreaterThan(10);
    expect(families.every((b) => !b.textContent!.includes(':'))).toBe(true);

    fireEvent.change(search(), { target: { value: 'Italian' } });
    const hits = within(screen.getByRole('list', { name: 'Openings' })).getAllByRole('button');
    expect(hits[0]!.textContent).toContain('Italian Game');
    fireEvent.change(search(), { target: { value: 'B90' } });
    expect(
      within(screen.getByRole('list', { name: 'Openings' })).getAllByRole('button')[0]!.textContent,
    ).toMatch(/^B90Sicilian Defense: Najdorf/);
    fireEvent.change(search(), { target: { value: 'qqqzzz' } });
    expect(screen.getByText('No opening found.')).toBeTruthy();
  });

  it('shows the due count; the Due filter lists due variations and Train due starts one', () => {
    const italian = getBook()!.search('Italian')[0]!;
    useDrillStore.setState({
      schedule: {
        [`${italian.eco} ${italian.name}`]: { due: 0, interval: 1, lapses: 1, successes: 0 },
      },
    });
    render(<OpeningsPanel />);
    expect(screen.getByTestId('due-count').textContent).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: /^Due/ }));
    const items = within(screen.getByRole('list', { name: 'Openings' })).getAllByRole('button');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('due');
    fireEvent.click(screen.getByRole('button', { name: 'Train due' }));
    expect(useDrillStore.getState()).toMatchObject({ status: 'running', opening: italian });
    expect(screen.getByTestId('drill-feedback').textContent).toContain('You play White');
  });

  it('shows the last result per variation and the overall training line', () => {
    const [italian, ruy] = [
      getBook()!.search('Italian')[0]!,
      getBook()!.openings.find((o) => o.name === 'Ruy Lopez')!,
    ];
    const at = new Date(2026, 9, 25, 12).getTime();
    useDrillStore.setState({
      schedule: {
        [`${italian.eco} ${italian.name}`]: {
          due: 0,
          interval: 1,
          lapses: 1,
          successes: 0,
          lastAt: at,
          lastMistakes: 2,
        },
        [`${ruy.eco} ${ruy.name}`]: {
          due: Date.now() + 3 * 86_400_000,
          interval: 2.5,
          lapses: 0,
          successes: 2,
          lastAt: at,
          lastMistakes: 0,
        },
      },
    });
    render(<OpeningsPanel />);
    expect(screen.getByTestId('drill-stats').textContent).toBe('Trained: 2 variations · due: 1');
    fireEvent.change(search(), { target: { value: 'Italian' } });
    const first = within(screen.getByRole('list', { name: 'Openings' })).getAllByRole('button')[0]!;
    const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at);
    expect(within(first).getByTestId('last-result').textContent).toBe(`Last: ${date} · 2 mistakes`);
    fireEvent.change(search(), { target: { value: 'Ruy Lopez' } });
    const ruyItem = within(screen.getByRole('list', { name: 'Openings' })).getAllByRole(
      'button',
    )[0]!;
    expect(ruyItem.textContent).toContain('in 3 days');
    expect(within(ruyItem).getByTestId('last-result').textContent).toContain('no mistakes');
  });

  it('Train due is disabled when nothing is due', () => {
    render(<OpeningsPanel />);
    expect(screen.getByTestId('due-count').textContent).toBe('0');
    expect((screen.getByRole('button', { name: 'Train due' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe('OpeningsPanel: browse', () => {
  it('walks through the line on the board and lists the branches', () => {
    render(<OpeningsPanel />);
    pickItalian();
    expect(screen.getByTestId('opening-title').textContent).toBe('C50 Italian Game');
    const line = screen.getByRole('list', { name: 'Line' });
    fireEvent.click(within(line).getByRole('button', { name: '2. Nf3' }));
    expect(game().moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(game().ply).toBe(3);
    expect(game().headers.Opening).toBe('Italian Game');
    expect(screen.getByText('After 2. Nf3')).toBeTruthy();
    const branches = within(screen.getByRole('region', { name: 'Branches' })).getAllByRole(
      'button',
    );
    expect(branches[0]!.textContent).toMatch(/^Nc6/);
    // The last move: the Italian's own sub-variations are the branches.
    fireEvent.click(within(line).getByRole('button', { name: '3. Bc4' }));
    expect(screen.getByText('After 3. Bc4')).toBeTruthy();
    const after = within(screen.getByRole('region', { name: 'Branches' }))
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(after.some((t) => t!.startsWith('Bc5'))).toBe(true);
    expect(after.some((t) => t!.startsWith('Nf6'))).toBe(true);
  });

  it('clicking a branch selects that variation', () => {
    render(<OpeningsPanel />);
    pickItalian();
    fireEvent.click(
      within(screen.getByRole('list', { name: 'Line' })).getByRole('button', { name: '3. Bc4' }),
    );
    const bc5 = within(screen.getByRole('region', { name: 'Branches' }))
      .getAllByRole('button')
      .find((b) => b.textContent!.startsWith('Bc5'))!;
    fireEvent.click(bc5);
    expect(screen.getByTestId('opening-title').textContent).toMatch(/Italian Game: Giuoco Piano$/);
    expect(game().moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
  });
});

describe('OpeningsPanel: drill', () => {
  it('start, book feedback, mistake with best line, try again', async () => {
    render(<OpeningsPanel />);
    pickItalian();
    fireEvent.click(screen.getByRole('radio', { name: 'Drill' }));
    fireEvent.click(screen.getByRole('radio', { name: 'White' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start drill' }));
    const feedback = () => screen.getByTestId('drill-feedback').textContent;
    expect(feedback()).toBe('You play White: Italian Game. Your move.');
    expect(game().orientation).toBe('white');

    play('e4');
    await waitFor(() => expect(feedback()).toMatch(/^Book reply e5/));
    engine.scripts.set(fenAfter('e4 e5'), {
      score: { cp: 30 },
      pv: ['g1f3', 'b8c6', 'f1c4', 'g8f6'],
      bestMove: 'g1f3',
    });
    engine.scripts.set(fenAfter('e4 e5 Ba6'), { score: { cp: -310 } });
    play('Ba6');
    await waitFor(() => expect(feedback()).toMatch(/^Mistake: Ba6 loses 3\.4 \(-3\.10\)\./));
    expect(feedback()).toContain('Best was Nf3 (+0.30): 2. Nf3 Nc6 3. Bc4 Nf6');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(feedback()).toBe('Try again: find a better move than Ba6.');
    play('Nf3');
    expect(feedback()).toMatch(/^Book: /);
    fireEvent.click(screen.getByRole('button', { name: 'Stop drill' }));
    expect(useDrillStore.getState().status).toBe('idle');
  });

  it('Start drill is disabled during an engine game', () => {
    usePlayStore.setState({ mode: 'playing' });
    render(<OpeningsPanel />);
    pickItalian();
    fireEvent.click(screen.getByRole('radio', { name: 'Drill' }));
    expect(
      (screen.getByRole('button', { name: 'Start drill' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/the drill uses the engine/)).toBeTruthy();
  });

  it('summary with Repeat, Next variation and Play on', async () => {
    const sicilian = getBook()!.openings.find((o) => o.name === 'Sicilian Defense')!;
    // A tiny subtree is enough for a full run: stop after the first book reply by ending it.
    render(<OpeningsPanel />);
    act(() => useDrillStore.getState().start(sicilian, 'white'));
    act(() =>
      useDrillStore.setState({
        status: 'done',
        phase: 'none',
        summary: {
          reason: 'end',
          userMoves: 3,
          firstTry: 2,
          mistakes: 1,
          reached: 'Sicilian Defense',
        },
      }),
    );
    const summary = screen.getByTestId('drill-summary');
    expect(summary.textContent).toContain('End of the book line — Sicilian Defense');
    expect(summary.textContent).toContain('Right first try: 2 of 3 moves · Mistakes: 1');
    for (const name of ['Repeat', 'Next variation', 'Play on vs engine']) {
      expect(within(summary).getByRole('button', { name })).toBeTruthy();
    }
  });

  it('Play on vs engine starts the engine game with the drill colour and opens Play', async () => {
    const playEngine = new FakePlayEngine();
    playEngine.manual = true;
    await configurePlay({ createEngine: () => playEngine, extraDelayMs: () => 0 });
    const sicilian = getBook()!.openings.find((o) => o.name === 'Sicilian Defense')!;
    useUiStore.setState({ activeTab: 'openings' });
    render(<OpeningsPanel />);
    act(() => useDrillStore.getState().start(sicilian, 'black'));
    await waitFor(() => expect(game().moves.map((m) => m.san)).toEqual(['e4']));
    act(() =>
      useDrillStore.setState({
        status: 'done',
        phase: 'none',
        summary: { reason: 'end', userMoves: 1, firstTry: 1, mistakes: 0 },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Play on vs engine' }));
    expect(usePlayStore.getState()).toMatchObject({
      mode: 'playing',
      playerColor: 'black',
      fromPly: 1,
    });
    expect(useUiStore.getState().activeTab).toBe('play');
  });
});

describe('helpers', () => {
  it('lineText numbers the moves', () => {
    expect(lineText(['e4', 'e5', 'Nf3'])).toBe('1. e4 e5 2. Nf3');
    expect(lineText(['e4', 'e5', 'Nf3'], 2)).toBe('1. e4 e5');
  });

  it('feedbackText covers the fine cases', () => {
    const s = { opening: getBook()!.openings[0]!, userColor: 'white' as const };
    expect(feedbackText({ kind: 'fine', san: 'd3', eval: '+0.20', retry: false }, s)).toBe(
      'Not book, but fine (+0.20). Out of book.',
    );
    expect(feedbackText({ kind: 'checking', san: 'a3' }, s)).toMatch(/checking with the engine/);
  });
});
