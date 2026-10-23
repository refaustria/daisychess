import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { humanGameLockReason } from '../live/lock';
import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { installAutoReview } from '../review/autoReview';
import { useReviewStore } from '../review/reviewStore';
import { useAnalysisStore } from '../store/analysisStore';
import { useGameStore } from '../store/gameStore';
import { useSettingsStore } from '../store/settingsStore';
import { useUiStore } from '../store/uiStore';
import { configureRoom, installRoomRoute, isRoomLocked, resetRoom, useRoomStore } from './roomStore';
import { NICK_KEY, readSeat, writeSeat } from './storage';
import { fakeSockets, ROOM_ID, roomState, settle, TOKEN_A, TOKEN_B } from './testing';
import { claimRemainingMs, roomPlayers, roomStatusLine } from './view';
import { TEST_WELCOME } from '../engine/remoteTesting';

let net: ReturnType<typeof fakeSockets>;
let now = 50_000;

const room = () => useRoomStore.getState();
const sans = () => useGameStore.getState().moves.map((m) => m.san);

beforeEach(() => {
  localStorage.clear();
  history.replaceState(null, '', '/');
  now = 50_000;
  net = fakeSockets();
  configureRoom({ createSocket: net.create, reconnectDelay: () => 0, now: () => now });
  useGameStore.getState().reset();
  useGameStore.setState({ orientation: 'white' });
  useUiStore.setState({ activeTab: 'moves' });
  usePlayStore.setState({ mode: 'idle' });
  useLiveStore.setState({ status: 'idle' });
  useAnalysisStore.setState({ enabled: false });
  useSettingsStore.setState({ premoves: 'single' });
});

afterEach(() => {
  resetRoom();
});

/** Host flow up to the waiting room (Alice, white). */
async function hostWaiting() {
  room().create({ nick: '  Alice ', clock: { initialMs: 60_000, incrementMs: 1_000 }, color: 'white' });
  await settle();
  const s = net.last();
  expect(s.ofType('room.create')).toEqual([
    { type: 'room.create', nick: 'Alice', clock: { initialMs: 60_000, incrementMs: 1_000 }, color: 'white' },
  ]);
  s.emit({ type: 'room.seat', roomId: ROOM_ID, playerToken: TOKEN_A, color: 'white' });
  s.emit(
    roomState({
      status: 'waiting',
      players: { white: { nick: 'Alice', connected: true } },
      clock: { initialMs: 60_000, incrementMs: 1_000, white: 60_000, black: 60_000, running: null },
    }),
  );
  return s;
}

const clock = (white: number, black: number, running: 'white' | 'black' | null) => ({
  initialMs: 60_000,
  incrementMs: 1_000,
  white,
  black,
  running,
});

