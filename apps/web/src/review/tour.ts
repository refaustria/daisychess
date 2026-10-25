import type { ReviewedMove, ReviewSummary } from '@daisychess/engine-core';
import { CLASS_INFO } from './format';
import type { MoveDetails } from './details';

/** Dwell on an ordinary move / on a notable one (ms). */
export const SHORT_DWELL_MS = 600;
export const LONG_DWELL_MS = 2500;

export type TourKind = 'blunder' | 'mistake' | 'great';

export interface TourStep {
  ply: number;
  /** Set for notable moves (long dwell, counted as a highlight). */
  kind?: TourKind;
}

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

/** One step per reviewed ply, in order. */
export function buildSchedule(summary: ReviewSummary): TourStep[] {
  const moves = [...summary.moves].sort((a, b) => a.ply - b.ply);
  return moves.map((m, i) => {
    const kind = tourKind(m, moves[i - 1]);
    return kind ? { ply: m.ply, kind } : { ply: m.ply };
  });
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

export type TourStatus = 'idle' | 'playing' | 'paused' | 'finished' | 'stopped';

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

/** Pure tour state machine over a schedule; time comes from the injectable timer. */
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

  /** One step forward; after the last step the tour finishes. Works while paused. */
  next(): void {
    if (!this.active()) return;
    this.clearTimer();
    if (this.index + 1 >= this.schedule.length) return this.setStatus('finished');
    this.goTo(this.index + 1);
  }

  pause(): void {
    if (this.status !== 'playing') return;
    this.clearTimer();
    this.setStatus('paused');
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.setStatus('playing');
    this.arm();
  }

  /** Jumps to the next notable step; without one to the last step, finishing the tour. */
  skip(): void {
    if (!this.active()) return;
    this.clearTimer();
    let i = this.index + 1;
    while (i < this.schedule.length && !this.schedule[i]!.kind) i++;
    if (i < this.schedule.length) return this.goTo(i);
    this.index = this.schedule.length - 1;
    this.cb.onStep(this.schedule[this.index]!, this.index);
    this.setStatus('finished');
  }

  stop(): void {
    if (!this.active()) return;
    this.clearTimer();
    this.setStatus('stopped');
  }

  private active(): boolean {
    return this.status === 'playing' || this.status === 'paused';
  }

  private goTo(i: number): void {
    this.index = i;
    this.cb.onStep(this.schedule[i]!, i);
    // The callback may have stopped the tour.
    if (this.status === 'playing') this.arm();
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
