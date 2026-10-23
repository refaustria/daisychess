import type {
  ErrorMessage,
  RoomClientMessage,
  RoomClockSetting,
  RoomColorChoice,
  RoomErrorMessage,
  RoomSide,
} from '@chesslab/engine-core';
import { create } from 'zustand';
import type { WebSocketLike } from '../engine/RemoteEngineClient';
import { defaultServerUrl } from '../engine/serverUrl';
import { isLiveLocked, setLiveStartGuard, useLiveStore } from '../live/liveStore';
import { setPlayStartGuard, usePlayStore } from '../play/playStore';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { RoomConnection, type RoomConnectionStatus, type RoomServerMessage } from './RoomConnection';
import { RoomMirror } from './RoomMirror';
import { parseRoomHash, setRoomHash } from './route';
import { cleanNick, pruneSeats, readNick, readSeat, removeSeat, writeNick, writeSeat } from './storage';
import type { RoomView } from './view';

/**
 * - `idle`: the create form.
 * - `creating` / `joining` / `attaching`: a request is on its way (`room.create`, `room.join`,
 *   `room.attach`).
 * - `join`: a link was opened and no seat is stored for it: the nickname prompt.
 * - `room`: in a room (`room` holds the latest snapshot).
 * - `expired`: the link's room does not exist (any more).
 */
export type RoomPhase = 'idle' | 'creating' | 'join' | 'joining' | 'attaching' | 'room' | 'expired';

export interface RoomSetup {
  nick: string;
  /** null = no clock. */
  clock: RoomClockSetting | null;
  color: RoomColorChoice;
}

export interface RoomState {
  phase: RoomPhase;
  roomId?: string;
  /** Latest snapshot of the room (with the local arrival time). */
  room?: RoomView;
  /** The user's seat in this room (from `room.seat` or localStorage). */
  seat?: { color: RoomSide; nick: string };
  connection: RoomConnectionStatus;
  /** The user's move sent but not confirmed yet (UCI). */
  pendingMove?: string;
  premoves: string[];
  /** The create form's last values (also used by "Play again"). */
  setup: RoomSetup;
  error?: string;
  notice?: string;
}

export interface RoomActions {
  setSetup(patch: Partial<RoomSetup>): void;
  /** Creates a room (link) with the setup; the user takes the host seat. */
  create(setup?: Partial<RoomSetup>): void;
  /** A room link was opened: re-attach with a stored seat, otherwise ask for a nickname. */
  openLink(roomId: string): void;
  /** Joins the opened link's room with a nickname (a seat, or watching when full). */
  join(nick: string): void;
  addPremove(uci: string): void;
  clearPremoves(): void;
  resign(): void;
  offerDraw(): void;
  acceptDraw(): void;
  declineDraw(): void;
  /** Cancels a waiting room or a game before both sides moved. */
  abort(): void;
  claim(): void;
  /** Leaves the room (a player can come back through the link) and returns to the form. */
  leave(): void;
  /** A new room with the same clock, colours swapped (there is no server rematch). */
  playAgain(): void;
  clearMessages(): void;
}

export type RoomStore = RoomState & RoomActions;

interface RoomHooks {
  createSocket?: (url: string) => WebSocketLike;
  reconnectDelay?: (attempt: number) => number;
  now: () => number;
  /** URL of the server's `/ws` (default: the analysis settings' server URL or this origin). */
  url: () => string;
}

const defaultHooks = (): RoomHooks => ({
  now: () => Date.now(),
  url: () => useAnalysisStore.getState().settings.remoteUrl ?? defaultServerUrl(),
});

let hooks: RoomHooks = defaultHooks();
let conn: RoomConnection | null = null;
let mirror: RoomMirror | null = null;
/** The nickname of the pending create/join (stored with the seat). */
let pendingNick = '';
/** The request of the current phase was sent on the current connection. */
let requestSent = false;
let analysisSuspended = false;
let unwatchAnalysis: (() => void) | null = null;

export const PLAY_RUNNING_TEXT = 'Finish or stop the game against the engine first';
export const LIVE_RUNNING_TEXT = 'Finish the live game on lichess first';
export const ROOM_RUNNING_TEXT = 'Finish the game against your friend first';
export const ROOM_FAIR_PLAY_TEXT = 'Disabled during a game against a friend (fair play)';
export const EXPIRED_TEXT = 'This game link has expired';

