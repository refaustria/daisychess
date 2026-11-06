// @vitest-environment jsdom
import {
  fenAfter,
  judgeMove,
  keepers,
  opponentMove,
  rankMoves,
  type Lesson,
  type SyzygyTables,
} from '@daisychess/endgames';
import type { Puzzle } from '@daisychess/puzzles';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAnalysisPause } from '../engine/analysisPause';
import { resetPuzzleStore, usePuzzleStore, type PuzzlePort } from '../puzzles/puzzleStore';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { LESSONS } from './data/lessons';
import { ENDGAMES_KEY, loadProgress, lessonMark } from './endgamesProgress';
import {
  budgetLine,
  configureLessonStore,
  lessonMarks,
  lessonMovableColor,
  lessonStatusLine,
  packText,
  resetLessonStore,
  resultText,
  useLessonStore,
} from './lessonStore';
import { boardMove, coreTables, installKit, makeKit, settled, type Kit } from './lessonTestKit';
import { stopEndgameLesson } from './navigate';
import { configureTablebase, opponentPolicyFor, resetTablebaseStore } from './tablebaseStore';

const lesson = (id: string): Lesson => LESSONS.find((l) => l.id === id)!;
const KQK = lesson('kq-vs-k');

let tables: SyzygyTables;
let kit: Kit;
const s = () => useLessonStore.getState();

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

const puzzlePort = (): PuzzlePort => ({
  nextPuzzle: () => Promise.resolve(MATE),
  load: () => ({
    rating: { rating: 1500, rd: 350, vol: 0.09, n: 0 },
    difficulty: 'normal',
    filter: {},
  }),
  settle: () => ({ rating: 1500, rd: 350, vol: 0.09, n: 0 }),
  saveDifficulty: () => undefined,
  saveFilter: () => undefined,
  markSeen: () => undefined,
});

/** The tablebase's best move for the side to move in the lesson's current position. */
const best = (): string => {
  const pos = tables.probePosition(s().game!.fen)!;
  return rankMoves(pos)[0]!.uci;
};

/** A move of the current position that worsens the mover's result. */
const thrower = (): string => {
  const pos = tables.probePosition(s().game!.fen)!;
  const m = pos.moves.find((x) => judgeMove(pos, x.uci)?.kind === 'thrown');
  if (!m) throw new Error('no throwing move');
  return m.uci;
};

beforeAll(() => {
  tables = coreTables();
});

beforeEach(() => {
  localStorage.clear();
  resetAnalysisPause();
  useAnalysisStore.setState({
    enabled: true,
    setEnabled: (enabled: boolean) => useAnalysisStore.setState({ enabled }),
  });
  resetPuzzleStore(puzzlePort());
  kit = makeKit(tables);
  installKit(kit, 'online');
});

afterEach(() => {
  resetLessonStore();
  configureLessonStore(null);
  configureTablebase(null);
  resetTablebaseStore();
  useSettingsStore.getState().set({ tablebase: 'online' });
});

