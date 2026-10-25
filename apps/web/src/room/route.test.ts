import { describe, expect, it } from 'vitest';
import { parseRoomHash, roomLink } from './route';
import { cleanNick, isValidNick, pruneSeats, readSeat, ROOM_KEY_PREFIX, SEAT_MAX_AGE_MS, writeSeat } from './storage';
import { ROOM_ID, TOKEN_A } from './testing';

describe('room route', () => {
  it('parses #/room/<id> and rejects anything else', () => {
    expect(parseRoomHash(`#/room/${ROOM_ID}`)).toBe(ROOM_ID);
    expect(parseRoomHash(`#/room/${ROOM_ID}/`)).toBe(ROOM_ID);
    expect(parseRoomHash('#/room/short')).toBeNull();
    expect(parseRoomHash(`#/room/${ROOM_ID}/x`)).toBeNull();
    expect(parseRoomHash(`#room/${ROOM_ID}`)).toBeNull();
    expect(parseRoomHash('#/room/%E0%A4%A')).toBeNull();
    expect(parseRoomHash('')).toBeNull();
  });

  it('builds the link from origin and path', () => {
    expect(roomLink(ROOM_ID, { origin: 'https://play.daisychess.org', pathname: '/' })).toBe(
      `https://play.daisychess.org/#/room/${ROOM_ID}`,
    );
  });
});

describe('room storage', () => {
  it('nicknames are normalised like the server does', () => {
    expect(cleanNick('  Al ​  ice ')).toBe('Al ice');
    expect(isValidNick('   ')).toBe(false);
    expect(isValidNick('x'.repeat(21))).toBe(false);
    expect(isValidNick('Bob')).toBe(true);
  });

  it('stores seats per room, rejects garbage and prunes old ones', () => {
    localStorage.clear();
    writeSeat(ROOM_ID, { playerToken: TOKEN_A, color: 'black', nick: 'Bob' }, 1_000);
    expect(readSeat(ROOM_ID)).toEqual({ playerToken: TOKEN_A, color: 'black', nick: 'Bob', savedAt: 1_000 });
    localStorage.setItem(`${ROOM_KEY_PREFIX}Garbage_0123456789abc`, '{"playerToken":"x"}');
    expect(readSeat('Garbage_0123456789abc')).toBeNull();
    expect(readSeat('bad id')).toBeNull();
    pruneSeats(1_000 + SEAT_MAX_AGE_MS - 1);
    expect(readSeat(ROOM_ID)).not.toBeNull();
    expect(localStorage.getItem(`${ROOM_KEY_PREFIX}Garbage_0123456789abc`)).toBeNull();
    pruneSeats(1_000 + SEAT_MAX_AGE_MS + 1);
    expect(readSeat(ROOM_ID)).toBeNull();
  });
});
