import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  cutSolution,
  mistakeCandidates,
  mistakeId,
  scoreFor,
  winProbability,
  type CutDecision,
  type MistakeCandidate,
  type MistakeMoveDetail,
  type SearchResult,
} from './mistakes.js';
import { sha256Hex } from './sha256.js';
import type { Score } from './schemas.js';

/** Review details of a SAN game; `marks[ply]` overrides fields of that ply. */
function review(sans: string[], marks: Record<number, Partial<MistakeMoveDetail>>) {
  const chess = new Chess();
  const moveDetails: Record<number, MistakeMoveDetail> = {};
  sans.forEach((san, i) => {
    const ply = i + 1;
    const fenBefore = chess.fen();
    const m = chess.move(san);
    moveDetails[ply] = {
      ply,
      mover: m.color === 'w' ? 'white' : 'black',
      classification: 'best',
      playedUci: m.lan,
      fenBefore,
      evalBeforeWhite: { cp: 20 },
      evalAfterWhite: { cp: 20 },
      ...marks[ply],
    };
  });
  return { moveDetails };
}

describe('winProbability / scoreFor', () => {
  it('maps scores to the lichess win probability of their side', () => {
    expect(winProbability({ cp: 0 })).toBeCloseTo(50, 6);
    expect(winProbability({ cp: 300 })).toBeGreaterThan(75);
    expect(winProbability({ mate: 3 })).toBe(100);
    expect(winProbability({ mate: -2 })).toBe(0);
    expect(winProbability({ mate: 0 })).toBe(0);
    expect(scoreFor({ cp: 120 }, 'black')).toEqual({ cp: -120 });
    expect(scoreFor({ mate: 2 }, 'black')).toEqual({ mate: -2 });
    expect(scoreFor({ cp: 120 }, 'white')).toEqual({ cp: 120 });
  });
});

describe('mistakeId', () => {
  it('is m: plus 16 hex of sha256(fen)', () => {
    expect(mistakeId('x')).toBe(`m:${sha256Hex('x').slice(0, 16)}`);
  });
});

describe('mistakeCandidates', () => {
  const sans = ['e4', 'e5', 'Nf3', 'f6', 'Nxe5', 'fxe5', 'Qh5+', 'Ke7'];
  it("takes the user's mistakes and blunders with the opponent's previous move as intro", () => {
    const r = review(sans, {
      4: { classification: 'mistake', bestUci: 'b8c6', evalAfterWhite: { cp: 150 } },
      6: { classification: 'blunder', bestUci: 'd8e7', evalIfBest: { cp: 100 } },
      8: { classification: 'inaccuracy', bestUci: 'g7g6' },
      5: { classification: 'blunder', bestUci: 'd2d4' }, // opponent's
    });
    const c = mistakeCandidates(r, 'black');
    expect(c.map((x) => x.ply)).toEqual([4, 6]);
    const first = c[0]!;
    expect(first).toMatchObject({
      ply: 4,
      userSide: 'black',
      intro: 'g1f3',
      fen: r.moveDetails[3]!.fenBefore,
      mistakeFen: r.moveDetails[4]!.fenBefore,
      bestUci: 'b8c6',
      playedUci: 'f7f6',
      classification: 'mistake',
    });
    expect(first.id).toBe(mistakeId(r.moveDetails[4]!.fenBefore));
  });

  it('excludes positions where the best move is itself losing and deduplicates by position', () => {
    const r = review(sans, {
      4: { classification: 'blunder', bestUci: 'b8c6', evalIfBest: { cp: 900 } }, // black: −9
      6: { classification: 'blunder', bestUci: 'd8e7', evalIfBest: { mate: 3 } },
    });
    expect(mistakeCandidates(r, 'black')).toEqual([]);
    const dup = review(['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6'], {
      2: { classification: 'mistake', bestUci: 'd7d5' },
      6: { classification: 'mistake', bestUci: 'd7d5' },
    });
    // the positions before ply 2 and ply 6 differ only in the move counters
    expect(mistakeCandidates(dup, 'black').map((c) => c.ply)).toEqual([2, 6]);
    const same = { moveDetails: { 2: dup.moveDetails[2]!, 3: { ...dup.moveDetails[2]!, ply: 3 } } };
    expect(mistakeCandidates(same, 'black').map((c) => c.ply)).toEqual([2]);
  });

  it('has no intro at ply 1, without a previous detail or when it does not lead to the position', () => {
    const r = review(['f3', 'e5', 'g4'], {
      1: { classification: 'blunder', bestUci: 'e2e4' },
      3: { classification: 'blunder', bestUci: 'e2e4' },
    });
    const c = mistakeCandidates(r, 'white');
    expect(c[0]).toMatchObject({ ply: 1, fen: r.moveDetails[1]!.fenBefore });
    expect(c[0]!.intro).toBeUndefined();
    expect(c[1]!.intro).toBe('e7e5');
    const gap = { moveDetails: { 3: r.moveDetails[3]! } };
    expect(mistakeCandidates(gap, 'white')[0]!.intro).toBeUndefined();
    const wrong = {
      moveDetails: { 2: { ...r.moveDetails[2]!, playedUci: 'd7d5' }, 3: r.moveDetails[3]! },
    };
    expect(mistakeCandidates(wrong, 'white')[0]!.intro).toBeUndefined();
    expect(mistakeCandidates(r, 'black')).toEqual([]);
  });
});

