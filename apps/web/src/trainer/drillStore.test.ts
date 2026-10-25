import { Chess } from 'chess.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Book, openingKey, type BookOpening, type OpeningRow } from '../openings/book';
import { resetPlay, usePlayStore } from '../play/playStore';
import { FakeReviewEngine } from '../review/fakeEngine';
import type { SearchEngineLease } from '../review/reviewStore';
import { useGameStore } from '../store/gameStore';
import { useUiStore } from '../store/uiStore';
import { DAY_MS, TRAINER_KEY, type KeyValueStorage } from './schedule';
import {
  configureDrill,
  drillArrows,
  drillMovableColor,
  drillPlayers,
  dueCount,
  resetDrill,
  useDrillStore,
  type CreateDrillEngine,
} from './drillStore';

const ROWS: OpeningRow[] = [
  ['B20', 'Sicilian Defense', 'x1', 'e4 c5'],
  ['C20', "King's Pawn Game", 'x2', 'e4 e5'],
  ['C21', 'Center Game', 'x3', 'e4 e5 d4'],
  ['C40', "King's Knight Opening", 'x4', 'e4 e5 Nf3'],
  ['C50', 'Italian Game', 'x5', 'e4 e5 Nf3 Nc6 Bc4'],
  ['C50', 'Italian Game: Giuoco Piano', 'x6', 'e4 e5 Nf3 Nc6 Bc4 Bc5'],
  ['C54', 'Italian Game: Giuoco Piano, Main Line', 'x7', 'e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6'],
  ['C55', 'Italian Game: Two Knights Defense', 'x8', 'e4 e5 Nf3 Nc6 Bc4 Nf6'],
  ['C60', 'Ruy Lopez', 'x9', 'e4 e5 Nf3 Nc6 Bb5'],
];
const book = new Book(ROWS);
const named = (name: string): BookOpening => book.openings.find((o) => o.name === name)!;
const italian = named('Italian Game');
const sicilian = named('Sicilian Defense');

function fenAfter(san: string): string {
  const c = new Chess();
  for (const m of san.split(' ').filter(Boolean)) c.move(m);
  return c.fen();
}

function memoryStorage(): KeyValueStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

let engine: FakeReviewEngine;
let storage: ReturnType<typeof memoryStorage>;
let now = 1_700_000_000_000;
let leases: { pref?: string; disposed: boolean }[];

function leaseOf(
  e: FakeReviewEngine,
  kind: 'browser' | 'server',
  pref?: string,
): SearchEngineLease {
  const rec = { pref, disposed: false };
  leases.push(rec);
  return {
    engine: e,
    runsOn: { kind },
    dispose: async () => {
      rec.disposed = true;
      await e.dispose();
    },
  };
}

async function setup(over: { createEngine?: CreateDrillEngine; random?: () => number } = {}) {
  engine = new FakeReviewEngine();
  storage = memoryStorage();
  leases = [];
  await configureDrill({
    createEngine: over.createEngine ?? (async (pref) => leaseOf(engine, 'browser', pref)),
    reportServerFailure: () => 'Server unavailable (connection lost) — reviewing in the browser',
    appDelayMs: () => 0,
    random: over.random ?? (() => 0),
    now: () => now,
    storage,
    book: () => book,
    search: { movetime: 10 },
    checkTimeoutMs: 2_000,
  });
}

const drill = () => useDrillStore.getState();
const game = () => useGameStore.getState();
const sans = () => game().moves.map((m) => m.san);

/** Plays a SAN move as the user would (through the board → game store). */
function play(san: string): void {
  const m = new Chess(game().moves.at(-1)?.fen ?? game().startFen).move(san);
  expect(game().makeMove(m.from, m.to, m.promotion)).toBe(true);
}

const waitPhase = (phase: string) => vi.waitFor(() => expect(drill().phase).toBe(phase));

beforeEach(async () => {
  now = 1_700_000_000_000;
  game().reset();
  await resetPlay();
  await setup();
});

