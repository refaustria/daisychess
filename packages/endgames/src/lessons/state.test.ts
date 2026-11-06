import { describe, expect, it } from 'vitest';
import type { TbCategory, TbMove, TbPosition } from '../tablebase/types.js';
import { LessonSchema, type Lesson } from './schema.js';
import { budgetLeft, initialLesson, lessonState, shownHints, type LessonState } from './state.js';

const mv = (uci: string, category: TbCategory, extra: Partial<TbMove> = {}): TbMove => ({
  uci,
  san: uci,
  category,
  zeroing: false,
  checkmate: false,
  stalemate: false,
  ...extra,
});

/** K+Q vs K: Qa8# mates, Qf7 stalemates, Qb2+ keeps the win. */
const WIN_FEN = '7k/8/6K1/8/8/8/Q7/8 w - - 0 1';
const winLesson = (budget = 3): Lesson =>
  LessonSchema.parse({
    id: 'kq-vs-k',
    group: 'basic_mates',
    title: 'K+Q vs K',
    fen: WIN_FEN,
    userSide: 'white',
    goal: 'win',
    budget,
    tables: ['KQvK'],
    text: 'Mate the king.',
    hints: ['Use the eighth rank.', 'Watch out for stalemate.'],
  });

const winTb: TbPosition = {
  fen: WIN_FEN,
  category: 'win',
  dtm: 1,
  dtz: 1,
  moves: [
    mv('a2a8', 'loss', { checkmate: true, dtm: 0, dtz: 0 }),
    mv('a2f7', 'draw', { stalemate: true }),
    mv('a2b2', 'loss', { dtm: -6, dtz: -6 }),
    mv('a2g8', 'draw', { zeroing: false }),
  ],
};

const drawLesson = (fen: string, budget = 2): Lesson =>
  LessonSchema.parse({
    id: 'kp-defend',
    group: 'king_pawn',
    title: 'K+P vs K — defend',
    fen,
    userSide: 'black',
    goal: 'draw',
    budget,
    tables: ['KPvK'],
    text: 'Stay in front of the pawn.',
    hints: ['Take the opposition.'],
  });

const KP_FEN = '4k3/8/4K3/4P3/8/8/8/8 b - - 0 1';

const started = (lesson: Lesson): LessonState => lessonState(lesson, { type: 'start' });

describe('lessonState: phases', () => {
  it('intro → user on start; other events are ignored in the intro', () => {
    const intro = initialLesson(winLesson());
    expect(intro).toMatchObject({
      phase: 'intro',
      fen: WIN_FEN,
      attempts: 1,
      mistakes: 0,
      hints: 0,
    });
    expect(lessonState(intro, { type: 'move', uci: 'a2a8' })).toBe(intro);
    expect(lessonState(intro, { type: 'restart' })).toBe(intro);
    const s = lessonState(intro, { type: 'start' });
    expect(s.phase).toBe('user');
    expect(lessonState(s, { type: 'start' })).toBe(s);
  });

  it('user → app → user with a kept move and the reply', () => {
    let s = started(winLesson(5));
    s = lessonState(s, { type: 'move', uci: 'a2b2', tb: winTb });
    expect(s).toMatchObject({ phase: 'app', userMoves: 1, played: ['a2b2'] });
    expect(s.verdict).toMatchObject({ kind: 'kept', before: 'win', after: 'win' });
    expect(lessonState(s, { type: 'move', uci: 'h8g8' })).toBe(s); // not the user's turn
    expect(lessonState(s, { type: 'reply', uci: 'h8h7' })).toBe(s); // illegal: Kg6 guards h7
    s = lessonState(s, { type: 'reply', uci: 'h8g8' });
    expect(s).toMatchObject({ phase: 'user', opponentMoves: 1, played: ['a2b2', 'h8g8'] });
    expect(budgetLeft(s)).toBe(4);
    expect(s.fens).toHaveLength(3);
  });

  it('ignores illegal and malformed user moves (same object)', () => {
    const s = started(winLesson());
    expect(lessonState(s, { type: 'move', uci: 'a2h9' })).toBe(s);
    expect(lessonState(s, { type: 'move', uci: 'h8g8' })).toBe(s);
    expect(lessonState(s, { type: 'reply', uci: 'h8g8' })).toBe(s);
  });
});

