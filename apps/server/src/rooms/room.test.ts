import { describe, expect, it } from 'vitest';
import { ROOM_BOUNDS } from '@chesslab/engine-core';
import { Room, START_FEN, hasMatingMaterial, otherSide, type RoomOptions } from './room.js';

const T_HOST = 'host-token-'.padEnd(43, 'h');
const T_GUEST = 'guest-token-'.padEnd(43, 'g');
const GRACE = 60_000;

function room(partial: Partial<RoomOptions> = {}, now = 1_000): Room {
  return new Room({
    id: 'r'.repeat(22),
    now,
    host: { nick: 'Alice', token: T_HOST, color: 'white' },
    clock: null,
    claimGraceMs: GRACE,
    ...partial,
  });
}

/** A playing room (host White, guest Black). */
function playing(partial: Partial<RoomOptions> = {}, now = 1_000): Room {
  const r = room(partial, now);
  expect(r.join('Bob', T_GUEST, now)).toBe('black');
  return r;
}

const CLOCK = { initialMs: 60_000, incrementMs: 2_000 };
const FOOLS_MATE = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];

function play(r: Room, moves: string[], now: number): number {
  for (const uci of moves) {
    const res = r.move(r.sideToMove, uci, now);
    expect(res, uci).toEqual({ ok: true, changed: true });
  }
  return now;
}

describe('Room: seats', () => {
  it('starts waiting with the host on the chosen colour', () => {
    const r = room();
    expect(r.status).toBe('waiting');
    expect(r.hostColor).toBe('white');
    expect(r.players.white).toMatchObject({ nick: 'Alice', connected: true, disconnectedAt: null });
    expect(r.players.black).toBeNull();
    expect(r.freeSeat).toBe('black');
    expect(room({ host: { nick: 'A', token: T_HOST, color: 'black' } }).hostColor).toBe('black');
  });

  it('random colour uses the injected random source', () => {
    expect(
      room({ host: { nick: 'A', token: T_HOST, color: 'random' }, random: () => 0.2 }).hostColor,
    ).toBe('white');
    expect(
      room({ host: { nick: 'A', token: T_HOST, color: 'random' }, random: () => 0.7 }).hostColor,
    ).toBe('black');
  });

  it('join fills the free seat and starts the game; a second join fails', () => {
    const r = room({ clock: CLOCK });
    expect(r.join('Bob', T_GUEST, 5_000)).toBe('black');
    expect(r.status).toBe('playing');
    expect(r.lastActivityAt).toBe(5_000);
    expect(r.freeSeat).toBeNull();
    expect(r.join('Carol', 'x'.repeat(43), 6_000)).toBeNull();
    expect(r.players.black?.nick).toBe('Bob');
  });

  it('sideOfToken finds seats by token in any state, never by a wrong token', () => {
    const r = room();
    expect(r.sideOfToken(T_HOST)).toBe('white');
    expect(r.sideOfToken(T_GUEST)).toBeNull();
    expect(r.sideOfToken(T_HOST.slice(0, -1) + 'X')).toBeNull();
    r.join('Bob', T_GUEST, 1);
    expect(r.sideOfToken(T_GUEST)).toBe('black');
    expect(r.sideOfToken('')).toBeNull();
  });

  it('setConnected records the disconnect time and reports changes only', () => {
    const r = playing();
    expect(r.setConnected('black', false, 2_000)).toBe(true);
    expect(r.players.black).toMatchObject({ connected: false, disconnectedAt: 2_000 });
    expect(r.setConnected('black', false, 3_000)).toBe(false);
    expect(r.players.black?.disconnectedAt).toBe(2_000);
    expect(r.setConnected('black', true, 4_000)).toBe(true);
    expect(r.players.black).toMatchObject({ connected: true, disconnectedAt: null });
    expect(room().setConnected('black', false, 1)).toBe(false); // empty seat
  });
});

