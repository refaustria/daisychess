import { Clock } from '../../clock/Clock';
import { formatClock } from '../../clock/format';
import { useLichessAuth } from '../../lichess/auth';
import { useLiveStore } from '../../live/liveStore';
import { usePlayStore } from '../../play/playStore';
import { useRoomStore } from '../../room/roomStore';
import { roomClockTicks, roomPlayers } from '../../room/view';
import { currentFen, useGameStore, type Orientation } from '../../store/gameStore';
import { CapturedPieces } from './CapturedPieces';
import { useTicker } from '../Live/LiveClock';
import {
  liveClockTicks,
  selectBoardPlayers,
  type BoardPlayers,
  type BoardPlayersSource,
  type PlayerInfo,
} from './boardPlayers';
import styles from './PlayerBar.module.css';

const SIDE = { white: 'White', black: 'Black' } as const;

/** "White: Stockfish · 1500 Elo, 4:59" */
export function playerBarLabel(side: Orientation, p: PlayerInfo): string {
  const who = p.subtitle ? `${p.name} · ${p.subtitle}` : p.name;
  const clock = p.clock
    ? `, ${formatClock(p.clock.ms)}${p.clock.state === 'flagged' ? ' (flagged)' : ''}`
    : '';
  return `${SIDE[side]}: ${who}${clock}`;
}

export interface PlayerBarProps {
  side: Orientation;
  player: PlayerInfo;
  position: 'top' | 'bottom';
}

/**
 * A player above or below the board: colour swatch, name, subtitle and a large clock on the
 * right. The bar keeps its height without a clock, so the board does not jump when a game starts.
 */
export function PlayerBar({ side, player, position }: PlayerBarProps) {
  const { clock } = player;
  const startFen = useGameStore((s) => s.startFen);
  const fen = useGameStore(currentFen);
  const toMove = clock !== undefined && clock.state !== 'idle' && clock.state !== 'flagged';
  return (
    <div
      className={toMove ? `${styles.bar} ${styles.barToMove}` : styles.bar}
      role="group"
      aria-label={playerBarLabel(side, player)}
      data-testid={`player-bar-${position}`}
      data-side={side}
    >
      <span className={side === 'white' ? styles.swatchWhite : styles.swatchBlack} aria-hidden />
      <span className={styles.names}>
        <strong className={styles.name}>{player.name}</strong>
        {player.subtitle && <span className={styles.subtitle}>{player.subtitle}</span>}
      </span>
      <CapturedPieces side={side} startFen={startFen} fen={fen} />
      {clock && (
        <Clock
          ms={clock.ms}
          side={side}
          state={clock.state}
          initialMs={clock.initialMs}
          testId={clock.testId}
          size="large"
          className={styles.clock}
        />
      )}
    </div>
  );
}

/**
 * The players of the board from the stores. Re-renders about every 100 ms only while a live or
 * room clock runs; the engine game's clock is ticked by the play store itself.
 */
export function useBoardPlayers(): BoardPlayers & {
  source: BoardPlayersSource;
  orientation: Orientation;
} {
  const live = useLiveStore();
  const username = useLichessAuth((s) => s.username);
  const play = usePlayStore();
  const headers = useGameStore((s) => s.headers);
  const startFen = useGameStore((s) => s.startFen);
  const moves = useGameStore((s) => s.moves);
  const orientation = useGameStore((s) => s.orientation);
  // A room (waiting, playing or just finished) is shown until the user leaves it or starts
  // another game.
  const shownRoom = useRoomStore((s) => (s.phase === 'room' ? s.room : undefined));
  const otherGame = live.status === 'playing' || play.mode === 'playing';
  const room = shownRoom && (shownRoom.status !== 'finished' || !otherGame) ? shownRoom : undefined;
  const liveGame = live.status === 'playing' ? live.game : undefined;
  const now = useTicker(liveClockTicks(liveGame) || roomClockTicks(room));
  const players = selectBoardPlayers({
    live: { status: live.status, game: live.game, username },
    play,
    game: { headers, startFen, moves },
    now,
    ...(room ? { friend: roomPlayers(room, now) } : {}),
  });
  return { ...players, orientation };
}
