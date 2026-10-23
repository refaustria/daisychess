import { RoomIdSchema } from '@chesslab/engine-core';

const ROUTE = /^#\/room\/([^/?#]+)\/?$/;

/** The room id of a `#/room/<id>` hash, or null. */
export function parseRoomHash(hash: string): string | null {
  const m = ROUTE.exec(hash);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return RoomIdSchema.safeParse(id).success ? id : null;
}

/** The shareable link of a room: `<origin><path>#/room/<id>` (hash route, ADR-013). */
export function roomLink(roomId: string, loc: Pick<Location, 'origin' | 'pathname'> = location): string {
  return `${loc.origin}${loc.pathname}#/room/${roomId}`;
}

/** Puts the room route into the address bar without a navigation (reloads re-attach). */
export function setRoomHash(roomId: string | null): void {
  try {
    const { pathname, search, hash } = globalThis.location;
    const next = roomId ? `#/room/${roomId}` : '';
    if (hash === next || (!roomId && parseRoomHash(hash) === null)) return;
    globalThis.history.replaceState(globalThis.history.state, '', `${pathname}${search}${next}`);
  } catch {
    /* history unavailable */
  }
}
