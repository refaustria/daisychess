import type { ClockState } from '../../clock/Clock';
import type { GameClock } from '../../clock/gameClock';
import { hasClockData, initialTimeOf, remainingAt } from '../../clock/gameTimes';
import { isRunning, remainingMs, toMove, type LiveGame } from '../../live/LiveGameController';
import type { LiveStatus } from '../../live/liveStore';
import type { PlayMode, PlaySetup } from '../../play/playStore';
import { findStrength } from '../../play/strength';
import { currentFen, type GameState, type Orientation } from '../../store/gameStore';

export interface PlayerClockInfo {
  /** Remaining time (ms) at the moment of the selection. */
  ms: number;
  state: ClockState;
  /** Initial time of the game (low-time threshold). */
  initialMs?: number;
  /** Test id of the rendered clock (kept stable for the existing tests). */
  testId?: string;
}

export interface PlayerInfo {
  name: string;
  /** Rating/title (lichess), strength preset (engine) or Elo (PGN headers). */
  subtitle?: string;
  /** Absent without a clock: the bar shows the name only. */
  clock?: PlayerClockInfo;
}

export interface BoardPlayers {
  white: PlayerInfo;
  black: PlayerInfo;
}

/** Where the players come from, in priority order. */
export type BoardPlayersSource = 'friend' | 'live' | 'play' | 'pgn';

export interface BoardPlayersInput {
  live: {
    status: LiveStatus;
    game?: LiveGame;
    /** The logged-in lichess user. */ username?: string;
  };
  play: {
    mode: PlayMode;
    playerColor: Orientation;
    setup: Pick<PlaySetup, 'strength'>;
    clock: GameClock | null;
  };
  /**
   * The board's game. `ply` (displayed position, default: the tip) and `timeControl` drive the
   * static clocks of an imported game with `%clk` data (M22-1).
   */
  game: Pick<GameState, 'headers' | 'startFen' | 'moves'> &
    Partial<Pick<GameState, 'ply' | 'timeControl'>>;
  /** Clock source of the live game (`Date.now()`, the live store's time base). */
  now: number;
  /**
   * Extension point for further game sources (M16: games against a friend over our own
   * server). A caller that has such a game passes its ready-made players here; they win over
   * every other source. A new source thus needs one more input + branch, not a new component.
   */
  friend?: BoardPlayers;
}

const other = (c: Orientation): Orientation => (c === 'white' ? 'black' : 'white');
const tipTurn = (g: BoardPlayersInput['game']): Orientation =>
  currentFen({ startFen: g.startFen, moves: g.moves, ply: g.moves.length }).split(' ')[1] === 'b'
    ? 'black'
    : 'white';

/** Clock state of one side of a live lichess game (same rules as the former Live tab clocks). */
export function liveClockState(game: LiveGame, side: Orientation): ClockState {
  const running = isRunning(game);
  if (
    !running &&
    game.reason === 'outoftime' &&
    game.winner !== undefined &&
    game.winner !== side
  ) {
    return 'flagged';
  }
  if (!running || toMove(game, game.moves.length) !== side) return 'idle';
  // lichess starts the clocks after each side's first move.
  return game.clock !== null && game.moves.length >= 2 ? 'running' : 'active';
}

/** Whether a live clock ticks (the bars then re-render about every 100 ms). */
export function liveClockTicks(game: LiveGame | undefined): boolean {
  return !!game && game.clock !== null && isRunning(game) && game.moves.length >= 2;
}

