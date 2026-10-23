import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { useRoomStore } from './roomStore';
import { roomStatusLine } from './view';

/**
 * The app's status line while a room is shown ("Waiting for your friend", "Your move",
 * "Alice to move", the result), null otherwise (the regular game status applies). A finished
 * room gives way to a newly started engine or lichess game.
 */
export function useRoomStatus(): string | null {
  const room = useRoomStore((s) => (s.phase === 'room' ? s.room : undefined));
  const pending = useRoomStore((s) => s.pendingMove !== undefined);
  const livePlaying = useLiveStore((s) => s.status === 'playing');
  const enginePlaying = usePlayStore((s) => s.mode === 'playing');
  if (!room || (room.status === 'finished' && (livePlaying || enginePlaying))) return null;
  return roomStatusLine(room, pending);
}
