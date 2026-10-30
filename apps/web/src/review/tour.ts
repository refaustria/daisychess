import type { ReviewedMove, ReviewSummary } from '@daisychess/engine-core';
import { CLASS_INFO } from './format';
import type { MoveDetails } from './details';
import type { OpeningCard } from './openingStop';

/** Dwell on an ordinary move / on a notable one (ms). */
export const SHORT_DWELL_MS = 600;
export const LONG_DWELL_MS = 2500;

export type TourKind = 'blunder' | 'mistake' | 'great';

/** Why the tour waits at a step (ADR-024 section 1). */
export type TourStop = 'opening' | 'mistake';

export interface TourStep {
  ply: number;
  /** Set for notable moves (long dwell, counted as a highlight). */
  kind?: TourKind;
  /** Set for the tour's stops: it waits there until the user continues. */
  stop?: TourStop;
}

/**
 * Explanation shown on a mistake stop: the shape of `Explanation` of `review/explain` (ADR-024
 * section 4), declared structurally so the tour does not depend on the explainer module; M31-6
 * fills it with `explainMistake(...)`.
 */
export interface TourExplanation {
  headline: string;
  sentences: string[];
  line?: { fen: string; sans: string[]; label: string };
  arrows: { uci: string; brush: 'green' | 'red' | 'yellow' }[];
}

/** Content of a mistake stop. */
export interface MistakeCard {
  kind: 'mistake';
  ply: number;
  /** One line: {@link highlightText} plus the Maia suffix; the content until M31-6 explains. */
  text: string;
  /** The rule-based explanation (M31-6). */
  explanation?: TourExplanation;
}

/** What the tour shows at a stop. */
export type TourCard = OpeningCard | MistakeCard;

/** A reply (best move) to a blunder/mistake at least this big (win-probability points) is "great". */
export const GREAT_PUNISH_LOSS = 20;

/**
 * Notable moves of the guided tour. The review has no `great`/`brilliant` class and no
 * second-best line, so the cheapest faithful definition is:
 * - `blunder` and `mistake` (inaccuracies are stepped over);
 * - `great`: the engine's first choice (class `best`, not `forced`) played right after the
 *   opponent lost at least {@link GREAT_PUNISH_LOSS} points of win probability, i.e. the move that
 *   punishes a blunder/big mistake.
 */
export function tourKind(move: ReviewedMove, previous?: ReviewedMove): TourKind | undefined {
  if (move.classification === 'blunder') return 'blunder';
  if (move.classification === 'mistake') return 'mistake';
  if (
    move.classification === 'best' &&
    previous &&
    previous.mover !== move.mover &&
    previous.winProbLoss >= GREAT_PUNISH_LOSS
  ) {
    return 'great';
  }
  return undefined;
}

export interface ScheduleOptions {
  /** The user's side: its mistakes and blunders are stops. None without a side. */
  userSide?: 'white' | 'black';
  /** Last ply still in book (opening focus); the opening stop when >= 1. */
  lastBookPly?: number;
  /** Start position of the game; a custom one has no opening stop. Default: standard. */
  startFen?: string;
}

const STANDARD_EPD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const isStandardStart = (fen: string): boolean =>
  fen.split(' ').slice(0, 4).join(' ') === STANDARD_EPD;

/**
 * One step per reviewed ply, in order. Stops (ADR-024 section 1): the opening stop on
 * `lastBookPly` (standard start position, at least one book move) and a mistake stop on every
 * mistake/blunder of `userSide`. When both fall on one ply the opening stop wins (a book move).
 * The opponent's mistakes and `great` moves keep their kind (long dwell) and never stop.
 */
export function buildSchedule(summary: ReviewSummary, opts: ScheduleOptions = {}): TourStep[] {
  const moves = [...summary.moves].sort((a, b) => a.ply - b.ply);
  const openingPly =
    (opts.lastBookPly ?? 0) >= 1 && (opts.startFen === undefined || isStandardStart(opts.startFen))
      ? opts.lastBookPly
      : undefined;
  return moves.map((m, i) => {
    const step: TourStep = { ply: m.ply };
    const kind = tourKind(m, moves[i - 1]);
    if (kind) step.kind = kind;
    if (m.ply === openingPly) step.stop = 'opening';
    else if (
      opts.userSide !== undefined &&
      m.mover === opts.userSide &&
      (m.classification === 'mistake' || m.classification === 'blunder')
    ) {
      step.stop = 'mistake';
    }
    return step;
  });
}

/** Number of stops in `schedule` up to and including `index` ("Stop n of N"). */
export function stopNumber(schedule: readonly TourStep[], index: number): number {
  let n = 0;
  for (let i = 0; i <= index && i < schedule.length; i++) if (schedule[i]!.stop) n++;
  return n;
}

