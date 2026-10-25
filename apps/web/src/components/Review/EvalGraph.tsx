import type { ReviewSummary } from '@daisychess/engine-core';
import { useId, type PointerEvent, type MouseEvent } from 'react';
import { CLASS_INFO, whiteProbs } from '../../review/format';
import styles from './EvalGraph.module.css';

const W = 300;
const H = 80;

export interface EvalGraphProps {
  summary: ReviewSummary;
  /** Currently viewed ply (0 = start position). */
  ply: number;
  onSeek: (ply: number) => void;
}

/** White win probability (0..100) per ply 0..N. */
export function whiteSeries(summary: ReviewSummary): number[] {
  const first = summary.moves[0];
  if (!first) return [50];
  return [whiteProbs(first).before, ...summary.moves.map((m) => whiteProbs(m).after)];
}

export function EvalGraph({ summary, ply, onSeek }: EvalGraphProps) {
  const id = useId();
  const series = whiteSeries(summary);
  const n = series.length - 1;
  const x = (i: number): number => (n === 0 ? W / 2 : (i / n) * W);
  const y = (p: number): number => H - (p / 100) * H;
  const pts = series.map((p, i) => `${x(i).toFixed(2)},${y(p).toFixed(2)}`);
  const line = pts.join(' ');
  const area = `${x(0)},${y(50)} ${line} ${x(n)},${y(50)}`;
  const last = series[n] ?? 50;
  const label = `Evaluation graph over ${n} moves: White win probability starts at ${Math.round(
    series[0] ?? 50,
  )}% and ends at ${Math.round(last)}%.`;

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
    <svg
      className={styles.graph}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      data-testid="eval-graph"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onClick={onClick}
    >
      <defs>
        <clipPath id={`${id}-top`}>
          <rect x="0" y="0" width={W} height={H / 2} />
        </clipPath>
        <clipPath id={`${id}-bottom`}>
          <rect x="0" y={H / 2} width={W} height={H / 2} />
        </clipPath>
      </defs>
      <rect x="0" y="0" width={W} height={H} className={styles.bg} />
      <polygon points={area} className={styles.white} clipPath={`url(#${id}-top)`} />
      <polygon points={area} className={styles.black} clipPath={`url(#${id}-bottom)`} />
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} className={styles.mid} />
      <polyline points={line} className={styles.line} />
      {series.map((p, i) => (
        <circle key={i} data-point={i} cx={x(i)} cy={y(p)} r="1" className={styles.point} />
      ))}
      {summary.moves.map((m) => {
        if (m.classification !== 'mistake' && m.classification !== 'blunder') return null;
        const p = whiteProbs(m).after;
        return (
          <circle
            key={m.ply}
            data-marker={m.classification}
            cx={x(m.ply)}
            cy={y(p)}
            r="3"
            fill={CLASS_INFO[m.classification].color}
            className={styles.marker}
          />
        );
      })}
      <line
        data-testid="eval-cursor"
        x1={x(cursor)}
        x2={x(cursor)}
        y1="0"
        y2={H}
        className={styles.cursor}
      />
    </svg>
  );
}
