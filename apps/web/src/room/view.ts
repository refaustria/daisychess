import type { RoomEndReason, RoomSide, RoomStateMessage } from '@daisychess/engine-core';
import type { ClockState } from '../clock/Clock';
import type { BoardPlayers, PlayerInfo } from '../components/PlayerBar/boardPlayers';
import { sideToMoveAt } from './RoomMirror';

/** A snapshot plus the client's own arrival time (clock display, ADR-013). */
export type RoomView = Omit<RoomStateMessage, 'type'> & { receivedAt: number };

const other = (s: RoomSide): RoomSide => (s === 'white' ? 'black' : 'white');

export const REASON_TEXT: Record<RoomEndReason, string> = {
  checkmate: 'checkmate',
  stalemate: 'stalemate',
  draw: 'draw (repetition, 50 moves or insufficient material)',
  resign: 'resignation',
  timeout: 'time out',
  abort: 'game aborted',
  abandoned: 'abandoned',
  agreement: 'draw by agreement',
};

const nickOf = (r: Pick<RoomView, 'players'>, side: RoomSide): string =>
  r.players[side]?.nick ?? (side === 'white' ? 'White' : 'Black');

/** Whether a clock of the room ticks right now (the bars re-render about every 100 ms then). */
export function roomClockTicks(r: RoomView | undefined): boolean {
  return (
    !!r && r.status === 'playing' && r.clock !== null && r.clock.running !== null && r.moves.length >= 2
  );
}

/**
 * Remaining time of `side` at `now`: the running side loses `now - receivedAt` (the client's own
 * clock, skew-free); everything else is static. Flagging is the server's decision (0:00 until
 * the timeout snapshot arrives).
 */
export function roomRemainingMs(r: RoomView, side: RoomSide, now: number): number {
  const c = r.clock;
  if (!c) return 0;
  const base = c[side];
  if (!roomClockTicks(r) || c.running !== side) return Math.max(0, base);
  return Math.max(0, base - Math.max(0, now - r.receivedAt));
}

export function roomClockState(r: RoomView, side: RoomSide): ClockState {
  if (r.status === 'finished') {
    if (r.reason !== 'timeout') return 'idle';
    const loser = r.result === '1-0' ? 'black' : r.result === '0-1' ? 'white' : undefined;
    if (loser === side) return 'flagged';
    // A timeout draw (the opponent could not mate): the side whose clock ran out flagged.
    return loser === undefined && r.clock !== null && r.clock[side] === 0 ? 'flagged' : 'idle';
  }
  if (r.status !== 'playing' || sideToMoveAt(r.moves.length) !== side) return 'idle';
  return roomClockTicks(r) && r.clock?.running === side ? 'running' : 'active';
}

/** The players of the bars (the `friend` source of `selectBoardPlayers`). */
export function roomPlayers(r: RoomView, now: number): BoardPlayers {
  const one = (side: RoomSide): PlayerInfo => {
    const p = r.players[side];
    const mine = r.you === side;
    let name: string;
    let subtitle: string | undefined;
    if (!p) {
      name = r.status === 'waiting' ? 'Waiting for your friend…' : side === 'white' ? 'White' : 'Black';
    } else {
      name = p.nick;
      if (mine) subtitle = 'you';
      else if (!p.connected && r.status !== 'finished') subtitle = 'disconnected';
    }
    const info: PlayerInfo = { name, ...(subtitle ? { subtitle } : {}) };
    if (r.clock) {
      info.clock = {
        ms: roomRemainingMs(r, side, now),
        state: roomClockState(r, side),
        initialMs: r.clock.initialMs,
        testId: `friend-clock-${side}`,
      };
    }
    return info;
  };
  return { white: one('white'), black: one('black') };
}

/** Milliseconds until the user may claim (≤ 0: now), or null without a pending claim. */
export function claimRemainingMs(r: RoomView, now: number): number | null {
  if (r.claimableAt === undefined || r.status !== 'playing' || r.you === 'spectator') return null;
  return r.claimableAt - r.serverTime - Math.max(0, now - r.receivedAt);
}

/** "You won", "Alice won", "Draw", "Game aborted". */
export function roomVerdict(r: Pick<RoomView, 'result' | 'you' | 'players' | 'reason'>): string {
  if (!r.result) return r.reason === 'abandoned' ? 'Game abandoned' : 'Game aborted';
  if (r.result === '1/2-1/2') return 'Draw';
  const winner: RoomSide = r.result === '1-0' ? 'white' : 'black';
  if (r.you === winner) return 'You won';
  if (r.you === other(winner)) return 'You lost';
  return `${nickOf(r, winner)} won`;
}

/** Result line: "You won — resignation". */
export function roomResultText(r: Pick<RoomView, 'result' | 'you' | 'players' | 'reason'>): string {
  const v = roomVerdict(r);
  const reason = r.reason ? REASON_TEXT[r.reason] : undefined;
  return reason && r.result ? `${v} — ${reason}` : v;
}

/** The app's status line during a room game (null: the regular game status applies). */
export function roomStatusLine(r: RoomView | undefined, pendingMove: boolean): string | null {
  if (!r) return null;
  if (r.status === 'waiting') return r.you === 'spectator' ? 'Waiting for players' : 'Waiting for your friend';
  if (r.status === 'finished') return roomResultText(r);
  const tip = sideToMoveAt(r.moves.length);
  // The user's move is on its way: the board already shows the opponent to move.
  const toMove = pendingMove ? other(tip) : tip;
  if (r.you === toMove) return 'Your move';
  return `${nickOf(r, toMove)} to move`;
}

export { nickOf as roomNick };
