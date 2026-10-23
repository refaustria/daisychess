import { useEffect, useState } from 'react';
import { formatClock, isRunning, remainingMs, toMove, type LiveGame } from '../../live/LiveGameController';
import type { Orientation } from '../../store/gameStore';
import styles from './LivePanel.module.css';

/** Below this the clock turns to the low-time colour. */
export const LOW_TIME_MS = 20_000;

/**
 * Re-renders every `ms` while `active` (the running clock); nothing ticks otherwise.
 * Exposed for tests; `now` is the clock source.
 */
export function useTicker(active: boolean, now: () => number = Date.now, ms = 100): number {
  const [t, setT] = useState(now);
  useEffect(() => {
    if (!active) return;
    setT(now());
    const id = setInterval(() => setT(now()), ms);
    return () => clearInterval(id);
  }, [active, now, ms]);
  return active ? t : now();
}

interface LiveClockProps {
  game: LiveGame;
  side: Orientation;
  label: string;
  now?: () => number;
}

/** One player's clock: m:ss (tenths under 10 s), active side highlighted, low time coloured. */
export function LiveClock({ game, side, label, now = Date.now }: LiveClockProps) {
  const running = game.clock !== null && isRunning(game) && game.moves.length >= 2;
  const active = isRunning(game) && toMove(game, game.moves.length) === side;
  const t = useTicker(running && active, now);
  if (!game.clock) return null;
  const ms = remainingMs(game, side, t);
  const cls = [styles.clock, active ? styles.clockActive : '', ms < LOW_TIME_MS ? styles.clockLow : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      className={cls}
      role="timer"
      aria-live="off"
      aria-label={`${label} clock`}
      data-testid={`clock-${side}`}
      data-active={active || undefined}
    >
      {formatClock(ms)}
    </div>
  );
}