describe('Room: moves and game end', () => {
  it('rejects moves in a waiting room', () => {
    expect(room().move('white', 'e2e4', 1)).toEqual({
      ok: false,
      code: 'bad_state',
      message: expect.any(String),
    });
  });

  it('validates turn and legality, requires a promotion piece', () => {
    const r = playing();
    expect(r.move('black', 'e7e5', 1)).toMatchObject({ ok: false, code: 'not_your_turn' });
    expect(r.move('white', 'e2e5', 1)).toMatchObject({ ok: false, code: 'illegal_move' });
    expect(r.move('white', 'e2e4', 1)).toEqual({ ok: true, changed: true });
    expect(r.sideToMove).toBe('black');
    expect(r.moves).toEqual(['e2e4']);
    expect(r.fen()).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    // promotion: a7 pawn to a8 needs the piece
    play(r, ['d7d5', 'e4d5', 'c7c6', 'd5c6', 'b7b5', 'c6c7', 'b5b4'], 1);
    expect(r.move('white', 'c7b8', 1)).toMatchObject({ ok: false, code: 'illegal_move' });
    expect(r.move('white', 'c7b8q', 1)).toEqual({ ok: true, changed: true });
    expect(r.moves.at(-1)).toBe('c7b8q');
  });

  it('checkmate ends the game with the mover as winner', () => {
    const r = playing();
    play(r, FOOLS_MATE, 1);
    expect(r.status).toBe('finished');
    expect(r.result).toBe('0-1');
    expect(r.reason).toBe('checkmate');
    expect(r.finishedAt).toBe(1);
    expect(r.move('white', 'e2e4', 2)).toMatchObject({ ok: false, code: 'bad_state' });
  });

  it('stalemate is a draw', () => {
    const r = playing();
    // Fastest known stalemate (10 moves).
    play(
      r,
      [
        'e2e3',
        'a7a5',
        'd1h5',
        'a8a6',
        'h5a5',
        'h7h5',
        'h2h4',
        'a6h6',
        'a5c7',
        'f7f6',
        'c7d7',
        'e8f7',
        'd7b7',
        'd8d3',
        'b7b8',
        'd3h7',
        'b8c8',
        'f7g6',
        'c8e6',
      ],
      1,
    );
    expect(r.status).toBe('finished');
    expect(r.result).toBe('1/2-1/2');
    expect(r.reason).toBe('stalemate');
  });

  it('threefold repetition is an automatic draw', () => {
    const r = playing();
    play(r, ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'], 1);
    expect(r.status).toBe('finished');
    expect(r.result).toBe('1/2-1/2');
    expect(r.reason).toBe('draw');
  });

  it('a move clears a pending draw offer', () => {
    const r = playing();
    expect(r.draw('white', 'offer', 1)).toEqual({ ok: true, changed: true });
    expect(r.drawOffer).toBe('white');
    play(r, ['e2e4'], 1);
    expect(r.drawOffer).toBeNull();
  });

  it('maxPlies is the documented cap', () => {
    expect(ROOM_BOUNDS.maxPlies).toBe(1_000);
  });
});

describe('Room: resign, draw, abort', () => {
  it('resign gives the opponent the win; only while playing', () => {
    expect(room().resign('white', 1)).toMatchObject({ ok: false, code: 'bad_state' });
    const r = playing();
    expect(r.resign('black', 1)).toEqual({ ok: true, changed: true });
    expect(r.result).toBe('1-0');
    expect(r.reason).toBe('resign');
    expect(r.resign('white', 2)).toMatchObject({ ok: false, code: 'bad_state' });
  });

  it('draw: offer, accept, decline, counter-offer accepts, repeated offer is a no-op', () => {
    const r = playing();
    expect(r.draw('black', 'accept', 1)).toMatchObject({ ok: false, code: 'bad_state' });
    expect(r.draw('black', 'decline', 1)).toEqual({ ok: true, changed: false });
    expect(r.draw('white', 'offer', 1)).toEqual({ ok: true, changed: true });
    expect(r.draw('white', 'offer', 1)).toEqual({ ok: true, changed: false });
    expect(r.draw('white', 'accept', 1)).toMatchObject({ ok: false, code: 'bad_state' }); // own offer
    expect(r.draw('black', 'decline', 1)).toEqual({ ok: true, changed: true });
    expect(r.drawOffer).toBeNull();
    expect(r.draw('white', 'offer', 1)).toEqual({ ok: true, changed: true });
    expect(r.draw('white', 'decline', 1)).toEqual({ ok: true, changed: true }); // withdraw
    expect(r.drawOffer).toBeNull();
    expect(r.draw('black', 'offer', 1)).toEqual({ ok: true, changed: true });
    expect(r.draw('white', 'offer', 1)).toEqual({ ok: true, changed: true }); // = accept
    expect(r.status).toBe('finished');
    expect(r.result).toBe('1/2-1/2');
    expect(r.reason).toBe('agreement');
    expect(r.drawOffer).toBeNull();
    const r2 = playing();
    r2.draw('black', 'offer', 1);
    expect(r2.draw('white', 'accept', 1)).toEqual({ ok: true, changed: true });
    expect(r2.reason).toBe('agreement');
    expect(r2.draw('white', 'offer', 2)).toMatchObject({ ok: false, code: 'bad_state' });
  });

  it('abort: waiting room, or a game before both sides moved', () => {
    const w = room();
    expect(w.abort(1)).toEqual({ ok: true, changed: true });
    expect(w).toMatchObject({ status: 'finished', result: null, reason: 'abort' });
    expect(w.abort(2)).toMatchObject({ ok: false, code: 'bad_state' });
    const p = playing();
    play(p, ['e2e4'], 1);
    expect(p.abort(1)).toEqual({ ok: true, changed: true });
    expect(p.reason).toBe('abort');
    const late = playing();
    play(late, ['e2e4', 'e7e5'], 1);
    expect(late.abort(1)).toMatchObject({
      ok: false,
      code: 'bad_state',
      message: expect.stringMatching(/resign/),
    });
    expect(late.status).toBe('playing');
  });
});

describe('Room: clock', () => {
  it('no clock: nothing ticks, no deadline, snapshot clock is null', () => {
    const r = playing();
    play(r, ['e2e4', 'e7e5', 'g1f3'], 1);
    expect(r.remaining('white', 1_000_000)).toBeNull();
    expect(r.nextDeadline()).toBeNull();
    expect(r.tick(1_000_000)).toBe(false);
    expect(r.snapshot('white', 0, 1_000_000, 0).clock).toBeNull();
  });

  it('the first two plies are untimed and get no increment; the clock starts on the third', () => {
    const r = playing({ clock: CLOCK }, 1_000);
    expect(r.remaining('white', 50_000)).toBe(60_000);
    expect(r.nextDeadline()).toBeNull();
    play(r, ['e2e4'], 30_000); // White took 29 s: not charged
    expect(r.remaining('white', 30_000)).toBe(60_000);
    expect(r.remaining('black', 50_000)).toBe(60_000);
    play(r, ['e7e5'], 50_000); // Black's first move: no charge, no increment; White's clock starts
    expect(r.remaining('white', 50_000)).toBe(60_000);
    expect(r.remaining('black', 50_000)).toBe(60_000);
    expect(r.snapshot('white', 0, 50_000, 0).clock?.running).toBe('white');
    expect(r.remaining('white', 55_000)).toBe(55_000);
    expect(r.remaining('black', 55_000)).toBe(60_000);
    expect(r.nextDeadline()).toBe(110_000);
    play(r, ['g1f3'], 55_000); // charged 5 s, +2 s increment
    expect(r.remaining('white', 55_000)).toBe(57_000);
    expect(r.snapshot('white', 0, 55_000, 0).clock).toEqual({
      ...CLOCK,
      white: 57_000,
      black: 60_000,
      running: 'black',
    });
    expect(r.nextDeadline()).toBe(115_000);
  });

  it('tick flags the running side: timeout, opponent wins', () => {
    const r = playing({ clock: CLOCK }, 0);
    play(r, ['e2e4', 'e7e5'], 0);
    expect(r.tick(59_999)).toBe(false);
    expect(r.remaining('white', 59_999)).toBe(1);
    expect(r.tick(60_000)).toBe(true);
    expect(r).toMatchObject({ status: 'finished', result: '0-1', reason: 'timeout' });
    expect(r.remaining('white', 70_000)).toBe(0);
    expect(r.snapshot('white', 0, 70_000, 0).clock).toEqual({
      ...CLOCK,
      white: 0,
      black: 60_000,
      running: null,
    });
    expect(r.nextDeadline()).toBeNull();
  });

  it('a move that arrives after the flag is rejected and the flag stands', () => {
    const r = playing({ clock: CLOCK }, 0);
    play(r, ['e2e4', 'e7e5'], 0);
    expect(r.move('white', 'g1f3', 60_001)).toMatchObject({ ok: false, code: 'bad_state' });
    expect(r.reason).toBe('timeout');
    expect(r.moves).toEqual(['e2e4', 'e7e5']);
  });

  it('a timeout against a side that cannot mate is a draw (hasMatingMaterial)', () => {
    expect(hasMatingMaterial(START_FEN, 'white')).toBe(true);
    expect(hasMatingMaterial('8/8/8/8/8/8/k7/K7 w - - 0 1', 'white')).toBe(false);
    expect(hasMatingMaterial('8/8/8/8/8/8/k7/KN6 w - - 0 1', 'white')).toBe(false);
    expect(hasMatingMaterial('8/8/8/8/8/8/k7/KB6 w - - 0 1', 'white')).toBe(false);
    expect(hasMatingMaterial('8/8/8/8/8/8/k7/KB1B4 w - - 0 1', 'white')).toBe(false); // bishops on one colour
    expect(hasMatingMaterial('8/8/8/8/8/8/k7/KBB5 w - - 0 1', 'white')).toBe(true); // opposite colours
    expect(hasMatingMaterial('8/8/8/8/8/8/k7/KNN5 w - - 0 1', 'white')).toBe(true);
    expect(hasMatingMaterial('8/8/8/8/8/8/k7/KNB5 w - - 0 1', 'white')).toBe(true);
    expect(hasMatingMaterial('8/8/8/8/8/8/kp6/K7 w - - 0 1', 'black')).toBe(true);
    expect(hasMatingMaterial('8/8/8/8/8/8/k7/KR6 w - - 0 1', 'black')).toBe(false);
  });

  it('snapshot clock values are as of the given monotonic time', () => {
    const r = playing({ clock: CLOCK }, 0);
    play(r, ['e2e4', 'e7e5'], 0);
    expect(r.snapshot('black', 2, 10_000, 1_700_000_000_000)).toMatchObject({
      you: 'black',
      spectators: 2,
      clock: { white: 50_000, black: 60_000, running: 'white' },
      serverTime: 1_700_000_000_000,
    });
  });
});

describe('Room: disconnects, claims, expiry', () => {
  it('claimableAt: only while exactly the opponent is gone', () => {
    const r = playing();
    expect(r.claimableAt('white')).toBeNull();
    r.setConnected('black', false, 10_000);
    expect(r.claimableAt('white')).toBe(70_000);
    expect(r.claimableAt('black')).toBeNull();
    expect(r.nextDeadline()).toBe(70_000);
    const snap = r.snapshot('white', 0, 20_000, 1_000_000);
    expect(snap.claimableAt).toBe(1_050_000);
    expect(snap.players.black).toEqual({ nick: 'Bob', connected: false });
    r.setConnected('white', false, 15_000);
    expect(r.snapshot('white', 0, 20_000, 1_000_000).claimableAt).toBeUndefined();
    expect(room().claimableAt('white')).toBeNull();
  });

  it('claim: too early, opponent present, then a win after both moved', () => {
    const r = playing();
    play(r, ['e2e4', 'e7e5'], 1_000);
    expect(r.claim('white', 2_000)).toMatchObject({
      ok: false,
      code: 'bad_state',
      message: /connected/,
    });
    r.setConnected('black', false, 10_000);
    expect(r.claim('white', 40_000)).toMatchObject({
      ok: false,
      code: 'bad_state',
      message: 'you can claim in 30 s',
    });
    expect(r.claim('black', 80_000)).toMatchObject({ ok: false, code: 'bad_state' }); // the absent side
    expect(r.claim('white', 70_000)).toEqual({ ok: true, changed: true });
    expect(r).toMatchObject({ status: 'finished', result: '1-0', reason: 'abandoned' });
  });

  it('claim before both sides moved aborts without a result', () => {
    const r = playing();
    play(r, ['e2e4'], 0);
    r.setConnected('white', false, 0);
    expect(r.claim('black', GRACE)).toEqual({ ok: true, changed: true });
    expect(r).toMatchObject({ status: 'finished', result: null, reason: 'abandoned' });
  });

  it('both players gone beyond the grace: tick abandons the game', () => {
    const r = playing({ clock: CLOCK }, 0);
    play(r, ['e2e4', 'e7e5'], 0);
    r.setConnected('white', false, 1_000);
    r.setConnected('black', false, 5_000);
    expect(r.nextDeadline()).toBe(60_000); // the flag of White (60 s) comes before the grace (65 s)
    expect(r.tick(64_999)).toBe(true);
    expect(r.reason).toBe('timeout');
    const n = playing();
    play(n, ['e2e4', 'e7e5'], 0);
    n.setConnected('white', false, 1_000);
    n.setConnected('black', false, 5_000);
    expect(n.nextDeadline()).toBe(65_000);
    expect(n.tick(64_999)).toBe(false);
    expect(n.tick(65_000)).toBe(true);
    expect(n).toMatchObject({ status: 'finished', result: null, reason: 'abandoned' });
    expect(n.tick(70_000)).toBe(false);
  });

  it('a disconnected player keeps losing time', () => {
    const r = playing({ clock: CLOCK }, 0);
    play(r, ['e2e4', 'e7e5'], 0);
    r.setConnected('white', false, 10_000);
    expect(r.remaining('white', 30_000)).toBe(30_000);
    r.setConnected('white', true, 30_000);
    expect(r.remaining('white', 30_000)).toBe(30_000);
  });

  it('expire abandons a waiting or playing room, never a finished one', () => {
    const w = room();
    expect(w.expire(5)).toBe(true);
    expect(w).toMatchObject({
      status: 'finished',
      result: null,
      reason: 'abandoned',
      finishedAt: 5,
    });
    expect(w.expire(6)).toBe(false);
    const p = playing({ clock: CLOCK });
    play(p, ['e2e4', 'e7e5', 'g1f3'], 1_000);
    expect(p.expire(2_000)).toBe(true);
    expect(p.snapshot('white', 0, 9_000, 0).clock?.running).toBeNull();
  });

  it('snapshot: waiting room, finished room with result, spectator view', () => {
    const w = room({ clock: CLOCK }, 1_000);
    expect(w.snapshot('white', 0, 1_000, 2_000)).toEqual({
      type: 'room.state',
      roomId: 'r'.repeat(22),
      status: 'waiting',
      players: { white: { nick: 'Alice', connected: true } },
      you: 'white',
      spectators: 0,
      startFen: START_FEN,
      fen: START_FEN,
      moves: [],
      clock: { ...CLOCK, white: 60_000, black: 60_000, running: null },
      serverTime: 2_000,
    });
    const f = playing();
    play(f, FOOLS_MATE, 1);
    expect(f.snapshot('spectator', 3, 1, 1)).toMatchObject({
      status: 'finished',
      you: 'spectator',
      spectators: 3,
      moves: FOOLS_MATE,
      result: '0-1',
      reason: 'checkmate',
      players: {
        white: { nick: 'Alice', connected: true },
        black: { nick: 'Bob', connected: true },
      },
    });
    expect(f.snapshot('spectator', 3, 1, 1)).not.toHaveProperty('drawOffer');
    expect(f.snapshot('spectator', 3, 1, 1)).not.toHaveProperty('claimableAt');
  });

  it('otherSide', () => {
    expect(otherSide('white')).toBe('black');
    expect(otherSide('black')).toBe('white');
  });
});
