import { randomBytes } from 'node:crypto';
import type {
  RoomClientMessage,
  RoomClockSetting,
  RoomColorChoice,
  RoomErrorCode,
  RoomSide,
  ServerMessage,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import { Room } from './room.js';

export interface RateLimit {
  max: number;
  windowMs: number;
}

/** Server policy for rooms (env `ROOM_*`, see config.ts). */
export interface RoomConfig {
  /** Live rooms (any status) at once. */
  maxRooms: number;
  /** Spectators per room. */
  maxSpectators: number;
  /** `room.create` per client address. */
  createRateLimit: RateLimit;
  /** A room nobody joined is abandoned after this long. */
  waitingTtlMs: number;
  /** A finished room is deleted this long after the game ended. */
  finishedTtlMs: number;
  /** A running game without a move for this long is abandoned. */
  idleTtlMs: number;
  /** A player must be gone this long before the opponent may claim. */
  claimGraceMs: number;
}

export const DEFAULT_ROOM_CONFIG: Readonly<RoomConfig> = Object.freeze({
  maxRooms: 200,
  maxSpectators: 10,
  createRateLimit: { max: 10, windowMs: 600_000 },
  waitingTtlMs: 900_000,
  finishedTtlMs: 600_000,
  idleTtlMs: 7_200_000,
  claimGraceMs: 60_000,
});

/** What the manager needs from a member's connection. */
export interface RoomClient {
  readonly id: number;
  /** Client address (per-address creation rate). */
  readonly ip: string;
  deliver(msg: ServerMessage): void;
  /** The game of the room this client plays in has started (fair play: drop engine sessions). */
  onGameStarted?(): void;
}

export interface RoomManagerOptions {
  config: RoomConfig;
  logger: PoolLogger;
  /** Monotonic clock (ms). Default `performance.now`. */
  now?: () => number;
  /** Wall clock (epoch ms) for `room.state.serverTime`. Default `Date.now`. */
  wallNow?: () => number;
  /** Id / token generators (tests inject). */
  newRoomId?: () => string;
  newPlayerToken?: () => string;
  /** Random source for `color: 'random'`. */
  random?: () => number;
}

type Role = RoomSide | 'spectator';

interface Member {
  client: RoomClient;
  role: Role;
}

interface Entry {
  room: Room;
  members: Map<number, Member>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface RoomStats {
  rooms: number;
  waiting: number;
  playing: number;
  finished: number;
  members: number;
}

/** 128 random bits, URL-safe (22 chars). */
export const newRoomId = (): string => randomBytes(16).toString('base64url');
/** 256 random bits, URL-safe (43 chars). */
export const newPlayerToken = (): string => randomBytes(32).toString('base64url');

/**
 * Rooms of one WebSocket server (ADR-013): membership, limits, timers and broadcasting around
 * the pure {@link Room} state machine. A connection is a member of at most one room; every
 * state change sends a full `room.state` to every member of that room.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Entry>();
  /** Room id by client id. */
  private readonly byClient = new Map<number, string>();
  /** `room.create` timestamps (monotonic) per address. */
  private readonly creations = new Map<string, number[]>();
  private readonly cfg: RoomConfig;
  private readonly log: PoolLogger;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly newRoomId: () => string;
  private readonly newPlayerToken: () => string;
  private readonly random: (() => number) | undefined;
  private closed = false;

  constructor(opts: RoomManagerOptions) {
    this.cfg = opts.config;
    this.log = opts.logger;
    this.now = opts.now ?? (() => performance.now());
    this.wallNow = opts.wallNow ?? (() => Date.now());
    this.newRoomId = opts.newRoomId ?? newRoomId;
    this.newPlayerToken = opts.newPlayerToken ?? newPlayerToken;
    this.random = opts.random;
  }

  /** Dispatches a `room.*` message of `client`. */
  handle(client: RoomClient, msg: RoomClientMessage): void {
    if (this.closed) return;
    switch (msg.type) {
      case 'room.create':
        this.create(client, msg.nick, msg.clock, msg.color);
        return;
      case 'room.join':
        this.join(client, msg.roomId, msg.nick);
        return;
      case 'room.attach':
        this.attach(client, msg.roomId, msg.playerToken);
        return;
      case 'room.leave':
        this.leave(client, msg.roomId);
        return;
    }
    // Player actions.
    const found = this.playerOf(client, msg.roomId);
    if (!found) return;
    const { entry, side } = found;
    const now = this.now();
    const result =
      msg.type === 'room.move'
        ? entry.room.move(side, msg.uci, now)
        : msg.type === 'room.resign'
          ? entry.room.resign(side, now)
          : msg.type === 'room.draw'
            ? entry.room.draw(side, msg.action, now)
            : msg.type === 'room.abort'
              ? entry.room.abort(now)
              : entry.room.claim(side, now);
    if (!result.ok) {
      // A failed action may still have flagged the clock inside tick(); publish that first.
      if (entry.room.status === 'finished' && entry.room.finishedAt === now) this.changed(entry);
      this.error(client, result.code, result.message, msg.roomId);
      return;
    }
    if (result.changed) this.changed(entry);
  }

  /** The client's socket closed: same as `room.leave` of its room. */
  disconnect(client: RoomClient): void {
    const roomId = this.byClient.get(client.id);
    if (roomId !== undefined) this.detach(client, roomId, true);
  }

  /** Whether `client` is a player in a room whose game is running (fair play, `forbidden`). */
  isPlaying(client: RoomClient): boolean {
    const entry = this.entryOf(client);
    const m = entry?.members.get(client.id);
    return !!entry && !!m && m.role !== 'spectator' && entry.room.status === 'playing';
  }

  stats(): RoomStats {
    const s: RoomStats = {
      rooms: this.rooms.size,
      waiting: 0,
      playing: 0,
      finished: 0,
      members: 0,
    };
    for (const e of this.rooms.values()) {
      s[e.room.status]++;
      s.members += e.members.size;
    }
    return s;
  }

  /** Stops every timer; rooms are gone with the process anyway. */
  close(): void {
    this.closed = true;
    for (const e of this.rooms.values()) {
      if (e.timer) clearTimeout(e.timer);
      e.timer = null;
    }
    this.rooms.clear();
    this.byClient.clear();
  }

  // -------------------------------------------------------------------------------------------
  // Requests

  private create(
    client: RoomClient,
    nick: string,
    clock: RoomClockSetting | null,
    color: RoomColorChoice,
  ): void {
    const now = this.now();
    if (!this.allowCreate(client.ip, now)) {
      this.log.info({ conn: client.id, ip: client.ip }, 'room creation rate exceeded');
      this.error(client, 'too_many_rooms', 'too many rooms created from your address; try later');
      return;
    }
    if (this.rooms.size >= this.cfg.maxRooms) {
      this.log.warn({ rooms: this.rooms.size }, 'room cap reached');
      this.error(client, 'too_many_rooms', 'the server has no free rooms right now');
      return;
    }
    this.leaveCurrent(client);
    const token = this.newPlayerToken();
    const room = new Room({
      id: this.newRoomId(),
      now,
      host: { nick, token, color },
      clock,
      claimGraceMs: this.cfg.claimGraceMs,
      ...(this.random ? { random: this.random } : {}),
    });
    const entry: Entry = { room, members: new Map(), timer: null };
    this.rooms.set(room.id, entry);
    entry.members.set(client.id, { client, role: room.hostColor });
    this.byClient.set(client.id, room.id);
    this.log.info(
      { conn: client.id, room: room.id, color: room.hostColor, clock, nick },
      'room created',
    );
    client.deliver({
      type: 'room.seat',
      roomId: room.id,
      playerToken: token,
      color: room.hostColor,
    });
    this.changed(entry);
  }

  private join(client: RoomClient, roomId: string, nick: string | undefined): void {
    const entry = this.rooms.get(roomId);
    if (!entry) {
      this.error(client, 'room_not_found', 'this room does not exist (any more)', roomId);
      return;
    }
    const existing = entry.members.get(client.id);
    if (existing) {
      // Already in: just resend the snapshot.
      this.sendState(entry, existing);
      return;
    }
    const now = this.now();
    if (nick !== undefined && entry.room.freeSeat) {
      this.leaveCurrent(client);
      const token = this.newPlayerToken();
      const side = entry.room.join(nick, token, now)!;
      entry.members.set(client.id, { client, role: side });
      this.byClient.set(client.id, roomId);
      this.log.info(
        { conn: client.id, room: roomId, color: side, nick },
        'room joined; game starts',
      );
      client.deliver({ type: 'room.seat', roomId, playerToken: token, color: side });
      for (const m of entry.members.values()) {
        if (m.role !== 'spectator') m.client.onGameStarted?.();
      }
      this.changed(entry);
      return;
    }
    if (this.spectatorCount(entry) >= this.cfg.maxSpectators) {
      this.error(client, 'room_full', 'this room has no free seat and too many spectators', roomId);
      return;
    }
    this.leaveCurrent(client);
    entry.members.set(client.id, { client, role: 'spectator' });
    this.byClient.set(client.id, roomId);
    this.log.debug({ conn: client.id, room: roomId }, 'spectator joined');
    this.changed(entry);
  }

  private attach(client: RoomClient, roomId: string, playerToken: string): void {
    const entry = this.rooms.get(roomId);
    if (!entry) {
      this.error(client, 'room_not_found', 'this room does not exist (any more)', roomId);
      return;
    }
    const side = entry.room.sideOfToken(playerToken);
    if (!side) {
      this.log.info({ conn: client.id, room: roomId }, 'attach with a wrong player token');
      this.error(
        client,
        'bad_token',
        'this player token does not belong to a seat of the room',
        roomId,
      );
      return;
    }
    const mine = entry.members.get(client.id);
    if (mine?.role === side) {
      this.sendState(entry, mine);
      return;
    }
    if (!mine) this.leaveCurrent(client);
    // Another connection holding this seat (old tab) becomes a spectator.
    for (const m of entry.members.values()) {
      if (m.role === side && m.client !== client) m.role = 'spectator';
    }
    entry.members.set(client.id, { client, role: side });
    this.byClient.set(client.id, roomId);
    const now = this.now();
    entry.room.setConnected(side, true, now);
    entry.room.tick(now);
    this.log.info({ conn: client.id, room: roomId, color: side }, 'player attached');
    this.changed(entry);
  }

  private leave(client: RoomClient, roomId: string): void {
    if (this.byClient.get(client.id) !== roomId) {
      this.error(client, 'room_not_found', 'you are not in this room', roomId);
      return;
    }
    this.detach(client, roomId, false);
  }

  // -------------------------------------------------------------------------------------------
  // Membership

  private entryOf(client: RoomClient): Entry | undefined {
    const id = this.byClient.get(client.id);
    return id === undefined ? undefined : this.rooms.get(id);
  }

  private playerOf(client: RoomClient, roomId: string): { entry: Entry; side: RoomSide } | null {
    const entry = this.rooms.get(roomId);
    if (!entry) {
      this.error(client, 'room_not_found', 'this room does not exist (any more)', roomId);
      return null;
    }
    const m = entry.members.get(client.id);
    if (!m || m.role === 'spectator') {
      this.error(client, 'not_a_player', 'you are not a player in this room', roomId);
      return null;
    }
    return { entry, side: m.role };
  }

  private leaveCurrent(client: RoomClient): void {
    const current = this.byClient.get(client.id);
    if (current !== undefined) this.detach(client, current, false);
  }

  /** Removes the member; a player is marked disconnected (the seat stays claimable by token). */
  private detach(client: RoomClient, roomId: string, socketClosed: boolean): void {
    this.byClient.delete(client.id);
    const entry = this.rooms.get(roomId);
    if (!entry) return;
    const m = entry.members.get(client.id);
    if (!m) return;
    entry.members.delete(client.id);
    const now = this.now();
    if (m.role !== 'spectator') {
      // Only if no other connection holds the seat (attach from a new tab demotes the old one).
      const stillHeld = [...entry.members.values()].some((o) => o.role === m.role);
      if (!stillHeld) entry.room.setConnected(m.role, false, now);
      this.log.info(
        { conn: client.id, room: roomId, color: m.role, socketClosed },
        'player left the room',
      );
    }
    entry.room.tick(now);
    this.changed(entry);
  }

  private spectatorCount(entry: Entry): number {
    let n = 0;
    for (const m of entry.members.values()) if (m.role === 'spectator') n++;
    return n;
  }

  // -------------------------------------------------------------------------------------------
  // Broadcasting and timers

  /** After any change: broadcast the snapshot and re-arm the room's timer. */
  private changed(entry: Entry): void {
    if (!this.rooms.has(entry.room.id)) return;
    this.broadcast(entry);
    this.schedule(entry);
  }

  private broadcast(entry: Entry): void {
    const now = this.now();
    const serverTime = this.wallNow();
    const spectators = this.spectatorCount(entry);
    for (const m of entry.members.values()) {
      m.client.deliver(entry.room.snapshot(m.role, spectators, now, serverTime));
    }
  }

  private sendState(entry: Entry, m: Member): void {
    m.client.deliver(
      entry.room.snapshot(m.role, this.spectatorCount(entry), this.now(), this.wallNow()),
    );
  }

  /** Monotonic time the room's TTL expires. */
  private ttlDeadline(room: Room): number {
    switch (room.status) {
      case 'waiting':
        return room.createdAt + this.cfg.waitingTtlMs;
      case 'playing':
        return room.lastActivityAt + this.cfg.idleTtlMs;
      case 'finished':
        return (room.finishedAt ?? room.lastActivityAt) + this.cfg.finishedTtlMs;
    }
  }

  private schedule(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (this.closed) return;
    const next = entry.room.nextDeadline();
    const ttl = this.ttlDeadline(entry.room);
    const deadline = next === null ? ttl : Math.min(next, ttl);
    const delay = Math.max(0, deadline - this.now());
    entry.timer = setTimeout(() => this.fire(entry), Math.min(delay, 2_147_483_647));
    entry.timer.unref?.();
  }

  private fire(entry: Entry): void {
    entry.timer = null;
    if (this.closed || !this.rooms.has(entry.room.id)) return;
    const room = entry.room;
    const now = this.now();
    room.tick(now);
    if (now >= this.ttlDeadline(room)) {
      if (room.status === 'finished') {
        this.remove(entry, 'finished room expired');
        return;
      }
      const was = room.status;
      room.expire(now);
      this.log.info({ room: room.id, status: was }, 'room expired (abandoned)');
      if (was === 'waiting') {
        // Nobody to play with any more: tell the host and drop the room right away.
        this.broadcast(entry);
        this.remove(entry, 'waiting room expired');
        return;
      }
    }
    // Flag, abandonment or `claimableAt` passing: members get a fresh snapshot either way.
    this.changed(entry);
  }

  private remove(entry: Entry, why: string): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.rooms.delete(entry.room.id);
    for (const id of entry.members.keys()) {
      if (this.byClient.get(id) === entry.room.id) this.byClient.delete(id);
    }
    this.log.debug({ room: entry.room.id, members: entry.members.size }, why);
    entry.members.clear();
  }

  // -------------------------------------------------------------------------------------------

  private allowCreate(ip: string, now: number): boolean {
    const { max, windowMs } = this.cfg.createRateLimit;
    const times = this.creations.get(ip) ?? [];
    while (times.length > 0 && now - times[0]! >= windowMs) times.shift();
    if (times.length >= max) {
      this.creations.set(ip, times);
      return false;
    }
    times.push(now);
    this.creations.set(ip, times);
    // Keep the map from growing with one-off addresses.
    if (this.creations.size > 10_000) {
      for (const [k, v] of this.creations) {
        if (v.length === 0 || now - v[v.length - 1]! >= windowMs) this.creations.delete(k);
      }
    }
    return true;
  }

  private error(client: RoomClient, code: RoomErrorCode, message: string, roomId?: string): void {
    client.deliver({
      type: 'room.error',
      code,
      message,
      ...(roomId === undefined ? {} : { roomId }),
    });
  }
}
