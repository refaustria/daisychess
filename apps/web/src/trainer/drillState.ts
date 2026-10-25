import type { Orientation } from '../store/gameStore';
import type { BookOpening } from '../openings/book';
import type { ReviewEngineInfo } from '../review/reviewStore';
import type { Schedule } from './schedule';
import { create } from 'zustand';

/*
 * State of the openings drill, small enough for the main chunk (board, player bars). The flow
 * (book, engine checks, schedule) lives in `drillStore.ts`, which is loaded with the Openings tab
 * and installs the real actions into this store; until then the actions do nothing.
 */

export type DrillColorChoice = Orientation | 'both';
export type DrillStatus = 'idle' | 'running' | 'done';
/**
 * `user`: the user has the move; `app`: a book move is about to be played; `checking`: the engine
 * checks the user's deviation; `retry`: the user's move was rejected, waiting for "Try again".
 */
export type DrillPhase = 'user' | 'app' | 'checking' | 'retry' | 'none';

export type DrillFeedback =
  | { kind: 'start'; text: string }
  | { kind: 'book'; san: string; name?: string }
  | { kind: 'app'; san: string; name?: string }
  /** A book move of another variation while the drill is still on the way to its variation. */
  | { kind: 'otherLine'; san: string; name?: string; expected: string }
  | { kind: 'checking'; san: string }
  /** Not book but within {@link FINE_THRESHOLD_CP}; `retry` while still before the variation. */
  | { kind: 'fine'; san: string; eval: string; retry: boolean; expected?: string }
  | {
      kind: 'mistake';
      san: string;
      playedUci: string;
      playedEval: string;
      bestEval: string;
      lossCp: number;
      bestSan?: string;
      bestUci?: string;
      /** First moves of the engine's line from the position before the move (SAN). */
      pvSan: string[];
      /** Same line with move numbers. */
      pvText: string;
      pvUci: string[];
    }
  | { kind: 'error'; san: string; message: string }
  | { kind: 'retry'; san: string };

export type DrillEndReason = 'end' | 'outOfBook';

/**
 * What follows the end of the book (M23-2): `stop` shows the summary (default); `stockfish` or a
 * Maia level (`maia-1500`, the server engine id) continues at once with a game against it from
 * the drill's position. "Play on vs engine" uses the same opponent.
 */
export type DrillAfterBook = 'stop' | 'stockfish' | `maia-${number}`;

export interface DrillSummary {
  reason: DrillEndReason;
  /** User moves accepted. */
  userMoves: number;
  /** User moves accepted without a mistake at that move. */
  firstTry: number;
  mistakes: number;
  /** Variation name at the end of the drill. */
  reached?: string;
}

export interface DrillState {
  status: DrillStatus;
  phase: DrillPhase;
  /** The drilled variation. */
  opening?: BookOpening;
  colorChoice: DrillColorChoice;
  userColor: Orientation;
  /** Accepted SAN moves of the drill so far (both sides). */
  line: string[];
  feedback?: DrillFeedback;
  /** Variation reached so far ("Book: …"). */
  current?: string;
  userMoves: number;
  firstTry: number;
  mistakes: number;
  summary?: DrillSummary;
  /** Why the drill could not start or was ended (lock, board changed). */
  message?: string;
  /** Engine of the checks (after the first check). */
  runsOn?: ReviewEngineInfo;
  engineNotice?: string;
  /** Spaced repetition per variation (localStorage `daisychess.trainer`). */
  schedule: Schedule;
  /** After the book (localStorage `daisychess.drillAfterBook`). */
  afterBook: DrillAfterBook;
}

export interface DrillActions {
  /** Starts a drill of `opening` (resets the board). Refused during live, room or engine games. */
  start(opening: BookOpening, color?: DrillColorChoice): void;
  setColorChoice(color: DrillColorChoice): void;
  /** Chooses what follows the end of the book (persisted). */
  setAfterBook(after: DrillAfterBook): void;
  /** Takes back the rejected move (phase `retry`). */
  retry(): void;
  /** Ends the drill without recording a result; the board keeps the position. */
  stop(message?: string): void;
  /** Same variation again (colours alternate with `both`). */
  repeat(): void;
  /** The next variation of the table after the current one. */
  next(): void;
  /** Starts the earliest-due variation; false when none is due. */
  trainDue(): boolean;
  /**
   * Hand-off to the Play tab with the drill's game on the board (M18-2), against the
   * {@link DrillState.afterBook} opponent (`stop`: the Play tab's last setup).
   */
  playOn(): void;
}

export type DrillStore = DrillState & DrillActions;

const noop = (): void => undefined;

export const useDrillStore = create<DrillStore>()(() => ({
  status: 'idle',
  phase: 'none',
  colorChoice: 'white',
  userColor: 'white',
  line: [],
  userMoves: 0,
  firstTry: 0,
  mistakes: 0,
  schedule: {},
  afterBook: 'stop',
  start: noop,
  setColorChoice: noop,
  setAfterBook: noop,
  retry: noop,
  stop: noop,
  repeat: noop,
  next: noop,
  trainDue: () => false,
  playOn: noop,
}));

/** Move resolution for the board while drilling: who may move (see `Board.movableColor`). */
export function drillMovableColor(
  s: Pick<DrillState, 'status' | 'phase' | 'userColor'>,
  atTip: boolean,
): Orientation | null | undefined {
  if (s.status !== 'running') return undefined;
  return s.phase === 'user' && atTip ? s.userColor : null;
}

/** Player bars during a drill: "You" and "Book (<variation>)", no clocks. */
export function drillPlayers(
  s: Pick<DrillState, 'status' | 'userColor' | 'opening'>,
): { white: { name: string }; black: { name: string } } | undefined {
  if (s.status !== 'running' || !s.opening) return undefined;
  const you = { name: 'You' };
  const book = { name: `Book (${s.opening.name})` };
  return s.userColor === 'white' ? { white: you, black: book } : { white: book, black: you };
}

/** UCI arrows for the board: the rejected move (red) and the engine's best move (green). */
export function drillArrows(f: DrillFeedback | undefined): { uci: string; brush: string }[] {
  if (!f || f.kind !== 'mistake') return [];
  const out = [{ uci: f.playedUci, brush: 'red' }];
  if (f.bestUci && f.bestUci !== f.playedUci) out.push({ uci: f.bestUci, brush: 'green' });
  return out;
}
