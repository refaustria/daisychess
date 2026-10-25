import { normalizeNick, ROOM_BOUNDS, RoomIdSchema, type RoomSide } from '@daisychess/engine-core';

/** The last nickname (prefills the create and join forms). */
export const NICK_KEY = 'daisychess.nick';
/** Per room: the seat secret for `room.attach` (ADR-013), never in the URL. */
export const ROOM_KEY_PREFIX = 'daisychess.room.';
/** Seats older than this are pruned (rooms live at most a few hours on the server). */
export const SEAT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface StoredSeat {
  playerToken: string;
  color: RoomSide;
  nick: string;
  /** Epoch ms when stored (pruning). */
  savedAt?: number;
}

const TOKEN = ROOM_BOUNDS.playerTokenPattern;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A nickname as the server will store it (normalised, at most 20 characters). */
export function cleanNick(raw: string): string {
  return normalizeNick(raw).slice(0, ROOM_BOUNDS.nick.max);
}

export const isValidNick = (raw: string): boolean => {
  const n = normalizeNick(raw);
  return n.length >= ROOM_BOUNDS.nick.min && n.length <= ROOM_BOUNDS.nick.max;
};

export function readNick(): string {
  try {
    const v = storage()?.getItem(NICK_KEY);
    return typeof v === 'string' ? cleanNick(v) : '';
  } catch {
    return '';
  }
}

export function writeNick(nick: string): void {
  try {
    storage()?.setItem(NICK_KEY, cleanNick(nick));
  } catch {
    /* storage full or blocked */
  }
}

export function readSeat(roomId: string): StoredSeat | null {
  if (!RoomIdSchema.safeParse(roomId).success) return null;
  try {
    const raw = storage()?.getItem(ROOM_KEY_PREFIX + roomId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<StoredSeat> | null;
    if (
      !v ||
      typeof v.playerToken !== 'string' ||
      !TOKEN.test(v.playerToken) ||
      (v.color !== 'white' && v.color !== 'black') ||
      typeof v.nick !== 'string'
    ) {
      return null;
    }
    return {
      playerToken: v.playerToken,
      color: v.color,
      nick: v.nick,
      ...(typeof v.savedAt === 'number' ? { savedAt: v.savedAt } : {}),
    };
  } catch {
    return null;
  }
}

export function writeSeat(roomId: string, seat: StoredSeat, now = Date.now()): void {
  try {
    storage()?.setItem(ROOM_KEY_PREFIX + roomId, JSON.stringify({ ...seat, savedAt: now }));
  } catch {
    /* storage full or blocked: a reload then cannot re-attach */
  }
}

export function removeSeat(roomId: string): void {
  try {
    storage()?.removeItem(ROOM_KEY_PREFIX + roomId);
  } catch {
    /* ignore */
  }
}

/** Removes stored seats older than {@link SEAT_MAX_AGE_MS} (or unreadable ones). */
export function pruneSeats(now = Date.now()): void {
  const s = storage();
  if (!s) return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const key = s.key(i);
      if (!key?.startsWith(ROOM_KEY_PREFIX)) continue;
      const seat = readSeat(key.slice(ROOM_KEY_PREFIX.length));
      if (!seat || seat.savedAt === undefined || now - seat.savedAt > SEAT_MAX_AGE_MS)
        stale.push(key);
    }
    for (const k of stale) s.removeItem(k);
  } catch {
    /* ignore */
  }
}