afterEach(async () => {
  await resetDrill();
  await resetPlay();
});

describe('drill flow', () => {
  it('accepts book moves and plays the book replies', async () => {
    drill().start(italian, 'white');
    expect(drill()).toMatchObject({ status: 'running', phase: 'user', userColor: 'white' });
    expect(game().orientation).toBe('white');
    expect(drillMovableColor(drill(), true)).toBe('white');
    play('e4');
    expect(drill().feedback).toEqual({ kind: 'book', san: 'e4' });
    // The app's reply is forced along the drilled line (1...e5, not 1...c5).
    await waitPhase('user');
    expect(sans()).toEqual(['e4', 'e5']);
    expect(drill().feedback).toEqual({ kind: 'app', san: 'e5', name: "King's Pawn Game" });
    play('Nf3');
    expect(drill().feedback).toMatchObject({ kind: 'book', name: "King's Knight Opening" });
    await waitPhase('user');
    play('Bc4');
    expect(drill().current).toBe('Italian Game');
    expect(engine.analysed).toEqual([]); // book moves need no engine
  });

  it('a fine non-book move after the variation is accepted and ends the line out of book', async () => {
    drill().start(italian, 'white');
    for (const m of ['e4', 'Nf3', 'Bc4']) {
      play(m);
      await waitPhase('user');
    }
    // random() = 0 → the most popular reply: 3...Bc5 (two lines below) over 3...Nf6.
    expect(sans()).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5']);
    const before = fenAfter('e4 e5 Nf3 Nc6 Bc4 Bc5');
    const after = fenAfter('e4 e5 Nf3 Nc6 Bc4 Bc5 d3');
    engine.scripts.set(before, { score: { cp: 25 }, pv: ['c2c3', 'g8f6'], bestMove: 'c2c3' });
    engine.scripts.set(after, { score: { cp: 10 }, pv: ['g8f6'] });
    play('d3');
    expect(drill().phase).toBe('checking');
    await vi.waitFor(() => expect(drill().status).toBe('done'));
    expect(drill().feedback).toEqual({ kind: 'fine', san: 'd3', eval: '+0.10', retry: false });
    expect(drill().summary).toEqual({
      reason: 'outOfBook',
      userMoves: 4,
      firstTry: 4,
      mistakes: 0,
      reached: 'Italian Game: Giuoco Piano',
    });
    expect(engine.analysed).toEqual([before, after]);
    expect(engine.calls[0]).toEqual({ movetime: 10 });
    // The engine is released when the drill ends.
    await vi.waitFor(() => expect(leases[0]?.disposed).toBe(true));
  });

  it('mistake → feedback with eval loss and best line → try again → book move accepted', async () => {
    drill().start(italian, 'white');
    play('e4');
    await waitPhase('user');
    const before = fenAfter('e4 e5');
    engine.scripts.set(before, {
      score: { cp: 30 },
      pv: ['g1f3', 'b8c6', 'f1c4', 'g8f6', 'd2d3'],
      bestMove: 'g1f3',
    });
    engine.scripts.set(fenAfter('e4 e5 Ba6'), { score: { cp: -310 }, pv: ['b7a6'] });
    play('Ba6');
    await waitPhase('retry');
    const f = drill().feedback;
    expect(f).toMatchObject({
      kind: 'mistake',
      san: 'Ba6',
      playedUci: 'f1a6',
      playedEval: '-3.10',
      bestEval: '+0.30',
      lossCp: 340,
      bestSan: 'Nf3',
      bestUci: 'g1f3',
      pvSan: ['Nf3', 'Nc6', 'Bc4', 'Nf6'],
      pvText: '2. Nf3 Nc6 3. Bc4 Nf6',
    });
    expect(drillArrows(f)).toEqual([
      { uci: 'f1a6', brush: 'red' },
      { uci: 'g1f3', brush: 'green' },
    ]);
    expect(drill().mistakes).toBe(1);
    expect(drillMovableColor(drill(), true)).toBeNull();
    expect(sans()).toEqual(['e4', 'e5', 'Ba6']);

    drill().retry();
    expect(sans()).toEqual(['e4', 'e5']);
    expect(drill()).toMatchObject({ phase: 'user', feedback: { kind: 'retry', san: 'Ba6' } });
    play('Nf3');
    expect(drill().feedback).toMatchObject({ kind: 'book', san: 'Nf3' });
    // The retried move does not count as right first try.
    expect(drill()).toMatchObject({ userMoves: 2, firstTry: 1, mistakes: 1 });
  });

  it('a retry of the same position does not search it again', async () => {
    drill().start(italian, 'white');
    play('e4');
    await waitPhase('user');
    const before = fenAfter('e4 e5');
    engine.scripts.set(before, { score: { cp: 30 }, pv: ['g1f3'], bestMove: 'g1f3' });
    engine.scripts.set(fenAfter('e4 e5 Ba6'), { score: { cp: -300 } });
    engine.scripts.set(fenAfter('e4 e5 Qh5'), { score: { cp: -100 } });
    play('Ba6');
    await waitPhase('retry');
    drill().retry();
    play('Qh5');
    await waitPhase('retry');
    expect(engine.analysed.filter((f) => f === before)).toHaveLength(1);
    expect(drill().mistakes).toBe(2);
  });

  it('a book move of another variation before reaching the drilled one: try again, no mistake', async () => {
    drill().start(italian, 'white');
    play('e4');
    await waitPhase('user');
    play('d4'); // Center Game: book, but not the Italian line
    expect(drill()).toMatchObject({
      phase: 'retry',
      mistakes: 0,
      feedback: { kind: 'otherLine', san: 'd4', name: 'Center Game', expected: 'Nf3' },
    });
    drill().retry();
    play('Nf3');
    expect(drill()).toMatchObject({ firstTry: 2, mistakes: 0 });
  });

  it('a fine move off the drilled line before its end asks for the line move', async () => {
    drill().start(italian, 'white');
    play('e4');
    await waitPhase('user');
    engine.scripts.set(fenAfter('e4 e5'), { score: { cp: 30 }, pv: ['g1f3'], bestMove: 'g1f3' });
    engine.scripts.set(fenAfter('e4 e5 Nc3'), { score: { cp: 20 } });
    play('Nc3');
    await waitPhase('retry');
    expect(drill().feedback).toEqual({
      kind: 'fine',
      san: 'Nc3',
      eval: '+0.20',
      retry: true,
      expected: 'Nf3',
    });
    expect(drill()).toMatchObject({ status: 'running', mistakes: 0 });
  });

  it('as Black: the board is flipped and the app opens', async () => {
    drill().start(italian, 'black');
    expect(game().orientation).toBe('black');
    expect(drill().phase).toBe('app');
    expect(drillMovableColor(drill(), true)).toBeNull();
    await waitPhase('user');
    expect(sans()).toEqual(['e4']);
    expect(drillPlayers(drill())).toEqual({
      white: { name: 'Book (Italian Game)' },
      black: { name: 'You' },
    });
  });

  it('"both" alternates the colour per drill', async () => {
    drill().start(sicilian, 'both');
    expect(drill().userColor).toBe('white');
    drill().repeat();
    expect(drill().userColor).toBe('black');
    drill().repeat();
    expect(drill().userColor).toBe('white');
  });
});