// lichess puzzle 00008 as a mistake: after Bxg3 White must find Re7! (the user is White).
const START = 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24';
const after = (fen: string, ...ucis: string[]): string => {
  const c = new Chess(fen);
  for (const u of ucis) c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
  return c.fen();
};
const MISTAKE = after(START, 'f2g3');
const cand: MistakeCandidate = {
  id: mistakeId(MISTAKE),
  ply: 48,
  userSide: 'white',
  fen: START,
  intro: 'f2g3',
  mistakeFen: MISTAKE,
  bestUci: 'e6e7',
  playedUci: 'h2g3',
  classification: 'blunder',
  evalBeforeWhite: { cp: 600 },
  evalAfterWhite: { cp: -300 },
};
const LINE = ['e6e7', 'b2b1', 'b3c1', 'b1c1', 'h6c1'];
const res = (fen: string, ...lines: [string[], Score][]): SearchResult => ({
  fen,
  lines: lines.map(([pv, score]) => ({ pv, score })),
});
const startRes = res(MISTAKE, [LINE, { cp: 600 }], [['h2g3'], { cp: -300 }]);
const reply1 = (second: Score = { cp: -1200 }) =>
  res(after(MISTAKE, 'e6e7'), [LINE.slice(1), { cp: -600 }], [['e7e8'], second]);
const reply2 = (best: Score = { cp: -600 }) =>
  res(after(MISTAKE, ...LINE.slice(0, 3)), [LINE.slice(3), best], [['b1a1'], { cp: -2000 }]);
const finalRes = (score: Score) => res(after(MISTAKE, ...LINE), [['h7h6'], score]);

/** Drives `cutSolution` like the generator: answers each requested search from `answers`. */
function drive(
  c: MistakeCandidate,
  answers: SearchResult[],
): { decision: CutDecision; asked: string[] } {
  const supplied: SearchResult[] = [];
  const asked: string[] = [];
  for (;;) {
    const d = cutSolution(c, supplied);
    if (d.type !== 'search') return { decision: d, asked };
    asked.push(`${d.purpose}:${d.multipv}`);
    const a = answers.find((r) => r.fen === d.fen);
    if (!a) throw new Error(`unexpected search ${d.purpose} ${d.fen}`);
    supplied.push(a);
  }
}

