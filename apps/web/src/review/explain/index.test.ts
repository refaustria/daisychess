import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { MoveDetail } from '../details';
import corpus from './corpus.fixture.json';
import { explainMistake, EXPLAIN_RULES, type Explanation, type ExplainInput } from './index';
import { buildContext, RULES } from './rules';
import { inputOf, legalLine, RULE_CASES } from './testPositions';
import { MAX_CHARS, MAX_SENTENCES } from './wording';

/** Every predicate (not only the first) that applies to an input. */
function firing(input: ExplainInput): string[] {
  const ctx = buildContext(input)!;
  return RULES.filter(([, p]) => p(ctx) !== undefined).map(([rule]) => rule);
}

describe('explainMistake: one position per rule (Stockfish lines, checked with chess.js)', () => {
  it.each(RULE_CASES.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const input = inputOf(c);
    const e = explainMistake(input);
    expect(e.rule).toBe(c.rule);
    expect(e.sentences).toEqual(c.sentences);
    // Exactly the listed predicates apply: no higher-priority rule fires, lower ones are documented.
    expect(firing(input)).toEqual(c.fires);
    // The selected rule is the first firing one in priority order.
    const order = (r: string): number => EXPLAIN_RULES.indexOf(r as (typeof EXPLAIN_RULES)[number]);
    for (const r of c.fires) expect(order(r)).toBeGreaterThanOrEqual(order(c.rule));
  });

  it('covers every rule', () => {
    expect(new Set(RULE_CASES.map((c) => c.rule))).toEqual(new Set(EXPLAIN_RULES));
  });

  it('every case before/after/line is chess-correct', () => {
    for (const c of RULE_CASES) {
      const { detail } = inputOf(c);
      const after = new Chess(detail.fenBefore);
      after.move(detail.playedSan);
      expect(after.fen()).toBe(detail.fenAfter);
      expect(detail.bestLineMoves).toEqual(legalLine(c.fen, c.best));
    }
  });
});

describe('explainMistake: the hanging-knight blunder', () => {
  const c = RULE_CASES.find((x) => x.name.startsWith('piece_hangs: 3. Nxe5'))!;
  const input = inputOf(c);
  const e = explainMistake(input);

  it('says which piece hangs where and how it is taken', () => {
    expect(e.headline).toBe('3. Nxe5?? Blunder (−40%)');
    expect(e.sentences[0]).toContain('hangs the knight on e5');
    expect(e.sentences[0]).toContain('dxe5 takes it');
  });

  it('draws best (green), played (red) and the threatened knight (yellow circle)', () => {
    expect(e.arrows).toEqual([
      { uci: 'd2d4', brush: 'green' },
      { uci: 'f3e5', brush: 'red' },
      { uci: 'e5e5', brush: 'yellow' },
    ]);
  });

  it('offers the punishment line (details[ply + 1]) from the position after the move', () => {
    expect(e.line).toEqual({
      fen: input.detail.fenAfter,
      sans: input.reply!.bestLineMoves,
      label: 'What happens after Nxe5',
    });
  });
});

describe('explainMistake: lines and arrows per rule', () => {
  const byName = (prefix: string): Explanation =>
    explainMistake(inputOf(RULE_CASES.find((x) => x.name.startsWith(prefix))!));

  it('a missed mate shows the best line', () => {
    const e = byName('mate_missed');
    expect(e.line).toEqual({
      fen: '6k1/5ppp/8/n7/8/8/5PPP/4R1K1 w - - 0 1',
      sans: ['Re8#'],
      label: 'Best line',
    });
    expect(e.arrows).toEqual([
      { uci: 'e1e8', brush: 'green' },
      { uci: 'h2h3', brush: 'red' },
    ]);
  });

  it('an allowed mate shows the punishment line up to the mate', () => {
    const e = byName('priority: the rook on e8');
    expect(e.line?.sans).toEqual(['Rxe8+', 'Bf8', 'Rxf8#']);
    expect(e.line?.label).toBe('What happens after Qd4');
    expect(new Chess(e.line!.fen).fen()).toBe(e.line!.fen);
    const end = new Chess(e.line!.fen);
    for (const san of e.line!.sans) end.move(san);
    expect(end.isCheckmate()).toBe(true);
    expect(e.arrows).toContainEqual({ uci: 'e1e8', brush: 'yellow' });
  });

  it('a fork circles both targets and draws the forking move', () => {
    const e = byName('fork_allowed');
    expect(e.arrows).toEqual([
      { uci: 'e8g8', brush: 'green' },
      { uci: 'd8g5', brush: 'red' },
      { uci: 'b5c7', brush: 'yellow' },
      { uci: 'e8e8', brush: 'yellow' },
      { uci: 'a8a8', brush: 'yellow' },
    ]);
    expect(e.line?.label).toBe('What happens after Qg5');
  });

  it('material loss uses the punishment line, missed capture/tactic and eval drop the best line', () => {
    expect(byName('material_lost').line?.label).toBe('What happens after Kd7');
    expect(byName('missed_capture').line?.label).toBe('Best line');
    expect(byName('missed_tactic').line?.label).toBe('Best line');
    expect(byName('eval_drop: 2. a3').line?.sans[0]).toBe('Nf3');
  });

  it('appends "(in time trouble)" to the headline', () => {
    const c = RULE_CASES.find((x) => x.rule === 'eval_drop')!;
    const e = explainMistake({ ...inputOf(c), timeTrouble: true });
    expect(e.headline).toBe('2. a3?! Inaccuracy (−3%) (in time trouble)');
  });
});