describe('line end, summary and schedule', () => {
  it('ends at the end of the line with a summary and schedules the variation', async () => {
    drill().start(sicilian, 'white');
    expect(drillPlayers(drill())).toEqual({
      white: { name: 'You' },
      black: { name: 'Book (Sicilian Defense)' },
    });
    play('e4');
    await vi.waitFor(() => expect(drill().status).toBe('done'));
    expect(sans()).toEqual(['e4', 'c5']); // the game stays on the board
    expect(drill().summary).toEqual({
      reason: 'end',
      userMoves: 1,
      firstTry: 1,
      mistakes: 0,
      reached: 'Sicilian Defense',
    });
    const key = openingKey(sicilian);
    expect(drill().schedule[key]).toEqual({
      due: now + DAY_MS,
      interval: 1,
      lapses: 0,
      successes: 1,
    });
    expect(JSON.parse(storage.data[TRAINER_KEY]!)[key].interval).toBe(1);
    expect(drillMovableColor(drill(), true)).toBeUndefined();
    expect(drillPlayers(drill())).toBeUndefined();
    expect(dueCount(drill().schedule, now)).toBe(0);
    expect(dueCount(drill().schedule, now + DAY_MS)).toBe(1);

    // Right again: the interval grows by 2.5.
    drill().repeat();
    play('e4');
    await vi.waitFor(() => expect(drill().status).toBe('done'));
    expect(drill().schedule[key]!.interval).toBe(2.5);
  });

  it('a drill with a mistake makes the variation due now; Train due starts it', async () => {
    drill().start(sicilian, 'white');
    engine.scripts.set(fenAfter(''), { score: { cp: 30 }, pv: ['e2e4'], bestMove: 'e2e4' });
    engine.scripts.set(fenAfter('f3'), { score: { cp: -60 } });
    play('f3');
    await waitPhase('retry');
    drill().retry();
    play('e4');
    await vi.waitFor(() => expect(drill().status).toBe('done'));
    expect(drill().summary).toMatchObject({ userMoves: 1, firstTry: 0, mistakes: 1 });
    const key = openingKey(sicilian);
    expect(drill().schedule[key]).toEqual({ due: now, interval: 1, lapses: 1, successes: 0 });
    expect(dueCount(drill().schedule, now)).toBe(1);

    game().reset();
    expect(drill().trainDue()).toBe(true);
    expect(drill()).toMatchObject({ status: 'running', opening: { name: 'Sicilian Defense' } });
  });

  it('Train due is false without due variations; Next variation goes to the next table entry', () => {
    expect(drill().trainDue()).toBe(false);
    drill().start(italian, 'white');
    drill().next();
    expect(drill().opening?.name).toBe('Italian Game: Giuoco Piano');
  });

  it('Play on hands the position to the Play tab', async () => {
    drill().start(sicilian, 'white');
    play('e4');
    await vi.waitFor(() => expect(drill().status).toBe('done'));
    useUiStore.getState().setActiveTab('openings');
    drill().playOn();
    expect(useUiStore.getState().activeTab).toBe('play');
    expect(sans()).toEqual(['e4', 'c5']);
    expect(drill().status).toBe('idle');
  });
});