describe('lessonState: success and failure', () => {
  it('succeeds at checkmate', () => {
    const s = lessonState(started(winLesson()), { type: 'move', uci: 'a2a8', tb: winTb });
    expect(s).toMatchObject({ phase: 'done', outcome: 'success', reason: 'mate' });
  });

  it('fails at once on a thrown move; the move stays on the board', () => {
    const s = lessonState(started(winLesson()), { type: 'move', uci: 'a2f7', tb: winTb });
    expect(s).toMatchObject({
      phase: 'done',
      outcome: 'failure',
      reason: 'thrown',
      played: ['a2f7'],
    });
    expect(s.verdict).toMatchObject({ kind: 'thrown', after: 'draw', keepers: ['a2a8', 'a2b2'] });
  });

  it('fails at stalemate in a win lesson even without a tablebase', () => {
    const s = lessonState(started(winLesson()), { type: 'move', uci: 'a2f7' });
    expect(s).toMatchObject({ outcome: 'failure', reason: 'stalemate' });
    expect(s.verdict).toBeUndefined();
  });

  it('ignores a tablebase position for another FEN', () => {
    const s = lessonState(started(winLesson()), {
      type: 'move',
      uci: 'a2f7',
      tb: { ...winTb, fen: KP_FEN },
    });
    expect(s.reason).toBe('stalemate');
  });

  it('fails when the budget is used up', () => {
    let s = started(winLesson(2));
    s = lessonState(s, { type: 'move', uci: 'a2b2', tb: winTb });
    s = lessonState(s, { type: 'reply', uci: 'h8g8' });
    expect(budgetLeft(s)).toBe(1);
    s = lessonState(s, { type: 'move', uci: 'b2a2' });
    expect(s).toMatchObject({ phase: 'done', outcome: 'failure', reason: 'budget' });
    expect(budgetLeft(s)).toBe(0);
  });

  it('fails on threefold repetition in a win lesson', () => {
    let s = started(winLesson(20));
    for (let i = 0; i < 2; i++) {
      s = lessonState(s, { type: 'move', uci: 'a2b2' });
      s = lessonState(s, { type: 'reply', uci: 'h8g8' });
      s = lessonState(s, { type: 'move', uci: 'b2a2' });
      s = lessonState(s, { type: 'reply', uci: 'g8h8' });
    }
    expect(s).toMatchObject({ phase: 'done', outcome: 'failure', reason: 'repetition' });
  });

  it('fails when the opponent mates the user', () => {
    const lesson = drawLesson('k7/8/1K6/8/8/7Q/8/8 b - - 0 1');
    let s = lessonState(started(lesson), { type: 'move', uci: 'a8b8' });
    s = lessonState(s, { type: 'reply', uci: 'h3h8' });
    expect(s).toMatchObject({ phase: 'done', outcome: 'failure', reason: 'mated' });
  });

  it('draw lesson: held for the budget of opponent moves', () => {
    let s = started(drawLesson(KP_FEN, 2));
    s = lessonState(s, { type: 'move', uci: 'e8d8' });
    s = lessonState(s, { type: 'reply', uci: 'e6d6' });
    expect(s.phase).toBe('user');
    expect(budgetLeft(s)).toBe(1);
    s = lessonState(s, { type: 'move', uci: 'd8e8' });
    s = lessonState(s, { type: 'reply', uci: 'e5e6' });
    expect(s).toMatchObject({
      phase: 'done',
      outcome: 'success',
      reason: 'held',
      opponentMoves: 2,
    });
  });

  it('draw lesson: a tablebase draw with ≤ 3 pieces after the user move or the reply', () => {
    const tb: TbPosition = {
      fen: KP_FEN,
      category: 'draw',
      moves: [mv('e8d8', 'draw'), mv('e8f8', 'draw')],
    };
    const s = lessonState(started(drawLesson(KP_FEN, 9)), { type: 'move', uci: 'e8d8', tb });
    expect(s).toMatchObject({ outcome: 'success', reason: 'tablebaseDraw' });

    let r = lessonState(started(drawLesson(KP_FEN, 9)), { type: 'move', uci: 'e8f8' });
    expect(r.phase).toBe('app');
    const after = '5k2/8/3K4/4P3/8/8/8/8 b - - 2 2';
    r = lessonState(r, {
      type: 'reply',
      uci: 'e6d6',
      tb: { fen: after, category: 'draw', moves: [] },
    });
    expect(r).toMatchObject({ outcome: 'success', reason: 'tablebaseDraw' });
  });

  it('draw lesson: insufficient material is a success; a thrown move a failure', () => {
    const fen = '8/8/8/8/8/3k4/2P5/5K2 b - - 0 1';
    const s = lessonState(started(drawLesson(fen)), { type: 'move', uci: 'd3c2' });
    expect(s).toMatchObject({ outcome: 'success', reason: 'insufficient' });

    const tb: TbPosition = {
      fen: KP_FEN,
      category: 'draw',
      moves: [mv('e8d8', 'draw'), mv('e8e7', 'win')],
    };
    // e8e7 is illegal (Ke6 guards e7): ignored; the thrown verdict needs a legal move.
    const kp = started(drawLesson(KP_FEN));
    expect(lessonState(kp, { type: 'move', uci: 'e8e7', tb })).toBe(kp);
    const tb2: TbPosition = {
      fen: KP_FEN,
      category: 'draw',
      moves: [mv('e8d8', 'draw'), mv('e8f8', 'win')],
    };
    expect(lessonState(kp, { type: 'move', uci: 'e8f8', tb: tb2 })).toMatchObject({
      outcome: 'failure',
      reason: 'thrown',
    });
  });
});

