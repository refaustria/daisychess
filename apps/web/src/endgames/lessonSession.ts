import type { LessonState } from '@daisychess/endgames';
import { create } from 'zustand';
import type { TbSource } from './tablebaseStore';
import type { OptInPack } from './tablePacks';
import { loadProgress, subscribeProgress, type EndgamesProgress } from './endgamesProgress';

/*
 * State of the endgame lesson session, small enough for the main chunk (board, keep-awake,
 * phone action bar). The flow (tablebase, opponent, progress) lives in `lessonStore.ts`, which is
 * loaded with the Endgames tab and installs the real actions into this store; until then the
 * actions do nothing (no lesson can run before the tab was opened).
 */

export type LessonStatus =
  /** No session (the board is free); a finished or ended lesson may still be shown. */
  | 'idle'
  /** Checking the tables of the chosen lesson. */
  | 'starting'
  /** The lesson runs (the user's turn, judging, the opponent's reply). */
  | 'running'
  /** The lesson is over; the position stays until the next action or a board change. */
  | 'done';

/** The user's move that threw the result, with the move that would have kept it. */
export interface ThrownInfo {
  uci: string;
  san: string;
  keeperUci?: string;
  keeperSan?: string;
}

export interface LessonStoreState {
  status: LessonStatus;
  /** The lesson shown by the panel (running, finished, blocked); undefined = the course list. */
  lessonId?: string;
  /** Reducer state of the current (or last) lesson. */
  game?: LessonState;
  /** Where the tablebase answers come from in this lesson. */
  source?: TbSource;
  /** Waiting for the tablebase (judging the user's move) or for the opponent. */
  thinking: boolean;
  thrown?: ThrownInfo;
  /** Why a lesson could not start or was ended. */
  message?: string;
  /** The lesson needs this opt-in pack to be played offline (the panel offers the download). */
  needsPack?: OptInPack;
  /** Feedback of the typed move input. */
  inputError?: string;
  progress: EndgamesProgress;
}

export interface LessonActions {
  /** Starts lesson `id`; resolves false when it was refused (lock, setting, tables). */
  start(id: string): Promise<boolean>;
  /** Plays a typed move (SAN); false when it is not legal or not the user's turn. */
  playSan(san: string): boolean;
  /** The next plan sentence and the piece of the best move (counts as a mistake). */
  hint(): Promise<void>;
  /** The best move as an arrow (counts as a mistake). */
  showMove(): Promise<void>;
  /** Back to the position before the user's last move (counts as a mistake). */
  takeBack(): void;
  /** From the start position again (a new attempt). */
  restart(): void;
  /** Ends the session; the panel returns to the course list. The board keeps its position. */
  stop(message?: string): void;
  /** Starts the lesson after the current one in the course order. */
  nextLesson(): Promise<boolean>;
  /** Starts the earliest due lesson; false when none is due. */
  trainDue(): Promise<boolean>;
}

export type LessonStore = LessonStoreState & LessonActions;

export const LESSON_HINT_TITLE = 'Shows the next idea and the piece to move. Counts as a mistake.';

const noop = (): void => undefined;
const no = (): Promise<boolean> => Promise.resolve(false);
const later = (): Promise<void> => Promise.resolve();

export const useLessonStore = create<LessonStore>()(() => ({
  status: 'idle',
  thinking: false,
  progress: loadProgress(),
  start: no,
  playSan: () => false,
  hint: later,
  showMove: later,
  takeBack: noop,
  restart: noop,
  stop: noop,
  nextLesson: no,
  trainDue: no,
}));

// Settings → "Reset endgame progress" and saves elsewhere.
subscribeProgress((progress) => {
  if (progress !== useLessonStore.getState().progress) useLessonStore.setState({ progress });
});

/** Who may move on the board during a lesson (see `Board.movableColor`); undefined = no session. */
export function lessonMovableColor(
  s: Pick<LessonStoreState, 'status' | 'game' | 'thinking'>,
  atTip: boolean,
): 'white' | 'black' | null | undefined {
  if (s.status === 'starting') return null;
  if (s.status !== 'running' || !s.game) return undefined;
  return s.game.phase === 'user' && atTip && !s.thinking ? s.game.lesson.userSide : null;
}

export interface LessonMark {
  orig: string;
  dest?: string;
  brush: string;
}

/** Board marks: the thrown move (red) with the keeper (green), the shown move, the hinted piece. */
export function lessonMarks(s: Pick<LessonStoreState, 'status' | 'game' | 'thrown'>): LessonMark[] {
  if ((s.status !== 'running' && s.status !== 'done') || !s.game) return [];
  const out: LessonMark[] = [];
  const t = s.thrown;
  if (s.game.reason === 'thrown' && t) {
    out.push({ orig: t.uci.slice(0, 2), dest: t.uci.slice(2, 4), brush: 'red' });
    if (t.keeperUci) {
      out.push({ orig: t.keeperUci.slice(0, 2), dest: t.keeperUci.slice(2, 4), brush: 'green' });
    }
    return out;
  }
  if (s.game.shownMove) {
    const m = s.game.shownMove;
    out.push({ orig: m.slice(0, 2), dest: m.slice(2, 4), brush: 'green' });
  } else if (s.game.hintSquare) {
    out.push({ orig: s.game.hintSquare, brush: 'green' });
  }
  return out;
}