function livePlayers(game: LiveGame, username: string | undefined, now: number): BoardPlayers {
  const opp = game.opponent;
  const oppSub = [
    opp.title,
    opp.rating !== undefined ? String(opp.rating) : undefined,
    opp.aiLevel !== undefined ? `level ${opp.aiLevel}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const clockOf = (side: Orientation): PlayerClockInfo | undefined =>
    game.clock
      ? {
          ms: remainingMs(game, side, now),
          state: liveClockState(game, side),
          initialMs: game.clock.initial,
          testId: `clock-${side}`,
        }
      : undefined;
  const me: PlayerInfo = { name: username ?? 'You', subtitle: username ? 'You' : undefined };
  const them: PlayerInfo = { name: opp.name, subtitle: oppSub || undefined };
  const mine = { ...me, clock: clockOf(game.color) };
  const theirs = { ...them, clock: clockOf(other(game.color)) };
  return game.color === 'white' ? { white: mine, black: theirs } : { white: theirs, black: mine };
}

function playPlayers(input: BoardPlayersInput): BoardPlayers {
  const { play } = input;
  const c = play.clock;
  const toMoveSide = play.mode === 'playing' ? tipTurn(input.game) : null;
  const clockOf = (side: Orientation, who: 'you' | 'engine'): PlayerClockInfo | undefined => {
    if (!c) return undefined;
    const key = side === 'white' ? 'w' : 'b';
    const state: ClockState =
      c.flagged === key
        ? 'flagged'
        : c.runningSide === key
          ? 'running'
          : toMoveSide === side
            ? 'active'
            : 'idle';
    return { ms: c[key], state, initialMs: c.initialMs, testId: `play-clock-${who}` };
  };
  const engineColor = other(play.playerColor);
  const you: PlayerInfo = { name: 'You', clock: clockOf(play.playerColor, 'you') };
  const engine: PlayerInfo = {
    name: 'Stockfish',
    subtitle: findStrength(play.setup.strength).label,
    clock: clockOf(engineColor, 'engine'),
  };
  return play.playerColor === 'white'
    ? { white: you, black: engine }
    : { white: engine, black: you };
}

const header = (h: Record<string, string>, key: string): string | undefined => {
  const v = h[key]?.trim();
  return v && v !== '?' && v !== '-' ? v : undefined;
};

/**
 * Static clock of an imported game at the displayed ply: the side's remaining time after its most
 * recent move (initial time before its first move); never ticking, low-time colour relative to
 * the initial time.
 */
function pgnClock(game: BoardPlayersInput['game'], side: Orientation): PlayerClockInfo | undefined {
  if (!hasClockData(game.moves)) return undefined;
  const ms = remainingAt(game, game.ply ?? game.moves.length, side);
  if (ms === undefined) return undefined;
  const initialMs = initialTimeOf(game, side);
  return {
    ms,
    state: 'idle',
    ...(initialMs !== undefined ? { initialMs } : {}),
    testId: `pgn-clock-${side}`,
  };
}

function pgnPlayers(game: BoardPlayersInput['game']): BoardPlayers {
  const { headers } = game;
  const one = (side: 'White' | 'Black'): PlayerInfo => {
    const elo = header(headers, `${side}Elo`);
    const title = header(headers, `${side}Title`);
    const subtitle = [title, elo].filter(Boolean).join(' ');
    const info: PlayerInfo = { name: header(headers, side) ?? side, subtitle: subtitle || undefined };
    const clock = pgnClock(game, side === 'White' ? 'white' : 'black');
    return clock ? { ...info, clock } : info;
  };
  return { white: one('White'), black: one('Black') };
}

/**
 * The two players shown in the bars above and below the board. Priority: an injected `friend`
 * game > a live lichess game (playing or just finished) > a local engine game (playing or just
 * finished) > the PGN headers (White/Black, Elo), defaulting to "White"/"Black", with static
 * clocks at the displayed ply when the imported game has `%clk`/`%emt` data.
 */
export function selectBoardPlayers(input: BoardPlayersInput): BoardPlayers & {
  source: BoardPlayersSource;
} {
  if (input.friend) return { ...input.friend, source: 'friend' };
  const { live, play } = input;
  if (live.game && (live.status === 'playing' || live.status === 'finished')) {
    return { ...livePlayers(live.game, live.username, input.now), source: 'live' };
  }
  if (play.mode !== 'idle') return { ...playPlayers(input), source: 'play' };
  return { ...pgnPlayers(input.game), source: 'pgn' };
}