describe('K+Q vs K with the bundled tables', () => {
  it('starts on the lesson position with the user to move and the analysis paused', async () => {
    expect(await s().start(KQK.id)).toBe(true);
    await settled();
    const g = useGameStore.getState();
    expect(g.startFen).toBe(KQK.fen);
    expect(g.orientation).toBe('white');
    expect(s().status).toBe('running');
    expect(s().source).toBe('local');
    expect(s().game?.phase).toBe('user');
    expect(useAnalysisStore.getState().enabled).toBe(false);
    expect(lessonMovableColor(s(), true)).toBe('white');
    expect(lessonMovableColor(s(), false)).toBeNull();
    expect(budgetLine(s().game!)).toBe('Goal: checkmate within 14 moves · 14 left');
    // Local tables only: lichess is never asked.
    expect(kit.lichess.probe).not.toHaveBeenCalled();
  });

  it('a winning move gets the slowest-loss reply of the dtz policy', async () => {
    await s().start(KQK.id);
    await settled();
    const user = best();
    expect(boardMove(user)).toBe(true);
    await settled();
    const g = s().game!;
    expect(g.played[0]).toBe(user);
    expect(g.verdict?.kind).not.toBe('thrown');
    const afterUser = fenAfter(KQK.fen, user)!;
    const pos = tables.probePosition(afterUser)!;
    expect(opponentPolicyFor({ pos, source: 'local' })).toBe('dtz');
    expect(g.played[1]).toBe(rankMoves(pos)[0]!.uci);
    expect(useGameStore.getState().moves).toHaveLength(2);
    expect(lessonStatusLine(s())).toMatch(/keeps the win\. Your move \(White\)\./);
  });

  it('a move that throws the win fails at once with the keeper; Take back restores', async () => {
    await s().start(KQK.id);
    await settled();
    // Qe4+?? next to the king, unprotected: the king takes it.
    expect(boardMove('b1e4')).toBe(true);
    await settled();
    expect(s().status).toBe('done');
    expect(s().game?.outcome).toBe('failure');
    expect(s().game?.reason).toBe('thrown');
    const startPos = tables.probePosition(KQK.fen)!;
    const keeper = keepers(startPos)[0]!;
    expect(s().thrown).toMatchObject({ uci: 'b1e4', keeperUci: keeper.uci, keeperSan: keeper.san });
    expect(resultText(s().game!, s().thrown)).toBe(
      `Qe4+? throws away the win — the position is a draw now. ${keeper.san} keeps it.`,
    );
    expect(lessonMarks(s())).toEqual([
      { orig: 'b1', dest: 'e4', brush: 'red' },
      { orig: keeper.uci.slice(0, 2), dest: keeper.uci.slice(2, 4), brush: 'green' },
    ]);
    // The failure is recorded once: due now.
    const p = loadProgress();
    expect(p.lessons[KQK.id]).toMatchObject({ done: false, attempts: 1 });
    expect(lessonMark(p, KQK.id, Date.now())).toBe('due');

    s().takeBack();
    await settled();
    expect(s().status).toBe('running');
    expect(s().game?.fen).toBe(KQK.fen);
    expect(s().game?.mistakes).toBe(1);
    expect(s().thrown).toBeUndefined();
    expect(useGameStore.getState().moves).toHaveLength(0);
    expect(lessonMarks(s())).toEqual([]);
  });

  it('mate succeeds and records done and a schedule entry', async () => {
    await s().start(KQK.id);
    await settled();
    for (let i = 0; i < 20 && s().status === 'running'; i++) {
      expect(boardMove(best())).toBe(true);
      await settled();
    }
    expect(s().status).toBe('done');
    expect(s().game?.outcome).toBe('success');
    expect(s().game?.reason).toBe('mate');
    expect(s().game!.userMoves).toBeLessThanOrEqual(KQK.budget);
    const stored = JSON.parse(localStorage.getItem(ENDGAMES_KEY)!);
    expect(stored.v).toBe(1);
    const entry = stored.lessons[KQK.id];
    expect(entry).toMatchObject({ done: true, attempts: 1, mistakes: 0 });
    expect(entry.schedule.successes).toBe(1);
    expect(entry.schedule.due).toBeGreaterThan(Date.now());
    expect(s().progress.lessons[KQK.id]?.done).toBe(true);
    // The analysis stays paused on the result until the session ends.
    expect(useAnalysisStore.getState().enabled).toBe(false);
    s().stop();
    expect(useAnalysisStore.getState().enabled).toBe(true);
  });

  it('a success after a take-back marks done but leaves the lesson due', async () => {
    await s().start(KQK.id);
    await settled();
    boardMove('b1e4');
    await settled();
    s().takeBack();
    await settled();
    for (let i = 0; i < 20 && s().status === 'running'; i++) {
      boardMove(best());
      await settled();
    }
    expect(s().game?.reason).toBe('mate');
    const p = loadProgress().lessons[KQK.id]!;
    expect(p).toMatchObject({ done: true, attempts: 1 });
    expect(p.schedule.lapses).toBe(1);
    expect(lessonMark(loadProgress(), KQK.id, Date.now())).toBe('due');
  });

  it('the budget failure counts the user moves', async () => {
    installKit(kit, 'online', [{ ...KQK, id: 'kq-short', budget: 2 }]);
    await s().start('kq-short');
    await settled();
    boardMove(best());
    await settled();
    boardMove(best());
    await settled();
    expect(s().game?.reason).toBe('budget');
    expect(resultText(s().game!)).toBe('Not converted within 2 moves.');
  });

  it('Hint shows the next plan sentence and the piece, and counts as a mistake', async () => {
    await s().start(KQK.id);
    await settled();
    await s().hint();
    const g = s().game!;
    expect(g.hintIndex).toBe(1);
    expect(g.hints).toBe(1);
    const keeper = keepers(tables.probePosition(KQK.fen)!)[0]!;
    expect(lessonMarks(s())).toEqual([{ orig: keeper.uci.slice(0, 2), brush: 'green' }]);
    await s().showMove();
    expect(s().game?.shownMove).toBe(rankMoves(tables.probePosition(KQK.fen)!)[0]!.uci);
    expect(s().game?.hints).toBe(2);
  });

  it('typed SAN moves are played through the board; illegal input is reported', async () => {
    await s().start(KQK.id);
    await settled();
    expect(s().playSan('Ke2')).toBe(false);
    expect(s().inputError).toBe('Ke2 is not a legal move here.');
    expect(s().playSan('Qb5+')).toBe(true);
    expect(s().inputError).toBeUndefined();
    await settled();
    expect(s().game?.played[0]).toBe('b1b5');
    expect(useGameStore.getState().moves[0]?.san).toBe('Qb5+');
  });

  it('Restart goes back to the start as a new attempt', async () => {
    await s().start(KQK.id);
    await settled();
    boardMove(best());
    await settled();
    s().restart();
    await settled();
    expect(s().game?.attempts).toBe(2);
    expect(s().game?.fen).toBe(KQK.fen);
    expect(useGameStore.getState().moves).toHaveLength(0);
  });
});

