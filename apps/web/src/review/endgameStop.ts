import {
  endgameFamily,
  lessonGroupFor,
  puzzleThemeFor,
  type EndgameFamily,
  type EndgameTheme,
  type LessonGroup,
  type MaterialSignature,
  type TbScoreHint,
  type TbVerdict,
} from '@daisychess/endgames';
import type { Score } from '@daisychess/engine-core';
import type { EndgameFamilyText } from '../endgames/data/familyTexts';

/**
 * Content of the endgame stop of the guided review (M32-4, ADR-025 section 5). Pure.
 * The tour's `TourCard` (`review/tour.ts`) is the union of this card, the opening card and the
 * mistake card.
 */
export interface EndgameCard {
  kind: 'endgame';
  /** `Endgame: rook endgame` */
  title: string;
  /** `White: R+3P · Black: R+2P (White a pawn up)` */
  signature: string;
  family: EndgameFamily;
  /** The hand-written family text, when there is one (never a placeholder). */
  familyText?: string;
  /** The verdict sentence and, when the game's result disagrees with it, the result sentence. */
  sentences: string[];
  /** Lichess theme of the "Endgame puzzles" button. */
  puzzleTheme: EndgameTheme;
  /** Lesson group of the "Train this endgame" button, when the family has lessons. */
  lessonFamily?: LessonGroup;
}

/** Result of the game as in a PGN `Result` header. */
export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

/**
 * Exact result of the position from a tablebase (the shape of `TbScoreHint` of
 * `@daisychess/endgames`; only these fields are read). The hook for M32-3/M32-7.
 */
export type EndgameTb = Pick<TbScoreHint, 'result' | 'exact50'> & { mateIn?: number };

export interface EndgameCardInput {
  /** The position at the stop (after the stop's ply). */
  fen: string;
  signature: MaterialSignature;
  family: EndgameFamily;
  /** Hand-written text of the family; no text, no placeholder. */
  familyText?: EndgameFamilyText;
  /** Tablebase verdict of the position (only for positions with at most 7 pieces). */
  tb?: EndgameTb;
  /** Engine eval of the position, White's point of view; used without `tb`. */
  evalWhite?: Score;
  result?: GameResult;
  /** The side that made the stop's ply. */
  mover: 'white' | 'black';
}

const sideName = (s: 'white' | 'black'): string => (s === 'white' ? 'White' : 'Black');