describe('explainMistake: degraded inputs', () => {
  const hang = RULE_CASES.find((x) => x.name.startsWith('piece_hangs: 3. Nxe5'))!;

  it('without a reply (last move of the game) the punishment rules cannot fire', () => {
    const { detail } = inputOf(hang);
    const e = explainMistake({ detail });
    expect(e.rule).toBe('missed_tactic');
    expect(e.line?.label).toBe('Best line');
  });

  it('an allowed mate without a reply still names the mate, without a line', () => {
    const c = RULE_CASES.find((x) => x.name.startsWith('mate_allowed'))!;
    const e = explainMistake({ detail: inputOf(c).detail });
    expect(e.rule).toBe('mate_allowed');
    expect(e.sentences).toEqual(['Nf6 allows mate in 1.', 'Better was g6.']);
    expect(e.line).toBeUndefined();
  });

  it('a stale reply line (illegal from fenAfter) is cut at the first illegal move', () => {
    const input = inputOf(hang);
    const e = explainMistake({
      ...input,
      reply: { ...input.reply!, bestLine: ['d6e5', 'e1e2', 'a1a8'] },
    });
    expect(e.line?.sans).toEqual(['dxe5', 'Ke2']);
  });

  it('an unreadable FEN falls back to the eval sentence', () => {
    const { detail } = inputOf(hang);
    const e = explainMistake({ detail: { ...detail, fenBefore: 'garbage' } });
    expect(e.rule).toBe('eval_drop');
    expect(e.sentences).toEqual(['Better was d4; after Nxe5 it is −6.1.']);
    expect(e.arrows).toEqual([]);
    expect(e.line).toBeUndefined();
  });
});

interface CorpusPair {
  detail: MoveDetail;
  reply: MoveDetail;
}
const PAIRS = corpus as CorpusPair[];

/** UCI-looking tokens (`e2e4`, `e7e8q`), which must never reach a sentence. */
const UCI_TOKEN = /\b[a-h][1-8][a-h][1-8][qrbn]?\b/;
/** A decimal eval without a sign (only `0.0` may stand alone). */
const UNSIGNED_EVAL = /(?<![+−\d.])(\d+\.\d+)/g;

describe('explainMistake: wording invariants on a real review (20 MoveDetail pairs)', () => {
  const explained = PAIRS.map((p) => ({
    p,
    e: explainMistake({ detail: p.detail, reply: p.reply }),
  }));

  it('the fixture is 20 mistakes of a Stockfish review with their next-ply details', () => {
    expect(PAIRS).toHaveLength(20);
    for (const { detail, reply } of PAIRS) {
      expect(['inaccuracy', 'mistake', 'blunder']).toContain(detail.classification);
      expect(reply.ply).toBe(detail.ply + 1);
      expect(reply.fenBefore).toBe(detail.fenAfter);
    }
  });

  it('exercises most rules', () => {
    expect(new Set(explained.map(({ e }) => e.rule)).size).toBeGreaterThanOrEqual(6);
  });

  it.each(PAIRS.map((p, i) => [i, p] as const))('pair %i', (_, p) => {
    const e = explainMistake({ detail: p.detail, reply: p.reply });
    expect(e.sentences.length).toBeGreaterThanOrEqual(1);
    expect(e.sentences.length).toBeLessThanOrEqual(MAX_SENTENCES);
    expect(e.sentences.join(' ').length).toBeLessThanOrEqual(MAX_CHARS);
    const text = [e.headline, ...e.sentences].join(' ');
    for (const s of e.sentences) expect(s.length).toBeLessThanOrEqual(280);
    expect(text).not.toMatch(/\byou\b|\byour\b/i);
    expect(text).not.toMatch(/engine/i);
    expect(text).not.toMatch(UCI_TOKEN);
    for (const m of e.sentences.join(' ').matchAll(UNSIGNED_EVAL)) expect(m[1]).toBe('0.0');
    expect(e.sentences.join(' ')).not.toMatch(/-\d/); // the minus sign is U+2212
    // Every SAN in the steppable line is legal from its start position.
    if (e.line) {
      const c = new Chess(e.line.fen);
      for (const san of e.line.sans) expect(c.move(san).san).toBe(san);
    }
    // Every arrow is a move of the board (or a circle).
    for (const a of e.arrows) expect(a.uci).toMatch(/^[a-h][1-8][a-h][1-8][qrbn]?$/);
  });

  it('runs in < 5 ms per position (bounded chess.js work)', () => {
    const inputs: ExplainInput[] = [
      ...PAIRS.map((p) => ({ detail: p.detail, reply: p.reply })),
      ...RULE_CASES.map(inputOf),
    ];
    for (const input of inputs) explainMistake(input); // warm-up (JIT, chess.js tables)
    for (const input of inputs) {
      let best = Infinity;
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        explainMistake(input);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best).toBeLessThan(5);
    }
  });
});