describe('draw lessons', () => {
  const SQUARE = lesson('kpk-rule-of-square');

  it('succeeds when the user holds (best defence)', async () => {
    await s().start(SQUARE.id);
    await settled();
    expect(useGameStore.getState().orientation).toBe('black');
    for (let i = 0; i < 30 && s().status === 'running'; i++) {
      expect(boardMove(best())).toBe(true);
      await settled();
    }
    expect(s().game?.outcome).toBe('success');
    expect(['held', 'tablebaseDraw', 'insufficient']).toContain(s().game?.reason);
    expect(loadProgress().lessons[SQUARE.id]?.done).toBe(true);
  });

  it('fails on a move that throws the draw', async () => {
    await s().start(SQUARE.id);
    await settled();
    boardMove(thrower());
    await settled();
    expect(s().game?.reason).toBe('thrown');
    expect(resultText(s().game!, s().thrown)).toMatch(
      /\? loses — the position is lost now\. .+ holds\./,
    );
  });
});

describe('the wdlTrappy opponent (K+Q vs K+P offline, WDL only)', () => {
  it('answers with the move that leaves the fewest keepers', async () => {
    const QP = lesson('qvp-knight-pawn');
    await s().start(QP.id);
    await settled();
    const user = best();
    boardMove(user);
    await settled();
    expect(s().status).toBe('running');
    const pos = tables.probePosition(fenAfter(QP.fen, user)!)!;
    expect(pos.dtz).toBeUndefined();
    expect(opponentPolicyFor({ pos, source: 'local' })).toBe('wdlTrappy');
    const expected = await opponentMove(
      pos,
      { probe: async (f) => tables.probePosition(f) },
      'wdlTrappy',
    );
    expect(s().game?.played[1]).toBe(expected);
  });
});