export const dwellFor = (step: TourStep): number => (step.kind ? LONG_DWELL_MS : SHORT_DWELL_MS);

/**
 * Text of a highlight, e.g. `12. Nxe5?? Blunder (−3.10): better was Bxf7+`; a mistake/blunder in
 * `timeTrouble` (plies, from the imported game's clocks) gets ` (in time trouble)`.
 */
export function highlightText(
  details: MoveDetails,
  step: TourStep,
  timeTrouble: ReadonlySet<number> = new Set(),
): string {
  const d = details[step.ply];
  if (!d) return '';
  const info = CLASS_INFO[d.classification];
  const head = `${d.moveLabel} ${d.playedSan}${info.glyph}`;
  if (step.kind === 'great') return `${head} Great move: punishes the previous mistake`;
  const better = d.bestSan ? `: better was ${d.bestSan}` : '';
  const trouble = timeTrouble.has(step.ply) ? ' (in time trouble)' : '';
  return `${head} ${info.label} (${d.swing})${better}${trouble}`;
}

/** `waiting`: at a stop, no timer; the user continues with Next (ADR-024 section 1). */
export type TourStatus = 'idle' | 'playing' | 'paused' | 'waiting' | 'finished' | 'stopped';

/** The tour is running (its controls are shown). */
export const tourActive = (s: TourStatus): boolean =>
  s === 'playing' || s === 'paused' || s === 'waiting';

export interface TourTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimer: TourTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface TourCallbacks {
  /** The tour moved to `step` (index into the schedule). */
  onStep(step: TourStep, index: number): void;
  /** The status changed. */
  onStatus(status: TourStatus): void;
}

/**
 * Pure tour state machine over a schedule; time comes from the injectable timer. Ordinary steps
 * advance after their dwell; a step with `stop` fires its callback, clears the timer and waits
 * (`waiting`) until {@link next}, {@link resume} or {@link skip}.
 */
export class TourController {
  private index = -1;
  private status: TourStatus = 'idle';
  private handle: unknown = undefined;

  constructor(
    readonly schedule: readonly TourStep[],
    private readonly cb: TourCallbacks,
    private readonly timer: TourTimer = realTimer,
  ) {}

  get state(): { status: TourStatus; index: number } {
    return { status: this.status, index: this.index };
  }

  /** Starts at the first step. An empty schedule finishes at once. */
  start(): void {
    this.clearTimer();
    if (this.schedule.length === 0) return this.setStatus('finished');
    this.index = -1;
    this.setStatus('playing');
    this.goTo(0);
  }

  /**
   * One step forward; after the last step the tour finishes. Works while paused (stays paused);
   * from `waiting` it continues playing.
   */
  next(): void {
    if (!tourActive(this.status)) return;
    this.clearTimer();
    if (this.index + 1 >= this.schedule.length) return this.setStatus('finished');
    if (this.status === 'waiting') this.setStatus('playing');
    this.goTo(this.index + 1);
  }

  /** Pauses a playing tour; a no-op while waiting (nothing runs). */
  pause(): void {
    if (this.status !== 'playing') return;
    this.clearTimer();
    this.setStatus('paused');
  }

  /** Resumes a paused tour; while waiting it is {@link next}. */
  resume(): void {
    if (this.status === 'waiting') return this.next();
    if (this.status !== 'paused') return;
    this.setStatus('playing');
    this.arm();
  }

  /** Jumps to the next stop and waits there; without one to the last step, finishing the tour. */
  skip(): void {
    if (!tourActive(this.status)) return;
    this.clearTimer();
    let i = this.index + 1;
    while (i < this.schedule.length && !this.schedule[i]!.stop) i++;
    if (i < this.schedule.length) return this.goTo(i);
    this.index = this.schedule.length - 1;
    this.cb.onStep(this.schedule[this.index]!, this.index);
    if (tourActive(this.status)) this.setStatus('finished');
  }

  stop(): void {
    if (!tourActive(this.status)) return;
    this.clearTimer();
    this.setStatus('stopped');
  }

  private goTo(i: number): void {
    this.index = i;
    const step = this.schedule[i]!;
    this.cb.onStep(step, i);
    // The callback may have stopped the tour.
    if (!tourActive(this.status)) return;
    if (step.stop) {
      this.clearTimer();
      this.setStatus('waiting');
    } else if (this.status === 'playing') {
      this.arm();
    }
  }

  private arm(): void {
    this.clearTimer();
    const step = this.schedule[this.index]!;
    this.handle = this.timer.set(() => {
      this.handle = undefined;
      this.next();
    }, dwellFor(step));
  }

  private clearTimer(): void {
    if (this.handle !== undefined) this.timer.clear(this.handle);
    this.handle = undefined;
  }

  private setStatus(s: TourStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.cb.onStatus(s);
  }
}