const COUNT_WORDS = ['no', 'a', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

/** `White: R+3P · Black: R+2P (White a pawn up)`; the note only with an unequal pawn count. */
function signatureLine(sig: MaterialSignature, pawnsUp: number): string {
  const line = `White: ${sig.white} · Black: ${sig.black}`;
  if (pawnsUp === 0) return line;
  const n = Math.abs(pawnsUp);
  const word = COUNT_WORDS[n] ?? String(n);
  const noun = n === 1 ? 'pawn' : 'pawns';
  return `${line} (${pawnsUp > 0 ? 'White' : 'Black'} ${word} ${noun} up)`;
}

/** Bands of the engine eval in pawns: balanced, slightly better, winning chances, winning. */
export const EVAL_BALANCED = 0.5;
export const EVAL_SLIGHT = 1.5;
export const EVAL_CLEAR = 3.0;

type Outcome = 'white' | 'black' | 'draw';

interface Verdict {
  sentence: string;
  /** What the verdict claims about the game's outcome; undefined for an unsure one. */
  outcome?: Outcome;
}

function tbVerdict(tb: EndgameTb): Verdict {
  if (tb.result === 'draw') {
    return {
      sentence: tb.exact50 ? 'Tablebase: draw.' : 'Tablebase: draw (50-move rule).',
      outcome: 'draw',
    };
  }
  const who = sideName(tb.result);
  const mate = tb.mateIn !== undefined ? ` (mate in ${tb.mateIn})` : '';
  return { sentence: `Tablebase: ${who} wins${mate}.`, outcome: tb.result };
}

function evalVerdict(score: Score): Verdict {
  if ('mate' in score) {
    const who = score.mate > 0 ? 'white' : 'black';
    return {
      sentence: `The engine sees mate in ${Math.abs(score.mate)} for ${sideName(who)}.`,
      outcome: who,
    };
  }
  const pawns = score.cp / 100;
  const abs = Math.abs(pawns);
  const who = pawns > 0 ? 'white' : 'black';
  const num = `${pawns >= 0 ? '+' : '−'}${abs.toFixed(1)}`;
  if (abs < EVAL_BALANCED) {
    return { sentence: `The engine rates it ${num}: balanced.` };
  }
  const side = sideName(who);
  if (abs < EVAL_SLIGHT) {
    return { sentence: `The engine rates it ${num} for ${side}: a slight edge.` };
  }
  if (abs < EVAL_CLEAR) {
    return {
      sentence: `The engine rates it ${num} for ${side}: winning chances, not yet a win.`,
    };
  }
  return { sentence: `The engine rates it ${num} for ${side}: winning.`, outcome: who };
}

/** The sentence "Black won the game nevertheless." when result and verdict disagree. */
function resultSentence(outcome: Outcome | undefined, result: GameResult | undefined): string | undefined {
  if (!outcome || !result || result === '*') return undefined;
  const actual: Outcome = result === '1-0' ? 'white' : result === '0-1' ? 'black' : 'draw';
  if (actual === outcome) return undefined;
  return actual === 'draw'
    ? 'The game was drawn nevertheless.'
    : `${sideName(actual)} won the game nevertheless.`;
}

/** `Endgame: rook endgame`; just `Endgame` without a family text. */
function cardTitle(text?: EndgameFamilyText): string {
  if (!text || text.key === 'other') return 'Endgame';
  return `Endgame: ${text.title.charAt(0).toLowerCase()}${text.title.slice(1)}`;
}

export function endgameStopCard(input: EndgameCardInput): EndgameCard {
  const { pawnsUp } = endgameFamily(input.fen);
  const verdict = input.tb
    ? tbVerdict(input.tb)
    : input.evalWhite
      ? evalVerdict(input.evalWhite)
      : undefined;
  const sentences: string[] = [];
  if (verdict) sentences.push(verdict.sentence);
  const nevertheless = resultSentence(verdict?.outcome, input.result);
  if (nevertheless) sentences.push(nevertheless);
  const card: EndgameCard = {
    kind: 'endgame',
    title: cardTitle(input.familyText),
    signature: signatureLine(input.signature, pawnsUp),
    family: input.family,
    sentences,
    puzzleTheme: puzzleThemeFor(input.family),
  };
  if (input.familyText) card.familyText = input.familyText.text;
  const lesson = lessonGroupFor(input.family);
  if (lesson) card.lessonFamily = lesson;
  return card;
}

/**
 * The tablebase result of the position after `ply` from the overlay's verdicts (ADR-025 section 4,
 * `reviewStore.tablebase.verdicts`, keyed by the judged ply): the mover's own result after the
 * move when `ply` has a verdict, else the result before the next move (which also knows the mate
 * distance). Undefined when the overlay knows neither. `mover` is the side that played `ply`.
 */
export function tbAfterPly(
  verdicts: Readonly<Record<number, TbVerdict>> | undefined,
  ply: number,
  mover: 'white' | 'black',
): EndgameTb | undefined {
  if (!verdicts) return undefined;
  const next = verdicts[ply + 1];
  const own = verdicts[ply];
  const other = mover === 'white' ? 'black' : 'white';
  const toSide = (r: 'win' | 'draw' | 'loss', side: 'white' | 'black'): Outcome =>
    r === 'draw' ? 'draw' : (r === 'win') === (side === 'white') ? 'white' : 'black';
  if (next) {
    const result = toSide(next.before, other);
    const hint: EndgameTb = { result, exact50: true };
    if (result !== 'draw' && next.dtmBefore !== undefined) {
      hint.mateIn = Math.ceil(Math.abs(next.dtmBefore) / 2);
    }
    return hint;
  }
  if (own) return { result: toSide(own.after, mover), exact50: true };
  return undefined;
}
