import type { PieceSymbol, Square } from 'chess.js';
import type { Score } from '@daisychess/engine-core';
import type { MoveDetail } from '../details';
import { CLASS_INFO } from '../format';
import { attackerValue, moverMate, type Finding, type RuleContext, type Side } from './rules';

/**
 * Text templates of the explainer (ADR-024 §4 wording rules): English, present tense, SAN
 * everywhere, evals from the mover's point of view with an explicit sign, "mate in N" counting
 * the mating side's moves, never "you", at most 3 sentences and 280 characters together.
 * Sentences may start with a SAN move (`cxd5 misses b5.`): SAN is never capitalised.
 */

export const MINUS = '−';
export const MAX_SENTENCES = 3;
export const MAX_CHARS = 280;
/** Plies of a line quoted inside a sentence. */
export const SENTENCE_LINE_PLIES = 6;
/** Plies of the punishment line quoted for `material_lost`. */
export const MATERIAL_LINE_PLIES = 3;
/** Plies of the best line quoted for `missed_tactic`. */
export const TACTIC_LINE_PLIES = 4;

const PIECE_NAMES: Readonly<Record<PieceSymbol, string>> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

export const pieceName = (p: PieceSymbol): string => PIECE_NAMES[p];

/** `the knight on e5`. */
export const pieceOn = (p: PieceSymbol, sq: Square): string => `the ${pieceName(p)} on ${sq}`;

export const sideName = (s: Side): string => (s === 'white' ? 'White' : 'Black');
const opponent = (s: Side): Side => (s === 'white' ? 'black' : 'white');

/** Eval from the mover's point of view: `+1.4`, `−0.3`, `0.0`, `mate in 3`, `mate in 2 for Black`. */
export function moverEvalText(score: Score, mover: Side): string {
  if ('mate' in score) {
    if (score.mate === 0) return 'checkmate';
    const m = moverMate(score, mover)!;
    return m > 0 ? `mate in ${m}` : `mate in ${-m} for ${sideName(opponent(mover))}`;
  }
  const v = (mover === 'white' ? score.cp : -score.cp) / 100;
  const s = Math.abs(v).toFixed(1);
  if (s === '0.0') return '0.0';
  return `${v > 0 ? '+' : MINUS}${s}`;
}

/** SAN moves with move numbers from `fen`: `12. Nf3 Nc6 13. O-O` / `12... Nc6`. */
export function numberedLine(fen: string, sans: readonly string[]): string {
  const parts = fen.split(' ');
  let white = parts[1] !== 'b';
  let num = Number(parts[5]) || 1;
  const out: string[] = [];
  sans.forEach((san, i) => {
    if (white) out.push(`${num}. ${san}`);
    else out.push(i === 0 ? `${num}... ${san}` : san);
    if (!white) num++;
    white = !white;
  });
  return out.join(' ');
}

/** `Blunder (−41%)`; the loss only when it rounds to at least 1% (as the move card). */
export function classLabelText(d: Pick<MoveDetail, 'classification' | 'winProbLoss'>): string {
  const label = CLASS_INFO[d.classification].label;
  const loss = Math.round(d.winProbLoss);
  return loss >= 1 ? `${label} (${MINUS}${loss}%)` : label;
}

/** `12. Nxe5?? Blunder (−41%)`, plus ` (in time trouble)`. */
export function headlineText(d: MoveDetail, timeTrouble = false): string {
  const glyph = CLASS_INFO[d.classification].glyph;
  const trouble = timeTrouble ? ' (in time trouble)' : '';
  return `${d.moveLabel} ${d.playedSan}${glyph} ${classLabelText(d)}${trouble}`;
}

/** The line a finding quotes and shows: SAN moves (legal) from `fen`. */
export interface ShownLine {
  fen: string;
  sans: readonly string[];
}

/**
 * The sentences of a finding (before {@link fitSentences}). `shown` is the punishment line for
 * mate_allowed/piece_hangs/fork_allowed/material_lost and the best line for the other rules.
 */