const DEFAULT_SETUP: RoomSetup = {
  nick: '',
  clock: { initialMs: 5 * 60_000, incrementMs: 3_000 },
  color: 'random',
};

/** The user plays in a running room game: engines, review and explorer are locked (fair play). */
export const isRoomLocked = (s: Pick<RoomState, 'phase' | 'room'>): boolean =>
  s.phase === 'room' && s.room?.status === 'playing' && s.room.you !== 'spectator';

/** A room occupies the user (request on its way, waiting for the friend, or playing). */
export function isRoomBusy(s: Pick<RoomState, 'phase' | 'room'>): boolean {
  if (s.phase === 'creating' || s.phase === 'joining' || s.phase === 'attaching') return true;
  return s.phase === 'room' && !!s.room && s.room.status !== 'finished' && s.room.you !== 'spectator';
}

/** Why a new room game cannot start now (engine or lichess game), or null. */
function otherGameRunning(): string | null {
  if (usePlayStore.getState().mode === 'playing') return PLAY_RUNNING_TEXT;
  if (isLiveLocked(useLiveStore.getState())) return LIVE_RUNNING_TEXT;
  return null;
}

// --- engines: off while the user plays ----------------------------------------------------------

function suspendAnalysis(): void {
  const a = useAnalysisStore.getState();
  if (a.enabled) {
    analysisSuspended = true;
    a.setEnabled(false);
  }
  unwatchAnalysis ??= useAnalysisStore.subscribe((s) => {
    if (s.enabled && isRoomLocked(useRoomStore.getState())) {
      analysisSuspended = true;
      s.setEnabled(false);
    }
  });
}

function restoreAnalysis(): void {
  unwatchAnalysis?.();
  unwatchAnalysis = null;
  if (!analysisSuspended) return;
  analysisSuspended = false;
  if (usePlayStore.getState().mode === 'playing' || isLiveLocked(useLiveStore.getState())) return;
  if (!useAnalysisStore.getState().enabled) useAnalysisStore.getState().setEnabled(true);
}

/** Engages/releases the lock after a state change. */
function syncLock(wasLocked: boolean): void {
  const locked = isRoomLocked(useRoomStore.getState());
  if (locked && !wasLocked) {
    // The friend game wins over a local engine game (it has a real opponent and a clock).
    if (usePlayStore.getState().mode === 'playing') usePlayStore.getState().stop();
    suspendAnalysis();
  } else if (!locked && wasLocked) {
    restoreAnalysis();
  }
}

// --- connection ---------------------------------------------------------------------------------

function connection(): RoomConnection {
  if (conn) return conn;
  const c = new RoomConnection({
    url: hooks.url(),
    token: () => useSettingsStore.getState().serverToken || undefined,
    ...(hooks.createSocket ? { createSocket: hooks.createSocket } : {}),
    ...(hooks.reconnectDelay ? { reconnectDelay: hooks.reconnectDelay } : {}),
    onMessage: (m) => {
      if (conn === c) onMessage(m);
    },
    onProtocolError: (m) => {
      if (conn === c) onProtocolError(m);
    },
    onStatus: (status) => {
      if (conn !== c) return;
      useRoomStore.setState({ connection: status });
      if (status === 'online') {
        requestSent = false;
        flush();
      }
    },
    onUnsupported: () => {
      if (conn !== c) return;
      conn = null;
      const s = useRoomStore.getState();
      const wasLocked = isRoomLocked(s);
      useRoomStore.setState({
        phase: s.phase === 'room' ? 'room' : s.roomId ? 'expired' : 'idle',
        connection: 'off',
        error: 'This server does not support games against a friend',
      });
      syncLock(wasLocked);
    },
  });
  conn = c;
  c.open();
  return c;
}

function closeConnection(): void {
  const c = conn;
  conn = null;
  c?.close();
  useRoomStore.setState({ connection: 'off' });
}

function send(msg: RoomClientMessage): boolean {
  return conn?.send(msg) ?? false;
}

