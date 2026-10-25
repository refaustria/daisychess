import type { PointerEvent, MouseEvent } from 'react';
import { remainingSeries, type TimedGame } from '../../clock/gameTimes';
import { formatDuration, timeTroubleThresholdMs } from '../../review/timeUsage';
import styles from './EvalGraph.module.css';

const W = 300;
const H = 48;

export interface TimeGraphProps {
  game: TimedGame;
  /** Currently viewed ply (0 = start position). */
  ply: number;
  onSeek: (ply: number) => void;
}

/** Step-line points of one side's remaining time; gaps (unknown) are bridged by the last value. */
function points(series: readonly (number | undefined)[], x: (i: number) => number, y: (ms: number) => number): string {
  const out: string[] = [];
  let prev: number | undefined;
  series.forEach((ms, i) => {
    if (ms === undefined) return;
    if (prev !== undefined && ms !== prev) out.push(`${x(i).toFixed(2)},${y(prev).toFixed(2)}`);
    out.push(`${x(i).toFixed(2)},${y(ms).toFixed(2)}`);
    prev = ms;
  });
  return out.join(' ');
}

/**
 * Remaining time per side over the game (M22-1), under the eval graph and on the same ply axis:
 * White solid, Black dashed, a dotted line at the time-trouble threshold. Clicking/dragging seeks
 * like the eval graph; the label summarises it for screen readers.
 */
export function TimeGraph({ game, ply, onSeek }: TimeGraphProps) {
  const series = remainingSeries(game);
  const n = game.moves.length;
  const all = [...series.white, ...series.black].filter((v): v is number => v !== undefined);
  if (all.length === 0) return null;
  const max = Math.max(1, ...all, game.timeControl?.initialMs ?? 0);
  const x = (i: number): number => (n === 0 ? W / 2 : (i / n) * W);
  const y = (ms: number): number => H - 2 - (Math.max(0, ms) / max) * (H - 4);
  const threshold = timeTroubleThresholdMs(game.timeControl?.initialMs);
  const endOf = (s: readonly (number | undefined)[]) => s[s.length - 1];
  const we = endOf(series.white);
  const be = endOf(series.black);
  const label = `Clock graph over ${n} moves: White ends with ${
    we !== undefined ? formatDuration(we) : 'unknown time'
  }, Black with ${be !== undefined ? formatDuration(be) : 'unknown time'} remaining.`;

  const plyAt = (e: { clientX: number; currentTarget: Element }): number => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width <= 0) return 0;
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    return Math.round(f * n);
  };
  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onSeek(plyAt(e));
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (e.buttons & 1) {
      const p = plyAt(e);
      if (p !== ply) onSeek(p);
    }
  };
  const onClick = (e: MouseEvent<SVGSVGElement>) => onSeek(plyAt(e));
  const cursor = Math.min(Math.max(ply, 0), n);

  return (
    <figure className={styles.figure}>
      <svg
        className={`${styles.graph} ${styles.timeGraph}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        data-testid="time-graph"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onClick={onClick}
      >
        <rect x="0" y="0" width={W} height={H} className={styles.bg} />
        {threshold < max && (
          <line x1="0" x2={W} y1={y(threshold)} y2={y(threshold)} className={styles.threshold} />
        )}
        <polyline points={points(series.white, x, y)} className={styles.timeWhite} data-series="white" />
        <polyline points={points(series.black, x, y)} className={styles.timeBlack} data-series="black" />
        <line x1={x(cursor)} x2={x(cursor)} y1="0" y2={H} className={styles.cursor} />
      </svg>
      <figcaption className={styles.legend} aria-hidden>
        <span>
          <span className={styles.keyWhite} /> White clock
        </span>
        <span>
          <span className={styles.keyBlack} /> Black clock
        </span>
        <span>
          <span className={styles.keyThreshold} /> time trouble
        </span>
      </figcaption>
    </figure>
  );
}
