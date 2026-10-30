import { buildContext, findRule, lineOf, sanLine, type Finding, type RuleContext } from './rules';
import type { ExplainArrow, ExplainInput, ExplainLine, Explanation } from './types';
import { fitSentences, headlineText, moverEvalText, sentencesFor, type ShownLine } from './wording';

export type {
  ArrowBrush,
  ExplainArrow,
  ExplainInput,
  ExplainLine,
  ExplainReply,
  ExplainRule,
  Explanation,
} from './types';
export { EXPLAIN_RULES } from './types';

/** Rules whose steppable line is the punishment line (what the opponent does next). */
const PUNISH_LINE_RULES: ReadonlySet<Finding['rule']> = new Set([
  'mate_allowed',
  'piece_hangs',
  'fork_allowed',
  'material_lost',
]);
/** Plies of the punishment line shown for `mate_allowed` (it ends earlier at the mate). */
export const MATE_LINE_PLIES = 6;

/**
 * The line a finding quotes and shows, in SAN with full chess.js legality (the only chess.js
 * `move()` replay of an explanation, ≤ 8 plies): the punishment line for rules 1/3/4/5, else
 * the best line.
 */
function shownLine(
  f: Finding,
  ctx: RuleContext,
  input: ExplainInput,
): ShownLine & { punish: boolean } {
  const punish = PUNISH_LINE_RULES.has(f.rule);
  const line = punish ? ctx.punish : ctx.best;
  const ucis = punish ? (input.reply ? lineOf(input.reply) : []) : lineOf(input.detail);
  const max = Math.min(line.moves.length, f.rule === 'mate_allowed' ? MATE_LINE_PLIES : Infinity);
  return { fen: line.fen, sans: sanLine(line.fen, ucis, max), punish };
}

/** Best move green, played move red, the threat yellow (a circle for a threatened unit). */
function arrowsOf(f: Finding, ctx: RuleContext): ExplainArrow[] {
  const arrows: ExplainArrow[] = [];
  const best = ctx.best.moves[0];
  if (best && best.lan !== ctx.played?.lan) arrows.push({ uci: best.lan, brush: 'green' });
  if (ctx.played) arrows.push({ uci: ctx.played.lan, brush: 'red' });
  const threat = ctx.punish.moves[0];
  switch (f.rule) {
    case 'piece_hangs':
      arrows.push({ uci: `${f.square}${f.square}`, brush: 'yellow' });
      break;
    case 'fork_allowed':
      arrows.push({ uci: f.fork.lan, brush: 'yellow' });
      for (const t of f.targets) arrows.push({ uci: `${t.square}${t.square}`, brush: 'yellow' });
      break;
    case 'mate_allowed':
    case 'material_lost':
      if (threat) arrows.push({ uci: threat.lan, brush: 'yellow' });
      break;
    default:
      break;
  }
  return arrows;
}

/**
 * Rule-based explanation of a mistake (ADR-024 §4): the first of the eight rules that applies
 * (mate_allowed → mate_missed → piece_hangs → fork_allowed → material_lost → missed_capture →
 * missed_tactic → eval_drop), its sentences, a steppable line and board arrows. Pure and
 * offline; the punishment line is `details[ply + 1]`, passed by the caller as `reply`.
 */
export function explainMistake(input: ExplainInput): Explanation {
  const { detail } = input;
  const headline = headlineText(detail, input.timeTrouble === true);
  const ctx = buildContext(input);
  if (!ctx) {
    // Unreadable positions (corrupt record): the eval sentence only, no line or arrows.
    const after = moverEvalText(detail.evalAfterWhite, detail.mover);
    const sentence = detail.bestSan
      ? `Better was ${detail.bestSan}; after ${detail.playedSan} it is ${after}.`
      : `After ${detail.playedSan} the position is ${after}.`;
    return { rule: 'eval_drop', headline, sentences: fitSentences([sentence]), arrows: [] };
  }
  const finding = findRule(ctx);
  const shown = shownLine(finding, ctx, input);
  const line: ExplainLine | undefined =
    shown.sans.length > 0
      ? {
          fen: shown.fen,
          sans: [...shown.sans],
          label: shown.punish ? `What happens after ${detail.playedSan}` : 'Best line',
        }
      : undefined;
  return {
    rule: finding.rule,
    headline,
    sentences: fitSentences(sentencesFor(finding, ctx, detail, shown)),
    ...(line ? { line } : {}),
    arrows: arrowsOf(finding, ctx),
  };
}