describe('engine line', () => {
  it('keeps the longer line when the last info truncates it', async () => {
    const infos = [
      { depth: 9, multipv: 1, score: { cp: 40 }, pv: ['g1f3', 'b8c6', 'f1c4', 'g8f6'] },
      { depth: 10, multipv: 2, score: { cp: 10 }, pv: ['b1c3'] },
      { depth: 10, multipv: 1, score: { cp: 35 }, pv: ['g1f3', 'b8c6'] },
    ];
    const scripted = {
      load: async () => {},
      setOptions: async () => {},
      stop: async () => {},
      dispose: async () => {},
      analyze: (fen: string) => ({
        bestMove: Promise.resolve({ move: 'g1f3' }),
        async *[Symbol.asyncIterator]() {
          if (fen === fenAfter('e4 e5')) for (const i of infos) yield i;
          else yield { depth: 10, multipv: 1, score: { cp: -300 }, pv: ['b7a6'] };
        },
      }),
    };
    await setup({
      createEngine: async () => ({
        engine: scripted,
        runsOn: { kind: 'browser' },
        dispose: async () => {},
      }),
    });
    drill().start(italian, 'white');
    play('e4');
    await waitPhase('user');
    play('Ba6');
    await waitPhase('retry');
    expect(drill().feedback).toMatchObject({
      kind: 'mistake',
      bestEval: '+0.35',
      pvSan: ['Nf3', 'Nc6', 'Bc4', 'Nf6'],
    });
  });
});

