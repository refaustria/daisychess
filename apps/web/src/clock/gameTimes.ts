import type { GameState, MoveRecord, Orientation } from '../store/gameStore';

/** The parts of the game store the clock data of an imported game is read from (M22-1). */
export type TimedGame = Pick<GameState, 'startFen' | 'moves'> & Partial<Pick<GameState, 'timeControl'>>;

/** True when at least one move of the game carries clock data from the PGN. */
export function hasClockData(moves: readonly MoveRecord[]): boolean {
  return moves.some((m) => m.clock?.remainingMs !== undefined || m.clock?.spentMs !== undefined);
}

/** Side that played the (1-based) `ply` of a game starting at `startFen`. */
export function moverOfPly(startFen: string, ply: number): Orientation {
  const blackFirst = startFen.split(' ')[1] === 'b';
  return (ply % 2 === 1) !== blackFirst ? 'white' : 'black';
}

/** Initial time of the game: the time control, else the side's first recorded remaining time. */
export function initialTimeOf(game: TimedGame, side: Orientation): number | undefined {
  if (game.timeControl) return game.timeControl.initialMs;
  for (let p = 1; p <= game.moves.length; p++) {
    if (moverOfPly(game.startFen, p) !== side) continue;
    const ms = game.moves[p - 1]?.clock?.remainingMs;
    if (ms !== undefined) return ms;
  }
  return undefined;
}

/**
 * Remaining time of `side` at the displayed `ply` (0 = start): the value after the side's most
 * recent move ≤ ply that has one, the initial time before its first move. `undefined` when the
 * game has no clock data for the side.
 */
export function remainingAt(game: TimedGame, ply: number, side: Orientation): number | undefined {
  const last = Math.min(Math.max(0, Math.trunc(ply)), game.moves.length);
  for (let p = last; p >= 1; p--) {
    if (moverOfPly(game.startFen, p) !== side) continue;
    const ms = game.moves[p - 1]?.clock?.remainingMs;
    if (ms !== undefined) return ms;
  }
  return initialTimeOf(game, side);
}

/** Remaining time per side for every ply 0..N (the time graph's series). */
export function remainingSeries(game: TimedGame): Record<Orientation, (number | undefined)[]> {
  const out: Record<Orientation, (number | undefined)[]> = { white: [], black: [] };
  for (let p = 0; p <= game.moves.length; p++) {
    out.white.push(remainingAt(game, p, 'white'));
    out.black.push(remainingAt(game, p, 'black'));
  }
  return out;
}