describe('room store: host flow', () => {
  it('create → seat → waiting → playing → moves → result', async () => {
    useAnalysisStore.setState({ enabled: true });
    const s = await hostWaiting();
    expect(s.sent[0]).toMatchObject({ type: 'hello', client: { name: 'chesslab-web-rooms' } });
    expect(s.sent[0]).not.toHaveProperty('token');
    expect(room().phase).toBe('room');
    expect(room().room?.status).toBe('waiting');
    expect(localStorage.getItem(NICK_KEY)).toBe('Alice');
    expect(readSeat(ROOM_ID)).toMatchObject({ playerToken: TOKEN_A, color: 'white', nick: 'Alice' });
    expect(location.hash).toBe(`#/room/${ROOM_ID}`);
    expect(roomStatusLine(room().room, false)).toBe('Waiting for your friend');
    // Waiting does not lock the engines yet.
    expect(isRoomLocked(room())).toBe(false);
    expect(useAnalysisStore.getState().enabled).toBe(true);

    s.emit(roomState({ clock: clock(60_000, 60_000, null) }));
    expect(isRoomLocked(room())).toBe(true);
    expect(humanGameLockReason()).toBe('room');
    expect(useAnalysisStore.getState().enabled).toBe(false);
    // Switching the engines on during the game is reverted.
    useAnalysisStore.getState().setEnabled(true);
    expect(useAnalysisStore.getState().enabled).toBe(false);
    expect(useGameStore.getState().headers).toMatchObject({ White: 'Alice', Black: 'Bob', TimeControl: '60+1' });
    expect(roomStatusLine(room().room, false)).toBe('Your move');

    // The user's move goes to the server (optimistic).
    expect(useGameStore.getState().makeMove('e2', 'e4')).toBe(true);
    expect(s.ofType('room.move')).toEqual([{ type: 'room.move', roomId: ROOM_ID, uci: 'e2e4' }]);
    expect(room().pendingMove).toBe('e2e4');
    expect(roomStatusLine(room().room, true)).toBe('Bob to move');
    s.emit(roomState({ moves: ['e2e4'], clock: clock(60_000, 60_000, null) }));
    expect(room().pendingMove).toBeUndefined();
    s.emit(roomState({ moves: ['e2e4', 'e7e5'], clock: clock(60_000, 60_000, 'white') }));
    expect(sans()).toEqual(['e4', 'e5']);

    s.emit(roomState({ moves: ['e2e4', 'e7e5'], status: 'finished', result: '0-1', reason: 'resign', clock: clock(55_000, 60_000, null) }));
    expect(room().room?.status).toBe('finished');
    expect(isRoomLocked(room())).toBe(false);
    expect(useAnalysisStore.getState().enabled).toBe(true);
    expect(roomStatusLine(room().room, false)).toBe('You lost — resignation');
    // The board is free after the game; the room no longer writes it.
    expect(useGameStore.getState().makeMove('g1', 'f3')).toBe(true);
    s.emit(roomState({ moves: ['e2e4', 'e7e5'], status: 'finished', result: '0-1', reason: 'resign', spectators: 1 }));
    expect(sans()).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('sends the server token from the settings in hello', async () => {
    useSettingsStore.setState({ serverToken: 'secret' });
    room().create({ nick: 'Al', clock: null, color: 'random' });
    await settle();
    expect(net.last().sent[0]).toMatchObject({ type: 'hello', token: 'secret' });
    useSettingsStore.setState({ serverToken: '' });
  });

  it('a create refused by the server returns to the form with the message', async () => {
    room().create({ nick: 'Al', clock: null, color: 'random' });
    await settle();
    net.last().emit({ type: 'room.error', code: 'too_many_rooms', message: 'slow down' });
    expect(room().phase).toBe('idle');
    expect(room().error).toMatch(/Too many games/);
    expect(room().connection).toBe('off');
  });

  it('an old server without rooms is reported', async () => {
    net = fakeSockets(TEST_WELCOME);
    configureRoom({ createSocket: net.create, reconnectDelay: () => 0, now: () => now });
    room().create({ nick: 'Al', clock: null, color: 'random' });
    await settle();
    expect(room().error).toBe('This server does not support games against a friend');
    expect(room().phase).toBe('idle');
  });

  it('a rejected move is rolled back', async () => {
    const s = await hostWaiting();
    s.emit(roomState());
    useGameStore.getState().makeMove('e2', 'e4');
    s.emit({ type: 'room.error', roomId: ROOM_ID, code: 'illegal_move', message: 'nope' });
    expect(sans()).toEqual([]);
    expect(room().pendingMove).toBeUndefined();
    expect(room().error).toBe('Move rejected: nope');
  });

  it('a move on the opponent turn or after the game is undone', async () => {
    const s = await hostWaiting();
    s.emit(roomState({ moves: ['e2e4'] }));
    // Black to move: the store rejects a white move by turn; a black move is not ours → rolled back.
    useGameStore.getState().makeMove('e7', 'e5');
    expect(sans()).toEqual(['e4']);
    expect(s.ofType('room.move')).toEqual([]);
  });

  it('actions send the room messages', async () => {
    const s = await hostWaiting();
    s.emit(roomState());
    room().offerDraw();
    room().acceptDraw();
    room().declineDraw();
    room().abort();
    room().resign();
    room().claim();
    expect(s.sent.slice(-6).map((m) => [m.type, 'action' in m ? m.action : undefined])).toEqual([
      ['room.draw', 'offer'],
      ['room.draw', 'accept'],
      ['room.draw', 'decline'],
      ['room.abort', undefined],
      ['room.resign', undefined],
      ['room.claim', undefined],
    ]);
    s.emit({ type: 'room.error', roomId: ROOM_ID, code: 'bad_state', message: 'too early' });
    expect(room().notice).toBe('too early');
  });

  it('leave sends room.leave, clears the hash and closes the connection', async () => {
    const s = await hostWaiting();
    s.emit(roomState({ status: 'finished', result: '1-0', reason: 'resign', moves: ['e2e4', 'e7e5'] }));
    room().leave();
    expect(s.ofType('room.leave')).toHaveLength(1);
    expect(room().phase).toBe('idle');
    expect(location.hash).toBe('');
    expect(readSeat(ROOM_ID)).toBeNull();
    expect(s.closedWith).not.toBeNull();
  });

  it('play again creates a new room with the same clock and colours swapped', async () => {
    const s = await hostWaiting();
    s.emit(roomState({ status: 'finished', result: '1-0', reason: 'resign', moves: ['e2e4', 'e7e5'], clock: clock(1, 2, null) }));
    room().playAgain();
    await settle();
    expect(room().phase).toBe('creating');
    expect(net.last().ofType('room.create')).toEqual([
      { type: 'room.create', nick: 'Alice', clock: { initialMs: 60_000, incrementMs: 1_000 }, color: 'black' },
    ]);
  });
});

describe('room store: links, reload and reconnect', () => {
  it('a link without a stored seat asks for a nickname, then joins', async () => {
    localStorage.setItem(NICK_KEY, 'Bobby');
    resetRoom();
    configureRoom({ createSocket: net.create, reconnectDelay: () => 0, now: () => now });
    history.replaceState(null, '', `/#/room/${ROOM_ID}`);
    const uninstall = installRoomRoute();
    expect(useUiStore.getState().activeTab).toBe('friend');
    expect(room().phase).toBe('join');
    expect(room().setup.nick).toBe('Bobby');
    expect(net.sockets).toHaveLength(0);
    room().join('Bob');
    await settle();
    const s = net.last();
    expect(s.ofType('room.join')).toEqual([{ type: 'room.join', roomId: ROOM_ID, nick: 'Bob' }]);
    s.emit({ type: 'room.seat', roomId: ROOM_ID, playerToken: TOKEN_B, color: 'black' });
    s.emit(roomState({ you: 'black' }));
    expect(room().phase).toBe('room');
    expect(room().seat).toEqual({ color: 'black', nick: 'Bob' });
    expect(readSeat(ROOM_ID)).toMatchObject({ playerToken: TOKEN_B, color: 'black' });
    expect(useGameStore.getState().orientation).toBe('black');
    expect(roomStatusLine(room().room, false)).toBe('Alice to move');
    uninstall();
  });

  it('a full room makes the joiner a spectator (no lock, read-only)', async () => {
    room().openLink(ROOM_ID);
    room().join('Carol');
    await settle();
    net.last().emit(roomState({ you: 'spectator', spectators: 1, moves: ['d2d4'] }));
    expect(room().phase).toBe('room');
    expect(room().room?.you).toBe('spectator');
    expect(isRoomLocked(room())).toBe(false);
    expect(sans()).toEqual(['d4']);
    expect(roomStatusLine(room().room, false)).toBe('Bob to move');
  });

  it('a stored seat re-attaches on load (reload) and on reconnect', async () => {
    writeSeat(ROOM_ID, { playerToken: TOKEN_A, color: 'white', nick: 'Alice' });
    history.replaceState(null, '', `/#/room/${ROOM_ID}`);
    const uninstall = installRoomRoute();
    expect(room().phase).toBe('attaching');
    await settle();
    const s = net.last();
    expect(s.ofType('room.attach')).toEqual([{ type: 'room.attach', roomId: ROOM_ID, playerToken: TOKEN_A }]);
    expect(s.ofType('room.join')).toEqual([]);
    s.emit(roomState({ moves: ['e2e4', 'e7e5'], clock: clock(50_000, 40_000, 'white') }));
    expect(room().phase).toBe('room');
    expect(sans()).toEqual(['e4', 'e5']);
    expect(isRoomLocked(room())).toBe(true);

    // Connection lost: retry, then attach again.
    s.serverClose();
    expect(room().connection).toBe('retrying');
    await settle();
    const s2 = net.last();
    expect(s2).not.toBe(s);
    expect(room().connection).toBe('online');
    expect(s2.ofType('room.attach')).toEqual([{ type: 'room.attach', roomId: ROOM_ID, playerToken: TOKEN_A }]);
    uninstall();
  });

  it('bad_token falls back to the join card; room_not_found reads as expired', async () => {
    writeSeat(ROOM_ID, { playerToken: TOKEN_A, color: 'white', nick: 'Alice' });
    room().openLink(ROOM_ID);
    await settle();
    net.last().emit({ type: 'room.error', roomId: ROOM_ID, code: 'bad_token', message: 'x' });
    expect(room().phase).toBe('join');
    expect(readSeat(ROOM_ID)).toBeNull();

    room().join('Alice');
    await settle();
    net.last().emit({ type: 'room.error', roomId: ROOM_ID, code: 'room_not_found', message: 'gone' });
    expect(room().phase).toBe('expired');
  });

  it('a demoted seat (another tab attached) turns this tab into a spectator', async () => {
    const s = await hostWaiting();
    s.emit(roomState());
    s.emit(roomState({ you: 'spectator' }));
    expect(room().notice).toMatch(/another tab/);
    expect(isRoomLocked(room())).toBe(false);
  });

  it('ignores snapshots of other rooms and older snapshots', async () => {
    const s = await hostWaiting();
    const newer = roomState({ moves: ['e2e4'] });
    const older = { ...roomState({ moves: [] }), serverTime: newer.serverTime - 5 };
    s.emit(newer);
    s.emit(older);
    expect(room().room?.moves).toEqual(['e2e4']);
    s.emit(roomState({ roomId: 'Other_0123456789abcdef', moves: ['d2d4', 'd7d5'] }));
    expect(room().room?.moves).toEqual(['e2e4']);
  });
});

describe('room store: premoves, clocks and claims', () => {
  it('a premove is sent as soon as it is the user turn and still legal', async () => {
    const s = await hostWaiting();
    s.emit(roomState({ moves: ['e2e4'] }));
    room().addPremove('g1f3');
    expect(room().premoves).toEqual(['g1f3']);
    s.emit(roomState({ moves: ['e2e4', 'e7e5'] }));
    await settle();
    expect(s.ofType('room.move').map((m) => m.uci)).toEqual(['g1f3']);
    expect(room().premoves).toEqual([]);
    expect(sans()).toEqual(['e4', 'e5', 'Nf3']);
  });

  it('an illegal premove is dropped; premoves off ignores them', async () => {
    const s = await hostWaiting();
    s.emit(roomState({ moves: ['e2e4'] }));
    room().addPremove('e4e5');
    s.emit(roomState({ moves: ['e2e4', 'e7e5'] }));
    await settle();
    expect(s.ofType('room.move')).toEqual([]);
    expect(room().premoves).toEqual([]);
    useSettingsStore.setState({ premoves: 'none' });
    s.emit(roomState({ moves: ['e2e4', 'e7e5', 'g1f3'], you: 'white' }));
    room().addPremove('d2d4');
    expect(room().premoves).toEqual([]);
  });

  it('clocks: only the running side ticks from the local arrival time', async () => {
    const s = await hostWaiting();
    s.emit(roomState({ moves: ['e2e4'], clock: clock(60_000, 60_000, null) }));
    now += 5_000;
    let p = roomPlayers(room().room!, now);
    expect(p.white.clock).toMatchObject({ ms: 60_000, state: 'idle', testId: 'friend-clock-white' });
    expect(p.black.clock).toMatchObject({ ms: 60_000, state: 'active' });
    expect(p.white).toMatchObject({ name: 'Alice', subtitle: 'you' });
    s.emit(roomState({ moves: ['e2e4', 'e7e5'], clock: clock(59_000, 58_000, 'white') }));
    now += 1_500;
    p = roomPlayers(room().room!, now);
    expect(p.white.clock).toMatchObject({ ms: 57_500, state: 'running' });
    expect(p.black.clock).toMatchObject({ ms: 58_000, state: 'idle' });
    s.emit(
      roomState({
        moves: ['e2e4', 'e7e5'],
        status: 'finished',
        result: '0-1',
        reason: 'timeout',
        clock: clock(0, 58_000, null),
      }),
    );
    p = roomPlayers(room().room!, now);
    expect(p.white.clock?.state).toBe('flagged');
    expect(p.black.clock?.state).toBe('idle');
  });

  it('claim countdown from claimableAt, in server time', async () => {
    const s = await hostWaiting();
    const st = roomState({
      moves: ['e2e4', 'e7e5'],
      players: { white: { nick: 'Alice', connected: true }, black: { nick: 'Bob', connected: false } },
    });
    s.emit({ ...st, claimableAt: st.serverTime + 42_000 });
    expect(claimRemainingMs(room().room!, now)).toBe(42_000);
    expect(roomPlayers(room().room!, now).black.subtitle).toBe('disconnected');
    now += 40_500;
    expect(Math.ceil(claimRemainingMs(room().room!, now)! / 1000)).toBe(2);
    now += 2_000;
    expect(claimRemainingMs(room().room!, now)).toBeLessThanOrEqual(0);
  });
});

describe('room store: other games and the review', () => {
  it('cannot create while an engine or lichess game runs, and blocks them while busy', async () => {
    usePlayStore.setState({ mode: 'playing' });
    room().create({ nick: 'Al', clock: null, color: 'white' });
    expect(room().phase).toBe('idle');
    expect(room().error).toMatch(/engine/);
    usePlayStore.setState({ mode: 'idle' });
    useLiveStore.setState({ status: 'playing' });
    room().create({ nick: 'Al', clock: null, color: 'white' });
    expect(room().error).toMatch(/lichess/);
    useLiveStore.setState({ status: 'idle' });

    await hostWaiting();
    usePlayStore.getState().start();
    expect(usePlayStore.getState().mode).toBe('idle');
    expect(usePlayStore.getState().message).toMatch(/friend/);
  });

  it('a finished room game is reviewed automatically; a running review is cancelled at the start', async () => {
    const uninstall = installAutoReview();
    const cancel = useReviewStore.getState().cancel;
    let cancelled = 0;
    const start = useReviewStore.getState().start;
    let started = 0;
    useReviewStore.setState({
      status: 'running',
      cancel: () => {
        cancelled++;
      },
      start: () => {
        started++;
        return Promise.resolve(undefined);
      },
    });
    try {
      const s = await hostWaiting();
      s.emit(roomState());
      expect(cancelled).toBe(1);
      expect(started).toBe(0);
      s.emit(roomState({ moves: ['f2f3', 'e7e5', 'g2g4'] }));
      s.emit(roomState({ moves: ['f2f3', 'e7e5', 'g2g4', 'd8h4'], status: 'finished', result: '0-1', reason: 'checkmate' }));
      expect(started).toBe(1);
      expect(sans()).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
      expect(useUiStore.getState().activeTab).not.toBe('review');
    } finally {
      useReviewStore.setState({ status: 'idle', cancel, start });
      uninstall();
    }
  });
});