describe('cutSolution', () => {
  it('asks for the start search first', () => {
    expect(cutSolution(cand, [])).toEqual({
      type: 'search',
      fen: MISTAKE,
      multipv: 2,
      purpose: 'start',
    });
  });

  it('follows forced replies up to 3 user moves and checks the final eval', () => {
    const { decision, asked } = drive(cand, [startRes, reply1(), reply2(), finalRes({ cp: -620 })]);
    expect(asked).toEqual(['start:2', 'reply:2', 'reply:2', 'final:1']);
    expect(decision).toMatchObject({ type: 'accept', solution: LINE, userMoves: 3 });
    if (decision.type !== 'accept') throw new Error();
    expect(decision.puzzle).toEqual({
      id: cand.id,
      fen: START,
      moves: ['f2g3', ...LINE],
      themes: [],
      openings: [],
      source: 'mistake',
    });
  });

  it('cuts before a reply that is not forced', () => {
    const { decision, asked } = drive(cand, [startRes, reply1({ cp: -650 })]);
    expect(asked).toEqual(['start:2', 'reply:2']);
    expect(decision).toMatchObject({ type: 'accept', solution: ['e6e7'], userMoves: 1 });
  });

  it('uses the shortest cut that holds the eval when the full line drifts', () => {
    const { decision } = drive(cand, [startRes, reply1(), reply2(), finalRes({ cp: -100 })]);
    expect(decision).toMatchObject({ type: 'accept', solution: ['e6e7'] });
    const drift = drive(cand, [startRes, reply1(), reply2({ cp: -100 }), finalRes({ cp: -100 })]);
    // cut 1 eval comes from reply 1 (+600): still fine
    expect(drift.decision).toMatchObject({ type: 'accept', solution: ['e6e7'] });
    const bad = res(
      after(MISTAKE, 'e6e7'),
      [LINE.slice(1), { cp: -100 }],
      [['e7e8'], { cp: -1200 }],
    );
    const none = drive(cand, [startRes, bad, reply2({ cp: -100 }), finalRes({ cp: -100 })]);
    expect(none.decision).toEqual({ type: 'skip', reason: 'eval-drift' });
  });

  it('skips when the best move is not clearly better than the second best', () => {
    expect(cutSolution(cand, [res(MISTAKE, [LINE, { cp: 600 }], [['h2g3'], { cp: 540 }])])).toEqual(
      {
        type: 'skip',
        reason: 'not-clear',
      },
    );
    // ≥ 80 cp but < 10 win-probability points (both far ahead)
    expect(
      cutSolution(cand, [res(MISTAKE, [LINE, { cp: 1500 }], [['h2g3'], { cp: 1300 }])]).type,
    ).toBe('skip');
    // two mates: ambiguous
    expect(
      cutSolution(cand, [res(MISTAKE, [LINE, { mate: 3 }], [['h2g3'], { mate: 5 }])]).type,
    ).toBe('skip');
    // a single line while other moves exist
    expect(cutSolution(cand, [res(MISTAKE, [LINE, { cp: 600 }])])).toEqual({
      type: 'skip',
      reason: 'not-clear',
    });
    expect(cutSolution(cand, [res(MISTAKE)])).toEqual({ type: 'skip', reason: 'no-result' });
  });

  it('skips an only move and an illegal line', () => {
    // White king in check with a single legal move
    const only = '7k/8/8/8/8/8/6q1/7K w - - 0 1';
    const c = { ...cand, mistakeFen: only, fen: only, intro: undefined as string | undefined };
    delete c.intro;
    expect(cutSolution(c, [res(only, [['h1g2'], { cp: 0 }])])).toEqual({
      type: 'skip',
      reason: 'only-move',
    });
    expect(
      cutSolution(cand, [res(MISTAKE, [['a1a1'], { cp: 600 }], [['h2g3'], { cp: -300 }])]),
    ).toEqual({
      type: 'skip',
      reason: 'illegal-line',
    });
  });

  it('ends at mate without further searches and marks a puzzle without intro', () => {
    const fen = '6k1/5ppp/8/8/2n5/8/8/R5K1 w - - 1 2';
    const c: MistakeCandidate = { ...cand, id: mistakeId(fen), fen, mistakeFen: fen };
    delete c.intro;
    const d = cutSolution(c, [res(fen, [['a1a8'], { mate: 1 }], [['g1f1'], { cp: 0 }])]);
    expect(d).toMatchObject({ type: 'accept', solution: ['a1a8'], userMoves: 1 });
    if (d.type !== 'accept') throw new Error();
    expect(d.puzzle).toMatchObject({ moves: ['a1a8'], noIntro: true, source: 'mistake' });
  });

  it('ends when the line is exhausted and evaluates the last position', () => {
    const short = res(MISTAKE, [['e6e7'], { cp: 600 }], [['h2g3'], { cp: -300 }]);
    const { decision, asked } = drive(cand, [short, reply1()]);
    // pv has no reply: no reply search, but the end position needs an eval → final search
    expect(asked).toEqual(['start:2', 'final:1']);
    expect(decision).toMatchObject({ type: 'accept', solution: ['e6e7'] });
  });

  it('uses the reply search line when it differs from the start pv', () => {
    const alt = res(
      after(MISTAKE, 'e6e7'),
      [['b2b1', 'b3c1', 'b1c1', 'h6c1'], { cp: -600 }],
      [['e7e8'], { cp: -1200 }],
    );
    const startOther = res(MISTAKE, [['e6e7', 'h7h5'], { cp: 600 }], [['h2g3'], { cp: -300 }]);
    const { decision } = drive(cand, [startOther, alt, reply2(), finalRes({ cp: -600 })]);
    expect(decision).toMatchObject({ type: 'accept', solution: LINE });
  });
});