describe('lessonState: take back, restart, hints', () => {
  it('take back returns to the position before the user’s last move (a mistake)', () => {
    let s = started(winLesson(5));
    s = lessonState(s, { type: 'move', uci: 'a2b2', tb: winTb });
    s = lessonState(s, { type: 'reply', uci: 'h8g8' });
    const before = s.fen;
    s = lessonState(s, { type: 'move', uci: 'b2b1' });
    expect(s.phase).toBe('app');
    s = lessonState(s, { type: 'reply', uci: 'g8h8' });
    s = lessonState(s, { type: 'move', uci: 'b1b2' }); // Qb2+ again
    expect(s.phase).toBe('app');
    // Take back in the app phase is not allowed.
    expect(lessonState(s, { type: 'takeBack' })).toBe(s);
    s = lessonState(s, { type: 'reply', uci: 'h8g8' });
    s = lessonState(s, { type: 'takeBack' });
    // Back before the second Qb2+: the reply is gone too.
    expect(s).toMatchObject({ phase: 'user', mistakes: 1, userMoves: 2, opponentMoves: 2 });
    expect(s.played).toEqual(['a2b2', 'h8g8', 'b2b1', 'g8h8']);
    s = lessonState(s, { type: 'takeBack' });
    expect(s.fen).toBe(before);
    expect(s).toMatchObject({ mistakes: 2, userMoves: 1, opponentMoves: 1 });
  });

  it('take back from a failure clears the outcome; from a success it is refused', () => {
    let s = lessonState(started(winLesson()), { type: 'move', uci: 'a2f7', tb: winTb });
    s = lessonState(s, { type: 'takeBack' });
    expect(s).toMatchObject({ phase: 'user', fen: WIN_FEN, mistakes: 1, userMoves: 0 });
    expect(s.outcome).toBeUndefined();
    expect(s.reason).toBeUndefined();
    expect(s.verdict).toBeUndefined();
    const won = lessonState(s, { type: 'move', uci: 'a2a8' });
    expect(lessonState(won, { type: 'takeBack' })).toBe(won);
    // Nothing to take back at the start.
    const fresh = started(winLesson());
    expect(lessonState(fresh, { type: 'takeBack' })).toBe(fresh);
  });

  it('restart goes back to the start as a new attempt, keeping the counters', () => {
    let s = started(winLesson());
    s = lessonState(s, { type: 'hint', tb: winTb });
    s = lessonState(s, { type: 'move', uci: 'a2f7', tb: winTb });
    s = lessonState(s, { type: 'takeBack' });
    s = lessonState(s, { type: 'move', uci: 'a2f7', tb: winTb });
    s = lessonState(s, { type: 'restart' });
    expect(s).toMatchObject({
      phase: 'user',
      fen: WIN_FEN,
      played: [],
      fens: [WIN_FEN],
      attempts: 2,
      mistakes: 1,
      hints: 1,
      hintIndex: 0,
    });
    expect(s.outcome).toBeUndefined();
  });

  it('hint reveals the next plan sentence and the best keeper’s piece; counts each hint', () => {
    let s = started(winLesson());
    expect(shownHints(s)).toEqual([]);
    s = lessonState(s, { type: 'hint', tb: winTb });
    expect(s).toMatchObject({ hints: 1, hintIndex: 1, hintSquare: 'a2' });
    expect(shownHints(s)).toEqual(['Use the eighth rank.']);
    s = lessonState(s, { type: 'hint' });
    s = lessonState(s, { type: 'hint' });
    expect(s).toMatchObject({ hints: 3, hintIndex: 2 });
    expect(shownHints(s)).toHaveLength(2);
    s = lessonState(s, { type: 'move', uci: 'a2b2', tb: winTb });
    expect(s.hintSquare).toBeUndefined();
    expect(lessonState(s, { type: 'hint' })).toBe(s); // app phase
  });

  it('show move draws the best keeper (needs the tablebase) and counts as a hint', () => {
    const s = started(winLesson());
    expect(lessonState(s, { type: 'showMove', tb: null })).toBe(s);
    const shown = lessonState(s, { type: 'showMove', tb: winTb });
    expect(shown).toMatchObject({ shownMove: 'a2a8', hints: 1 });
    expect(lessonState(shown, { type: 'move', uci: 'a2b2' }).shownMove).toBeUndefined();
  });
});

describe('budgetLeft', () => {
  it('counts user moves for win lessons and opponent moves for draw lessons', () => {
    expect(budgetLeft(started(winLesson(7)))).toBe(7);
    let d = started(drawLesson(KP_FEN, 3));
    d = lessonState(d, { type: 'move', uci: 'e8d8' });
    expect(budgetLeft(d)).toBe(3);
    d = lessonState(d, { type: 'reply', uci: 'e6d6' });
    expect(budgetLeft(d)).toBe(2);
  });
});