/** Sends what the current phase is waiting for (on every new connection). */
function flush(): void {
  if (!conn?.online || requestSent) return;
  const s = useRoomStore.getState();
  const id = s.roomId;
  switch (s.phase) {
    case 'creating':
      requestSent = send({
        type: 'room.create',
        nick: pendingNick,
        clock: s.setup.clock,
        color: s.setup.color,
      });
      return;
    case 'joining':
      if (id) requestSent = send({ type: 'room.join', roomId: id, nick: pendingNick });
      return;
    case 'attaching':
    case 'room': {
      if (!id) return;
      const seat = readSeat(id);
      if (seat) requestSent = send({ type: 'room.attach', roomId: id, playerToken: seat.playerToken });
      else if (s.phase === 'room') requestSent = send({ type: 'room.join', roomId: id });
      return;
    }
    default:
      return;
  }
}

function newMirror(): RoomMirror {
  mirror?.dispose();
  const m = new RoomMirror({
    game: useGameStore,
    sendMove: (uci) => {
      const id = useRoomStore.getState().roomId;
      const ok = !!id && send({ type: 'room.move', roomId: id, uci });
      if (ok && mirror === m) useRoomStore.setState({ pendingMove: uci });
      return ok;
    },
    premoveMode: () => useSettingsStore.getState().premoves,
    onPremoves: (list) => {
      if (mirror === m) useRoomStore.setState({ premoves: [...list] });
    },
    onError: (message) => {
      if (mirror === m) useRoomStore.setState({ error: message });
    },
  });
  mirror = m;
  return m;
}

function disposeMirror(): void {
  mirror?.dispose();
  mirror = null;
}

// --- messages -------------------------------------------------------------------------------------

function onMessage(m: RoomServerMessage): void {
  const set = useRoomStore.setState;
  const s = useRoomStore.getState();
  switch (m.type) {
    case 'room.seat': {
      if (s.phase !== 'creating' && s.phase !== 'joining') return;
      if (s.phase === 'joining' && m.roomId !== s.roomId) return;
      const seat = { color: m.color, nick: pendingNick };
      writeSeat(m.roomId, { playerToken: m.playerToken, ...seat });
      if (s.phase === 'creating') setRoomHash(m.roomId);
      set({ roomId: m.roomId, seat });
      return;
    }
    case 'room.state': {
      if (m.roomId !== s.roomId) return;
      if (s.phase === 'idle' || s.phase === 'expired' || s.phase === 'join') return;
      // Snapshots of one room are ordered by the server's clock (a reconnect may race).
      if (s.room && s.room.roomId === m.roomId && m.serverTime < s.room.serverTime) return;
      const { type: _type, ...rest } = m;
      void _type;
      const room: RoomView = { ...rest, receivedAt: hooks.now() };
      const wasLocked = isRoomLocked(s);
      const demoted = s.room?.you !== undefined && s.room.you !== 'spectator' && m.you === 'spectator';
      const patch: Partial<RoomState> = { phase: 'room', room };
      if (m.you !== 'spectator') {
        const stored = readSeat(m.roomId);
        patch.seat = { color: m.you, nick: stored?.nick ?? s.seat?.nick ?? m.players[m.you]?.nick ?? '' };
      } else {
        patch.seat = undefined;
        if (demoted) patch.notice = 'This game continues in another tab or window';
      }
      const mir = mirror?.roomId === m.roomId ? mirror : newMirror();
      if (isRoomLocked({ phase: 'room', room })) {
        // Lock first: the mirror's store writes must already see the game as running.
        set(patch);
        syncLock(wasLocked);
        mir.apply(m);
      } else {
        // Unlock last: the auto review (on the unlock) must see the final moves.
        mir.apply(m);
        set(patch);
        syncLock(wasLocked);
      }
      set({ pendingMove: mir.pendingMove });
      return;
    }
    case 'room.error':
      onRoomError(m);
      return;
  }
}

const CREATE_ERRORS: Partial<Record<RoomErrorMessage['code'], string>> = {
  too_many_rooms: 'Too many games are being created right now – try again in a few minutes',
};

