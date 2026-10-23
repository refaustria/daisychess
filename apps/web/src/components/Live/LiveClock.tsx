import { useEffect, useState } from 'react';
import { Clock } from '../../clock/Clock';
import { isRunning, remainingMs, toMove, type LiveGame } from '../../live/LiveGameController';
import type { Orientation } from '../../store/gameStore';

export { LOW_TIME_MS } from '../../clock/format';

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
  now?: () => number;
}

/** One player's clock of a live game (lichess state + local ticking of the side to move). */
export function LiveClock({ game, side, now = Date.now }: LiveClockProps) {
  const running = game.clock !== null && isRunning(game) && game.moves.length >= 2;
  const active = isRunning(game) && toMove(game, game.moves.length) === side;
  const t = useTicker(running && active, now);
  if (!game.clock) return null;
  const ms = remainingMs(game, side, t);
  const flagged =
    !isRunning(game) &&
    game.reason === 'outoftime' &&
    game.winner !== undefined &&
    game.winner !== side;
  return (
    <Clock
      ms={ms}
      side={side}
      initialMs={game.clock.initial}
      state={flagged ? 'flagged' : active ? (running ? 'running' : 'active') : 'idle'}
      testId={`clock-${side}`}
    />
  );
}