describe('source selection and refusals', () => {
  const LUCENA = lesson('lucena');

  it('a rook lesson without the pack and setting local shows the download hint', async () => {
    installKit(kit, 'local');
    expect(await s().start(LUCENA.id)).toBe(false);
    expect(s().status).toBe('idle');
    expect(s().lessonId).toBe(LUCENA.id);
    expect(s().needsPack).toBe('rook');
    expect(s().message).toBe(packText('rook'));
    expect(s().message).toMatch(
      /^Needs the rook endgames download \(\d+(\.\d)? MB\) to play offline\.$/,
    );
    expect(useGameStore.getState().startFen).not.toBe(LUCENA.fen);
    expect(useAnalysisStore.getState().enabled).toBe(true);
    expect(kit.lichess.probe).not.toHaveBeenCalled();
  });

  it('with setting online the rook lesson uses the lichess tablebase', async () => {
    kit.setLichess(async (fen) => ({
      fen,
      category: 'win',
      dtz: 9,
      moves: [
        {
          uci: 'f1f4',
          san: 'Rf4',
          category: 'loss',
          dtz: -8,
          zeroing: false,
          checkmate: false,
          stalemate: false,
        },
      ],
    }));
    expect(await s().start(LUCENA.id)).toBe(true);
    await settled();
    expect(kit.lichess.probe).toHaveBeenCalled();
    expect(kit.lichess.probe.mock.calls[0]![0]).toBe(LUCENA.fen);
    expect(s().source).toBe('lichess');
    expect(s().status).toBe('running');
  });

  it('when lichess does not answer the rook lesson ends with the download offer', async () => {
    kit.setLichess(async () => null);
    await s().start(LUCENA.id);
    await settled();
    boardMove('f1f4');
    await settled();
    expect(s().status).toBe('idle');
    expect(s().needsPack).toBe('rook');
    expect(s().message).toMatch(/did not answer\. Needs the rook endgames download/);
    // The unjudged move was taken back.
    expect(useGameStore.getState().moves).toHaveLength(0);
  });

  it('setting off still runs lessons on local tables (never lichess)', async () => {
    installKit(kit, 'off');
    expect(await s().start(KQK.id)).toBe(true);
    expect(s().source).toBe('local');
  });

  it('no start during a human game', async () => {
    kit.lock.value = 'engine';
    const before = useGameStore.getState().startFen;
    expect(await s().start(KQK.id)).toBe(false);
    expect(s().status).toBe('idle');
    expect(s().lessonId).toBeUndefined();
    expect(s().message).toMatch(/^Lessons are paused: /);
    expect(useGameStore.getState().startFen).toBe(before);
  });
});

describe('integration with the board and the other trainers', () => {
  it('loading a PGN ends the lesson and restores the analysis', async () => {
    await s().start(KQK.id);
    await settled();
    expect(useAnalysisStore.getState().enabled).toBe(false);
    useGameStore.getState().loadPgn('1. e4 e5');
    expect(s().status).toBe('idle');
    expect(s().message).toBe('Lesson ended: another position was loaded.');
    expect(useAnalysisStore.getState().enabled).toBe(true);
    expect(lessonMovableColor(s(), true)).toBeUndefined();
  });

  it('an illegal-for-the-lesson board change ends it', async () => {
    await s().start(KQK.id);
    await settled();
    boardMove(best());
    await settled();
    // A move by the user is fine; an undo of the opponent's move is a foreign change.
    useGameStore.getState().undo();
    expect(s().status).toBe('idle');
    expect(s().message).toBe('Lesson ended: the board was changed.');
  });

  it('starting a puzzle stops the lesson, and starting a lesson stops the puzzle', async () => {
    await s().start(KQK.id);
    await settled();
    usePuzzleStore.getState().start(MATE);
    expect(s().status).toBe('idle');
    expect(s().lessonId).toBeUndefined();
    expect(usePuzzleStore.getState().status).toBe('running');

    await s().start(KQK.id);
    expect(usePuzzleStore.getState().status).toBe('idle');
    expect(s().status).toBe('running');
  });

  it('stopEndgameLesson (puzzles, drill) ends a running lesson silently', async () => {
    await s().start(KQK.id);
    await settled();
    stopEndgameLesson();
    expect(s().status).toBe('idle');
    expect(s().message).toBeUndefined();
  });

  it('a human game starting during the lesson ends it', async () => {
    await s().start(KQK.id);
    await settled();
    kit.lock.value = 'live';
    // The lock watchers follow the play/live/room stores.
    const { usePlayStore } = await import('../play/playStore');
    usePlayStore.setState({});
    expect(s().status).toBe('idle');
    expect(s().message).toMatch(/^Lesson ended: /);
  });
});

describe('course navigation', () => {
  it('nextLesson goes in course order; trainDue starts the earliest due lesson', async () => {
    await s().start(KQK.id);
    await settled();
    await s().nextLesson();
    expect(s().lessonId).toBe(LESSONS[1]!.id);
    s().stop();
    expect(await s().trainDue()).toBe(false);
    // A failed attempt makes the lesson due.
    await s().start(KQK.id);
    await settled();
    boardMove('b1e4');
    await settled();
    s().stop();
    expect(await s().trainDue()).toBe(true);
    expect(s().lessonId).toBe(KQK.id);
  });

  it('stop returns to the course list', async () => {
    await s().start(KQK.id);
    await settled();
    s().stop();
    expect(s().lessonId).toBeUndefined();
    expect(s().game).toBeUndefined();
    expect(lessonStatusLine(s())).toBe('Choose a lesson.');
  });
});