function onRoomError(m: RoomErrorMessage): void {
  const set = useRoomStore.setState;
  const s = useRoomStore.getState();
  if (m.roomId !== undefined && s.roomId !== undefined && m.roomId !== s.roomId) return;
  requestSent = true;
  switch (s.phase) {
    case 'creating':
      set({ phase: 'idle', error: CREATE_ERRORS[m.code] ?? m.message });
      closeIfIdle();
      return;
    case 'attaching':
      if (m.code === 'bad_token') {
        if (s.roomId) removeSeat(s.roomId);
        set({ phase: 'join' });
        return;
      }
      if (m.code === 'room_not_found') {
        expire();
        return;
      }
      set({ phase: 'join', error: m.message });
      return;
    case 'joining':
      if (m.code === 'room_not_found') {
        expire();
        return;
      }
      set({
        phase: 'join',
        error: m.code === 'room_full' ? 'This game is full (no free seat and no room to watch)' : m.message,
      });
      return;
    case 'room':
      switch (m.code) {
        case 'illegal_move':
        case 'not_your_turn':
          mirror?.rejectMove();
          set({ pendingMove: undefined, error: `Move rejected: ${m.message}` });
          return;
        case 'bad_state':
          set({ notice: m.message });
          return;
        case 'room_not_found':
          expire();
          return;
        case 'bad_token':
          // The stored seat is gone (re-attach after a reconnect): watch instead.
          if (s.roomId) removeSeat(s.roomId);
          set({ phase: 'join', room: undefined, seat: undefined });
          disposeMirror();
          syncLock(isRoomLocked(s));
          return;
        default:
          set({ error: m.message });
          return;
      }
    default:
      return;
  }
}

function onProtocolError(m: ErrorMessage): void {
  const text =
    m.code === 'rate_limited'
      ? 'Too many requests – slow down a little'
      : `Server error: ${m.message}`;
  useRoomStore.setState({ error: text });
}

function expire(): void {
  const s = useRoomStore.getState();
  const wasLocked = isRoomLocked(s);
  if (s.roomId) removeSeat(s.roomId);
  disposeMirror();
  useRoomStore.setState({ phase: 'expired', room: undefined, seat: undefined, premoves: [], pendingMove: undefined });
  syncLock(wasLocked);
  closeConnection();
}

function closeIfIdle(): void {
  const p = useRoomStore.getState().phase;
  if (p === 'idle' || p === 'expired') closeConnection();
}

function roomAction(build: (roomId: string) => RoomClientMessage): void {
  const s = useRoomStore.getState();
  if (s.phase !== 'room' || !s.roomId) return;
  if (!send(build(s.roomId))) useRoomStore.setState({ error: 'Not connected – try again in a moment' });
}

// --- store ------------------------------------------------------------------------------------

