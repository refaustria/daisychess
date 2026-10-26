import type { Difficulty, Puzzle, PuzzleFilter } from '@daisychess/puzzles';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAnalysisPause } from '../engine/analysisPause';
import { useLiveStore } from '../live/liveStore';
import { Book, type OpeningRow } from '../openings/book';
import { usePlayStore } from '../play/playStore';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useUiStore } from '../store/uiStore';
import { configureDrill, resetDrill, useDrillStore } from '../trainer/drillStore';
import {
  INTRO_DELAY_MS,
  NO_MORE_TEXT,
  puzzleMarks,
  puzzleMovableColor,
  REPLY_DELAY_MS,
  resetPuzzleStore,
  SOLUTION_STEP_MS,
  usePuzzleStore,
  WRONG_SHOW_MS,
  type PuzzlePort,
  type PuzzleRating,
} from './puzzleStore';

/** 6 plies: intro f2g3, then the user (White) plays e6e7, b3c1, h6c1. */
const LONG: Puzzle = {
  id: '00008',
  fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
  moves: ['f2g3', 'e6e7', 'b2b1', 'b3c1', 'b1c1', 'h6c1'],
  rating: 1811,
  rd: 76,
  themes: ['crushing'],
  openings: [],
  game: 'abcdefgh/black#48',
  source: 'lichess',
};
/** Back rank: after the intro, Ra8# (solution) and Rb8# both mate. */
const MATE: Puzzle = {
  id: 'mate2',
  fen: '6k1/5ppp/8/4n3/8/8/8/RR4K1 b - - 0 1',
  moves: ['e5c4', 'a1a8'],
  rating: 1500,
  rd: 80,
  themes: ['mateIn1'],
  openings: [],
  source: 'lichess',
};

interface FakePort extends PuzzlePort {
  queue: (Puzzle | null)[];
  seen: string[];
  settled: { id: string; solved: boolean }[];
  rating: PuzzleRating;
  requests: { filter: PuzzleFilter; rating: number; difficulty: Difficulty }[];
}

function fakePort(): FakePort {
  const port: FakePort = {
    queue: [],
    seen: [],
    settled: [],
    requests: [],
    rating: { rating: 1500, rd: 350, vol: 0.09, n: 0 },
    nextPuzzle: (filter, rating, difficulty) => {
      port.requests.push({ filter, rating, difficulty });
      return Promise.resolve(port.queue.shift() ?? null);
    },
    load: () => ({ rating: port.rating, difficulty: 'normal', filter: {} }),
    settle: (p, solved) => {
      port.settled.push({ id: p.id, solved });
      port.rating = {
        ...port.rating,
        rating: port.rating.rating + (solved ? 100 : -100),
        n: port.rating.n + 1,
      };
      return port.rating;
    },
    saveDifficulty: () => undefined,
    saveFilter: () => undefined,
    markSeen: (id) => {
      port.seen.push(id);
    },
  };
  return port;
}

