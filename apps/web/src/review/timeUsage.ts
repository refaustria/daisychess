import type { ReviewedMove, ReviewSummary } from '@daisychess/engine-core';
import { formatClock } from '../clock/format';
import { initialTimeOf, moverOfPly, type TimedGame } from '../clock/gameTimes';
import type { Orientation } from '../store/gameStore';

/**
 * Time usage of an imported game in the review (M22-1). Everything here is derived from the game
 * store's clock data at render time; the engine review and its cache record are unchanged.
 */

/** A mistake/blunder made with less than this share of the initial time left is in time trouble… */
export const TIME_TROUBLE_FRACTION = 0.1;
/** …or with less than this left, whichever limit is larger. */
export const TIME_TROUBLE_MIN_MS = 30_000;

/** Remaining time below which a move counts as made in time trouble. */
export function timeTroubleThresholdMs(initialMs: number | undefined): number {
  return Math.max(TIME_TROUBLE_MIN_MS, (initialMs ?? 0) * TIME_TROUBLE_FRACTION);
}

export interface MoveTime {
  /** Time spent on the move. */
  spentMs?: number;
  /** Time left on the mover's clock after the move. */
  remainingMs?: number;
  /** Time on the mover's clock before the move. */
  beforeMs?: number;
  /** `spentMs / beforeMs` (0..1) when both are known. */
  shareOfRemaining?: number;
}

/** Clock data of the (1-based) `ply`, or `undefined` when the move has none. */
export function moveTime(game: TimedGame, ply: number): MoveTime | undefined {
  const clock = game.moves[ply - 1]?.clock;
  if (!clock || (clock.spentMs === undefined && clock.remainingMs === undefined)) return undefined;
  const out: MoveTime = { ...clock };
  const side = moverOfPly(game.startFen, ply);
  let before: number | undefined;
  if (ply <= 2) {
    before = game.timeControl?.initialMs;
  } else {
    before = game.moves[ply - 3]?.clock?.remainingMs;
  }
  if (before === undefined && clock.spentMs !== undefined && clock.remainingMs !== undefined) {
    before = clock.remainingMs + clock.spentMs - (game.timeControl?.incrementMs ?? 0);
  }
  // Without a time control the first move's "before" is the side's initial approximation.
  if (before === undefined && ply <= 2) before = initialTimeOf(game, side);
  if (before !== undefined && before > 0) {
    out.beforeMs = before;
    if (clock.spentMs !== undefined) out.shareOfRemaining = Math.min(1, clock.spentMs / before);
  }
  return out;
}

/** Duration text: `0:42`, `1:05`; tenths only under 10 s and when present (`0:03`, `0:03.4`). */
export function formatDuration(ms: number): string {
  const t = Math.max(0, ms);
  if (t < 10_000 && Math.floor(t / 100) % 10 !== 0) return formatClock(t);
  const secs = Math.floor(t / 1000);
  return formatClock(secs * 1000).replace(/^0:0(\d)\.0$/, '0:0$1');
}

/** "Used 0:42 (12% of remaining) · 0:18 left"; `undefined` without clock data. */
export function timeUsedText(t: MoveTime | undefined): string | undefined {
  if (!t) return undefined;
  const parts: string[] = [];
  if (t.spentMs !== undefined) {
    const share =
      t.shareOfRemaining !== undefined ? ` (${Math.round(t.shareOfRemaining * 100)}% of remaining)` : '';
    parts.push(`Used ${formatDuration(t.spentMs)}${share}`);
  }
  if (t.remainingMs !== undefined) parts.push(`${formatDuration(t.remainingMs)} left`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

const TROUBLE_CLASSES = new Set(['mistake', 'blunder']);

/**
 * A mistake or blunder made with less than {@link timeTroubleThresholdMs} on the mover's clock
 * after the move (the time shown as "left").
 */
export function isTimeTrouble(
  game: TimedGame,
  move: Pick<ReviewedMove, 'ply' | 'classification'>,
): boolean {
  if (!TROUBLE_CLASSES.has(move.classification)) return false;
  const left = game.moves[move.ply - 1]?.clock?.remainingMs;
  if (left === undefined) return false;
  const side = moverOfPly(game.startFen, move.ply);
  return left < timeTroubleThresholdMs(initialTimeOf(game, side));
}

/** Plies of the mistakes/blunders made in time trouble. */
export function timeTroublePlies(game: TimedGame, summary: ReviewSummary | undefined): Set<number> {
  const out = new Set<number>();
  for (const m of summary?.moves ?? []) if (isTimeTrouble(game, m)) out.add(m.ply);
  return out;
}

export interface SideTimeStats {
  /** Moves with a known spent time. */
  timedMoves: number;
  avgMs?: number;
  longest?: { ply: number; ms: number };
  /** Mistakes and blunders in time trouble (0 without a review). */
  timeTroubleMistakes: number;
}

/** Per player: average time per move, the longest think and mistakes in time trouble. */
export function sideTimeStats(
  game: TimedGame,
  summary?: ReviewSummary,
): Record<Orientation, SideTimeStats> {
  const trouble = timeTroublePlies(game, summary);
  const side = (color: Orientation): SideTimeStats => {
    let total = 0;
    let count = 0;
    let longest: SideTimeStats['longest'];
    game.moves.forEach((m, i) => {
      const ply = i + 1;
      const spent = m.clock?.spentMs;
      if (spent === undefined || moverOfPly(game.startFen, ply) !== color) return;
      total += spent;
      count++;
      if (!longest || spent > longest.ms) longest = { ply, ms: spent };
    });
    let mistakes = 0;
    for (const p of trouble) if (moverOfPly(game.startFen, p) === color) mistakes++;
    const out: SideTimeStats = { timedMoves: count, timeTroubleMistakes: mistakes };
    if (count > 0) out.avgMs = total / count;
    if (longest) out.longest = longest;
    return out;
  };
  return { white: side('white'), black: side('black') };
}