export const useRoomStore = create<RoomStore>()((set, get) => ({
  phase: 'idle',
  connection: 'off',
  premoves: [],
  setup: { ...DEFAULT_SETUP, nick: readNick() },

  setSetup: (patch) => set({ setup: { ...get().setup, ...patch } }),

  create: (patch) => {
    const s = get();
    const setup = { ...s.setup, ...patch };
    const nick = cleanNick(setup.nick);
    set({ setup: { ...setup, nick } });
    if (isRoomBusy(s)) {
      set({ error: ROOM_RUNNING_TEXT });
      return;
    }
    if (!nick) {
      set({ error: 'Choose a nickname first' });
      return;
    }
    const blocked = otherGameRunning();
    if (blocked) {
      set({ error: blocked });
      return;
    }
    writeNick(nick);
    pendingNick = nick;
    disposeMirror();
    const wasLocked = isRoomLocked(s);
    set({
      phase: 'creating',
      roomId: undefined,
      room: undefined,
      seat: undefined,
      premoves: [],
      pendingMove: undefined,
      error: undefined,
      notice: undefined,
    });
    syncLock(wasLocked);
    requestSent = false;
    connection();
    flush();
  },

  openLink: (roomId) => {
    const s = get();
    const ui = useUiStore.getState();
    if (ui.activeTab !== 'friend') ui.setActiveTab('friend');
    if (s.roomId === roomId && s.phase !== 'expired' && s.phase !== 'idle') return;
    if (isRoomBusy(s)) {
      set({ error: `${ROOM_RUNNING_TEXT} before opening another link` });
      return;
    }
    disposeMirror();
    const seat = readSeat(roomId);
    set({
      phase: seat ? 'attaching' : 'join',
      roomId,
      room: undefined,
      seat: seat ? { color: seat.color, nick: seat.nick } : undefined,
      premoves: [],
      pendingMove: undefined,
      error: undefined,
      notice: undefined,
    });
    if (seat) {
      requestSent = false;
      connection();
      flush();
    }
  },

  join: (raw) => {
    const s = get();
    if (s.phase !== 'join' || !s.roomId) return;
    const nick = cleanNick(raw);
    if (!nick) {
      set({ error: 'Choose a nickname first' });
      return;
    }
    const blocked = otherGameRunning();
    if (blocked) {
      set({ error: blocked });
      return;
    }
    writeNick(nick);
    pendingNick = nick;
    set({ phase: 'joining', error: undefined, notice: undefined, setup: { ...s.setup, nick } });
    requestSent = false;
    connection();
    flush();
  },

  addPremove: (uci) => {
    if (isRoomLocked(get())) mirror?.addPremove(uci);
  },
  clearPremoves: () => mirror?.clearPremoves(),

  resign: () => roomAction((roomId) => ({ type: 'room.resign', roomId })),
  offerDraw: () => roomAction((roomId) => ({ type: 'room.draw', roomId, action: 'offer' })),
  acceptDraw: () => roomAction((roomId) => ({ type: 'room.draw', roomId, action: 'accept' })),
  declineDraw: () => roomAction((roomId) => ({ type: 'room.draw', roomId, action: 'decline' })),
  abort: () => roomAction((roomId) => ({ type: 'room.abort', roomId })),
  claim: () => roomAction((roomId) => ({ type: 'room.claim', roomId })),

  leave: () => {
    const s = get();
    const wasLocked = isRoomLocked(s);
    if (s.roomId && s.phase === 'room') send({ type: 'room.leave', roomId: s.roomId });
    // A finished game cannot be re-entered as a player; a running one can (through the link).
    if (s.roomId && (s.room?.status === 'finished' || s.phase !== 'room')) removeSeat(s.roomId);
    disposeMirror();
    set({
      phase: 'idle',
      roomId: undefined,
      room: undefined,
      seat: undefined,
      premoves: [],
      pendingMove: undefined,
      error: undefined,
      notice: undefined,
    });
    setRoomHash(null);
    syncLock(wasLocked);
    closeConnection();
  },

  playAgain: () => {
    const s = get();
    const r = s.room;
    if (!r || r.status !== 'finished') return;
    const color: RoomColorChoice =
      r.you === 'white' ? 'black' : r.you === 'black' ? 'white' : s.setup.color;
    const clock = r.clock ? { initialMs: r.clock.initialMs, incrementMs: r.clock.incrementMs } : null;
    const nick = s.seat?.nick || s.setup.nick;
    if (s.roomId) removeSeat(s.roomId);
    closeConnection();
    set({ phase: 'idle', roomId: undefined, room: undefined, seat: undefined });
    disposeMirror();
    setRoomHash(null);
    get().create({ nick, clock, color });
  },

  clearMessages: () => set({ error: undefined, notice: undefined }),
}));

// Other games cannot start while the user is in a room game (or waiting for the friend).
setPlayStartGuard(() => (isRoomBusy(useRoomStore.getState()) ? ROOM_RUNNING_TEXT : null), 'room');
setLiveStartGuard(() => (isRoomBusy(useRoomStore.getState()) ? ROOM_RUNNING_TEXT : null));

/**
 * Follows the `#/room/<id>` route: on install (page load) and on every hash change a room link
 * opens the Friend tab and its room. Returns the uninstall function.
 */
export function installRoomRoute(): () => void {
  pruneSeats();
  const check = () => {
    const id = parseRoomHash(globalThis.location?.hash ?? '');
    if (id) useRoomStore.getState().openLink(id);
  };
  check();
  globalThis.addEventListener?.('hashchange', check);
  return () => globalThis.removeEventListener?.('hashchange', check);
}

/** Test seam: replaces socket factory/clock/url and resets the store. */
export function configureRoom(next: Partial<RoomHooks>): void {
  resetRoom();
  hooks = { ...hooks, ...next };
}

/** Closes the connection, drops the room and restores the defaults (tests). */
export function resetRoom(): void {
  disposeMirror();
  const c = conn;
  conn = null;
  c?.close();
  unwatchAnalysis?.();
  unwatchAnalysis = null;
  analysisSuspended = false;
  requestSent = false;
  pendingNick = '';
  hooks = defaultHooks();
  useRoomStore.setState({
    phase: 'idle',
    roomId: undefined,
    room: undefined,
    seat: undefined,
    connection: 'off',
    premoves: [],
    pendingMove: undefined,
    setup: { ...DEFAULT_SETUP, nick: readNick() },
    error: undefined,
    notice: undefined,
  });
}