export function sentencesFor(
  f: Finding,
  ctx: RuleContext,
  d: MoveDetail,
  shown: ShownLine,
): string[] {
  const played = d.playedSan;
  const betterWas = d.bestSan && d.bestSan !== played ? [`Better was ${d.bestSan}.`] : [];
  const quote = (plies: number): string => numberedLine(shown.fen, shown.sans.slice(0, plies));
  const afterEval = moverEvalText(ctx.evalAfter, ctx.mover);
  const ifBestEval = moverEvalText(ctx.evalIfBest, ctx.mover);
  const first = shown.sans[0];

  switch (f.rule) {
    case 'mate_allowed':
    case 'mate_missed': {
      const line = quote(Math.min(SENTENCE_LINE_PLIES, 2 * f.mateIn - 1));
      const verb = f.rule === 'mate_allowed' ? 'allows' : 'misses';
      const head = `${played} ${verb} mate in ${f.mateIn}`;
      const s = line ? `${head}: ${line}.` : `${head}.`;
      return f.rule === 'mate_allowed' ? [s, ...betterWas] : [s];
    }
    case 'piece_hangs': {
      const what = pieceOn(f.piece, f.square);
      const head = f.alreadyHanging ? `${played} does not save ${what}` : `${played} hangs ${what}`;
      const taker = shown.sans[f.capturePly];
      const tail = !taker
        ? '.'
        : f.capturePly === 0
          ? `: ${taker} takes it.`
          : `; after ${quote(f.capturePly + 1)} it is lost.`;
      return [head + tail, ...betterWas];
    }
    case 'fork_allowed': {
      const [a, b] = f.targets;
      const names = `the ${pieceName(a!.type)} and the ${pieceName(b!.type)}`;
      return [`${played} allows a fork: ${first ?? 'the reply'} attacks ${names}.`, ...betterWas];
    }
    case 'material_lost': {
      const line = quote(MATERIAL_LINE_PLIES);
      const s = f.piece
        ? `${played} loses material: after ${line} the ${pieceName(f.piece)} is lost.`
        : `${played} loses about ${Math.round(f.loss)} pawns of material after ${line}.`;
      return [s, ...betterWas];
    }
    case 'missed_capture': {
      const c = f.capture;
      const captured = c.captured!;
      const wins = f.free
        ? `wins ${captured === 'p' ? 'a pawn' : `the ${pieceName(captured)}`}`
        : captured !== 'p' && attackerValue(c.piece) < attackerValue(captured)
          ? `wins the ${pieceName(captured)} for the ${pieceName(c.piece)}`
          : `wins about ${Math.max(2, Math.round(f.gain))} pawns of material`;
      return [
        `${played} misses ${first ?? d.bestSan ?? 'a capture'}, which ${wins}.`,
        `After ${played} the position is ${afterEval} instead of ${ifBestEval}.`,
      ];
    }
    case 'missed_tactic': {
      const line = quote(TACTIC_LINE_PLIES);
      return [
        `${played} misses ${first ?? d.bestSan ?? 'a stronger move'}: after ${line} the position is ${ifBestEval}.`,
        `After ${played} it is ${afterEval}.`,
      ];
    }
    case 'eval_drop': {
      if (!d.bestSan || d.bestSan === played) {
        const was = moverEvalText(ctx.evalBefore, ctx.mover);
        return [`After ${played} the position is ${afterEval} (it was ${was}).`];
      }
      return [
        `Better was ${d.bestSan}, which keeps ${ifBestEval}; after ${played} it is ${afterEval}.`,
      ];
    }
  }
}

/**
 * Enforces the size rules: at most {@link MAX_SENTENCES} sentences and {@link MAX_CHARS}
 * characters together (joined with a space); trailing sentences go first, a single overlong
 * sentence is cut at a word boundary with an ellipsis.
 */
export function fitSentences(sentences: readonly string[]): string[] {
  const out = sentences.filter((s) => s.length > 0).slice(0, MAX_SENTENCES);
  const total = (): number => out.join(' ').length;
  while (out.length > 1 && total() > MAX_CHARS) out.pop();
  if (out.length === 1 && out[0]!.length > MAX_CHARS) {
    const cut = out[0]!.slice(0, MAX_CHARS - 1);
    const space = cut.lastIndexOf(' ');
    out[0] = `${space > MAX_CHARS / 2 ? cut.slice(0, space) : cut}…`;
  }
  return out;
}