let port: FakePort;
const st = () => usePuzzleStore.getState();
const game = () => useGameStore.getState();
const uciOnBoard = () => game().moves.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`);
const userMove = (uci: string) => game().makeMove(uci.slice(0, 2), uci.slice(2, 4), uci[4]);
const originalSetEnabled = useAnalysisStore.getState().setEnabled;

beforeEach(() => {
  vi.useFakeTimers();
  resetAnalysisPause();
  useAnalysisStore.setState({
    enabled: false,
    setEnabled: (enabled: boolean) => useAnalysisStore.setState({ enabled }),
  });
  game().reset();
  useGameStore.setState({ orientation: 'white' });
  usePlayStore.setState({ mode: 'idle' });
  useLiveStore.setState({ status: 'idle' });
  port = fakePort();
  resetPuzzleStore(port);
});

afterEach(() => {
  resetPuzzleStore(fakePort());
  resetAnalysisPause();
  useAnalysisStore.setState({ enabled: false, setEnabled: originalSetEnabled });
  usePlayStore.setState({ mode: 'idle' });
  useLiveStore.setState({ status: 'idle' });
  vi.useRealTimers();
});

describe('puzzle session', () => {
  it('loads the position, orients for the user and plays the intro after 600 ms', () => {
    st().start(LONG);
    expect(st().status).toBe('running');
    expect(game().startFen).toBe(LONG.fen);
    expect(game().orientation).toBe('white');
    expect(port.seen).toEqual(['00008']);
    expect(st().solver?.phase).toBe('intro');
    expect(puzzleMovableColor(st(), true)).toBeNull();
    vi.advanceTimersByTime(INTRO_DELAY_MS - 1);
    expect(game().moves).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(uciOnBoard()).toEqual(['f2g3']);
    expect(st().solver?.phase).toBe('user');
    expect(puzzleMovableColor(st(), true)).toBe('white');
    expect(puzzleMovableColor(st(), false)).toBeNull();
  });

  it('plays the reply 300 ms after a correct move and settles solved at the end', () => {
    const onResult = vi.fn();
    st().start(LONG, { onResult });
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('e6e7');
    expect(st().solver?.phase).toBe('opponent');
    vi.advanceTimersByTime(REPLY_DELAY_MS);
    expect(uciOnBoard()).toEqual(['f2g3', 'e6e7', 'b2b1']);
    userMove('b3c1');
    vi.advanceTimersByTime(REPLY_DELAY_MS);
    userMove('h6c1');
    expect(st().status).toBe('done');
    expect(st().solver?.result).toBe('solved');
    expect(port.settled).toEqual([{ id: '00008', solved: true }]);
    expect(st().rating.rating).toBe(1600);
    expect(st().ratingDelta).toBe(100);
    expect(onResult).toHaveBeenCalledWith('solved', LONG);
    expect(puzzleMovableColor(st(), true)).toBeUndefined();
  });

  it('a wrong move is shown, taken back, settles failed once; retries are free', () => {
    st().start(LONG);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('h6h7');
    expect(st().solver?.phase).toBe('wrong');
    expect(st().wrongOnBoard).toBe(true);
    expect(puzzleMarks(st())).toEqual([{ orig: 'h6', dest: 'h7', brush: 'red' }]);
    expect(puzzleMovableColor(st(), true)).toBeNull();
    expect(port.settled).toEqual([{ id: '00008', solved: false }]);
    vi.advanceTimersByTime(WRONG_SHOW_MS);
    expect(uciOnBoard()).toEqual(['f2g3']);
    expect(st().wrongOnBoard).toBe(false);
    st().retry();
    expect(st().solver?.phase).toBe('user');
    userMove('h6h5');
    vi.advanceTimersByTime(WRONG_SHOW_MS);
    st().retry();
    userMove('e6e7');
    vi.advanceTimersByTime(REPLY_DELAY_MS);
    userMove('b3c1');
    vi.advanceTimersByTime(REPLY_DELAY_MS);
    userMove('h6c1');
    expect(st().status).toBe('done');
    expect(st().solver?.result).toBe('failed');
    // Settled once, at the first wrong move.
    expect(port.settled).toHaveLength(1);
  });

  it('Try again before the takeback removes the wrong move at once', () => {
    st().start(LONG);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('h6h7');
    st().retry();
    expect(uciOnBoard()).toEqual(['f2g3']);
    expect(st().solver?.phase).toBe('user');
    vi.advanceTimersByTime(WRONG_SHOW_MS * 2);
    expect(uciOnBoard()).toEqual(['f2g3']);
  });

  it('an Undo of the wrong move is not a foreign change', () => {
    st().start(LONG);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('h6h7');
    game().undo();
    expect(st().status).toBe('running');
    expect(st().wrongOnBoard).toBe(false);
    st().retry();
    expect(st().solver?.phase).toBe('user');
  });

  it('accepts another mating move (alternative-mate rule)', () => {
    st().start(MATE);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('b1b8');
    expect(st().status).toBe('done');
    expect(st().solver?.result).toBe('solved');
  });

  it('hint highlights the piece and counts as a miss', () => {
    st().start(LONG);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    st().hint();
    expect(puzzleMarks(st())).toEqual([{ orig: 'e6', brush: 'green' }]);
    expect(port.settled).toEqual([{ id: '00008', solved: false }]);
    userMove('e6e7');
    expect(puzzleMarks(st())).toEqual([]);
  });

  it('show solution plays the rest step by step', () => {
    st().start(LONG);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('h6h7');
    st().showSolution();
    expect(uciOnBoard()).toEqual(['f2g3']);
    expect(st().solver?.phase).toBe('showing');
    vi.advanceTimersByTime(SOLUTION_STEP_MS * 5);
    expect(uciOnBoard()).toEqual(LONG.moves);
    expect(st().status).toBe('done');
    expect(st().solver?.outcome).toBe('shown');
    expect(port.settled).toHaveLength(1);
  });

  it('unrated puzzles do not touch the rating but report the result', () => {
    const onResult = vi.fn();
    st().start(MATE, { rated: false, onResult });
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('a1a8');
    expect(port.settled).toEqual([]);
    expect(onResult).toHaveBeenCalledWith('solved', MATE);
    expect(st().rated).toBe(false);
  });

  it('typed SAN moves go through the board', () => {
    st().start(MATE);
    expect(st().playSan('Ra8#')).toBe(false); // intro not played yet
    expect(st().inputError).toBe('Wait for your turn.');
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    expect(st().playSan('Qh5')).toBe(false);
    expect(st().inputError).toBe('Qh5 is not a legal move here.');
    expect(st().playSan(' Ra8 ')).toBe(true);
    expect(st().inputError).toBeUndefined();
    expect(st().status).toBe('done');
  });

  it('a typed move from a stepped-back view plays at the tip', () => {
    st().start(MATE);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    game().goTo(0);
    expect(puzzleMovableColor(st(), false)).toBeNull();
    expect(st().playSan('Ra8')).toBe(true);
    expect(st().status).toBe('done');
  });

  it('app moves jump to the tip when the user stepped back', () => {
    st().start(LONG);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('e6e7');
    game().goTo(0);
    vi.advanceTimersByTime(REPLY_DELAY_MS);
    expect(uciOnBoard()).toEqual(['f2g3', 'e6e7', 'b2b1']);
    expect(st().status).toBe('running');
  });
});

describe('next puzzle', () => {
  it('asks the port with filter, rating and difficulty and starts the puzzle', async () => {
    port.queue.push(MATE);
    st().setDifficulty('harder');
    await st().next();
    expect(port.requests).toEqual([{ filter: {}, rating: 1500, difficulty: 'harder' }]);
    expect(st().status).toBe('running');
    expect(st().solver?.puzzle.id).toBe('mate2');
  });

  it('shows the empty state when nothing is available', async () => {
    await st().next();
    expect(st().status).toBe('empty');
    expect(st().message).toBe(NO_MORE_TEXT);
  });

  it('reports a failing data layer', async () => {
    port.nextPuzzle = () => Promise.reject(new Error('offline'));
    await st().next();
    expect(st().status).toBe('empty');
    expect(st().message).toBe('Could not load a puzzle: offline');
  });

  it('a stop while loading drops the late puzzle', async () => {
    let resolve: (p: Puzzle) => void = () => undefined;
    port.nextPuzzle = () => new Promise((r) => (resolve = r));
    const pending = st().next();
    expect(st().status).toBe('loading');
    st().stop();
    resolve(MATE);
    await pending;
    expect(st().status).toBe('idle');
    expect(game().startFen).not.toBe(MATE.fen);
  });
});

describe('ending a session', () => {
  it('refuses to start while a human game runs', async () => {
    usePlayStore.setState({ mode: 'playing' });
    st().start(MATE);
    expect(st().status).toBe('idle');
    expect(st().message).toBe('Puzzles are paused: Paused while playing against the engine.');
    port.queue.push(MATE);
    await st().next();
    expect(port.requests).toHaveLength(0);
  });

  it('ends when a human game starts', () => {
    st().start(MATE);
    useLiveStore.setState({ status: 'playing' });
    expect(st().status).toBe('idle');
    expect(st().message).toMatch(/^Puzzle ended: /);
  });

  it('ends on a foreign game-store change', () => {
    st().start(LONG);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    game().loadFen('8/8/8/8/8/8/8/K1k5 w - - 0 1');
    expect(st().status).toBe('idle');
    expect(st().message).toBe('Puzzle ended: another position was loaded.');
    vi.advanceTimersByTime(5000);
    expect(game().moves).toHaveLength(0);
  });

  it('ends on a takeback of a correct move', () => {
    st().start(LONG);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('e6e7');
    vi.advanceTimersByTime(REPLY_DELAY_MS);
    game().undo();
    expect(st().status).toBe('idle');
    expect(st().message).toBe('Puzzle ended: the board was changed.');
  });

  it('a move after the end closes the session quietly and keeps the result', () => {
    st().start(MATE);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('a1a8');
    expect(st().status).toBe('done');
    game().undo();
    expect(st().status).toBe('idle');
    expect(st().message).toBeUndefined();
    expect(st().solver?.result).toBe('solved');
  });

  it('pauses the live analysis while a puzzle runs and restores it afterwards', async () => {
    useAnalysisStore.setState({ enabled: true });
    st().start(MATE);
    expect(useAnalysisStore.getState().enabled).toBe(false);
    useAnalysisStore.getState().setEnabled(true);
    expect(useAnalysisStore.getState().enabled).toBe(false);
    // Stays off between two puzzles.
    port.queue.push(LONG);
    await st().next();
    expect(useAnalysisStore.getState().enabled).toBe(false);
    st().stop();
    expect(useAnalysisStore.getState().enabled).toBe(true);
  });

  it('Analyse keeps the solution line, restores the analysis and shows the Moves tab', () => {
    useAnalysisStore.setState({ enabled: true });
    useUiStore.getState().setActiveTab('puzzles');
    st().start(LONG);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('h6h7');
    st().showSolution();
    vi.advanceTimersByTime(SOLUTION_STEP_MS * 5);
    expect(st().status).toBe('done');
    st().analyse();
    expect(st().status).toBe('idle');
    expect(game().startFen).toBe(LONG.fen);
    expect(uciOnBoard()).toEqual(LONG.moves);
    expect(game().ply).toBe(LONG.moves.length);
    expect(useAnalysisStore.getState().enabled).toBe(true);
    expect(useUiStore.getState().activeTab).toBe('moves');
    // The game is free again: moves do not end anything.
    userMove('h8g8');
    expect(st().message).toBeUndefined();
  });

  it('Analyse after an alternative mate keeps the played line', () => {
    st().start(MATE);
    vi.advanceTimersByTime(INTRO_DELAY_MS);
    userMove('b1b8');
    st().analyse();
    expect(uciOnBoard()).toEqual(['e5c4', 'b1b8']);
  });
});

describe('openings drill interplay', () => {
  const ROWS: OpeningRow[] = [['B20', 'Sicilian Defense', 'x1', 'e4 c5']];
  const book = new Book(ROWS);

  afterEach(async () => {
    await resetDrill();
  });

  it('starting a drill stops the puzzle silently', async () => {
    await configureDrill({ book: () => book, appDelayMs: () => 0, storage: undefined });
    st().start(LONG);
    useDrillStore.getState().start(book.openings[0]!, 'white');
    expect(useDrillStore.getState().status).toBe('running');
    expect(st().status).toBe('idle');
    expect(st().message).toBeUndefined();
  });

  it('starting a puzzle stops a running drill', async () => {
    await configureDrill({ book: () => book, appDelayMs: () => 0, storage: undefined });
    useDrillStore.getState().start(book.openings[0]!, 'white');
    st().start(MATE);
    expect(useDrillStore.getState().status).toBe('idle');
    expect(st().status).toBe('running');
  });
});