describe('engine failures', () => {
  it('a failing check shows an error and allows a retry', async () => {
    drill().start(italian, 'white');
    engine.fail.set(fenAfter(''), new Error('worker crashed'));
    play('a3');
    await waitPhase('retry');
    expect(drill().feedback).toEqual({ kind: 'error', san: 'a3', message: 'worker crashed' });
    expect(drill().mistakes).toBe(0);
    drill().retry();
    expect(sans()).toEqual([]);
    expect(drill().phase).toBe('user');
  });

  it('a check that hangs times out', async () => {
    await setup();
    await configureDrill({
      createEngine: async () => leaseOf(engine, 'browser'),
      appDelayMs: () => 0,
      random: () => 0,
      now: () => now,
      storage,
      book: () => book,
      search: { movetime: 10 },
      checkTimeoutMs: 30,
    });
    drill().start(italian, 'white');
    engine.hang.add(fenAfter(''));
    play('a3');
    await waitPhase('retry');
    expect(drill().feedback).toMatchObject({ kind: 'error', message: 'The engine took too long' });
  });

  it('a server that fails mid-check falls back to the browser engine', async () => {
    const server = new FakeReviewEngine();
    server.fail.set(fenAfter('e4 e5'), Object.assign(new Error('closed'), { code: 'closed' }));
    const browser = new FakeReviewEngine();
    const prefs: (string | undefined)[] = [];
    await setup({
      createEngine: async (pref) => {
        prefs.push(pref);
        return pref === 'browser' ? leaseOf(browser, 'browser', pref) : leaseOf(server, 'server');
      },
    });
    drill().start(italian, 'white');
    play('e4');
    await waitPhase('user');
    browser.scripts.set(fenAfter('e4 e5'), { score: { cp: 30 }, pv: ['g1f3'], bestMove: 'g1f3' });
    browser.scripts.set(fenAfter('e4 e5 Ba6'), { score: { cp: -300 } });
    play('Ba6');
    await waitPhase('retry');
    expect(drill().feedback).toMatchObject({ kind: 'mistake', bestSan: 'Nf3' });
    expect(prefs).toEqual([undefined, 'browser']);
    expect(drill().runsOn).toEqual({ kind: 'browser' });
    expect(drill().engineNotice).toBe(
      'Server unavailable (connection lost) — checking in the browser',
    );
    expect(server.disposed).toBe(true);
  });
});

describe('locks and board changes', () => {
  it('cannot start while an engine game runs', () => {
    usePlayStore.setState({ mode: 'playing' });
    drill().start(italian, 'white');
    expect(drill().status).toBe('idle');
    expect(drill().message).toMatch(/uses the engine/);
  });

  it('starting an engine game ends the drill', () => {
    drill().start(italian, 'white');
    usePlayStore.setState({ mode: 'playing' });
    expect(drill().status).toBe('idle');
    expect(drill().message).toMatch(/Drill ended/);
  });

  it('loading another game ends the drill', () => {
    drill().start(italian, 'white');
    game().loadPgn('1. d4 d5');
    expect(drill()).toMatchObject({ status: 'idle', message: expect.stringMatching(/loaded/) });
  });

  it('a takeback continues the drill from the earlier position', async () => {
    drill().start(italian, 'white');
    play('e4');
    await waitPhase('user');
    game().undo(); // takes back 1...e5: the app plays it again
    await waitPhase('user');
    expect(sans()).toEqual(['e4', 'e5']);
    expect(drill().status).toBe('running');
  });

  it('stop ends without recording a result', () => {
    drill().start(italian, 'white');
    drill().stop();
    expect(drill().status).toBe('idle');
    expect(drill().schedule).toEqual({});
  });
});
