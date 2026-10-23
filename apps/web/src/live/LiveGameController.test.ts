import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useGameStore } from '../store/gameStore';
import { BoardApiError } from './boardApi';
import {
  formatClock,
  LiveGameController,
  reconnectDelay,
  remainingMs,
  type LiveGame,
} from './LiveGameController';
import { fakeBoardApi, flush, gameFull, gameState, type FakeBoardApi } from './testing';

let api: FakeBoardApi;
let ctl: LiveGameController;
let now = 1_000;
let changes: LiveGame[];
let finished: LiveGame[];
let errors: string[];
let premoveLists: (readonly string[])[] = [];
let mode: 'none' | 'single' | 'queue' = 'single';
const sleeps: number[] = [];

const sans = () => useGameStore.getState().moves.map((m) => m.san);
const last = () => changes.at(-1)!;

function make(username = 'me') {
  ctl = new LiveGameController({
    api,
    game: useGameStore,
    gameId: 'game1234',
    username,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onChange: (g) => changes.push(g),
    onFinish: (g) => finished.push(g),
    onError: (m) => errors.push(m),
    premoveMode: () => mode,
    onPremoves: (l) => premoveLists.push(l),
  });
  void ctl.start();
  return api.gameStreams.at(-1)!;
}

beforeEach(() => {
  useGameStore.getState().reset();
  useGameStore.setState({ orientation: 'white' });
  api = fakeBoardApi();
  now = 1_000;
  changes = [];
  finished = [];
  errors = [];
  premoveLists = [];
  mode = 'single';
  sleeps.length = 0;
});

afterEach(() => ctl?.dispose());

describe('LiveGameController mirror', () => {
  it('replays gameFull into the store (orientation, headers) and appends new moves', async () => {
    useGameStore.getState().makeMove('d2', 'd4'); // an old game on the board
    const s = make('Opp');
    s.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    const g = useGameStore.getState();
    expect(sans()).toEqual(['e4', 'e5']);
    expect(g.ply).toBe(2);
    expect(g.orientation).toBe('black');
    expect(g.headers).toMatchObject({ White: 'Me', Black: 'Opp', Site: 'https://lichess.org/game1234', TimeControl: '600+0' });
    expect(last()).toMatchObject({ color: 'black', opponent: { name: 'Me', rating: 1500 }, moves: ['e2e4', 'e7e5'] });
    s.push(gameState('e2e4 e7e5 g1f3'));
    await flush();
    expect(sans()).toEqual(['e4', 'e5', 'Nf3']);
    expect(useGameStore.getState().ply).toBe(3);
  });

  it('never moves the view of a user browsing earlier moves, and never truncates', async () => {
    const s = make();
    s.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    useGameStore.getState().goTo(1);
    s.push(gameState('e2e4 e7e5 g1f3 b8c6'));
    await flush();
    expect(sans()).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(useGameStore.getState().ply).toBe(1);
  });

  it('rebuilds the store from lichess when it was changed locally (New game, a move on an earlier ply)', async () => {
    const s = make();
    s.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    useGameStore.getState().reset();
    expect(sans()).toEqual(['e4', 'e5']);
    useGameStore.getState().goTo(1);
    useGameStore.getState().makeMove('c7', 'c5'); // would truncate
    expect(sans()).toEqual(['e4', 'e5']);
    expect(api.calls.filter((c) => c.startsWith('move'))).toEqual([]);
  });
});

describe('LiveGameController user moves', () => {
  it('sends the user move (optimistic) and keeps it when lichess confirms', async () => {
    const s = make();
    s.push(gameFull());
    await flush();
    expect(ctl.isMyTurn()).toBe(true);
    expect(useGameStore.getState().makeMove('e2', 'e4')).toBe(true);
    await flush();
    expect(api.calls).toContain('move game1234 e2e4');
    expect(sans()).toEqual(['e4']);
    expect(ctl.isMyTurn()).toBe(false);
    s.push(gameState('e2e4'));
    await flush();
    expect(sans()).toEqual(['e4']);
    s.push(gameState('e2e4 c7c5'));
    await flush();
    expect(sans()).toEqual(['e4', 'c5']);
    expect(ctl.isMyTurn()).toBe(true);
  });

  it('rolls the move back when lichess rejects it (400)', async () => {
    const s = make();
    s.push(gameFull());
    await flush();
    api.failNextMove = new BoardApiError('bad_request', 'Not your turn, or game already over', { status: 400 });
    useGameStore.getState().makeMove('e2', 'e4');
    await flush();
    expect(sans()).toEqual([]);
    expect(errors[0]).toMatch(/Move rejected by lichess: Not your turn/);
  });

  it('rolls back a move on the opponent turn', async () => {
    const s = make();
    s.push(gameFull({ moves: 'e2e4' }));
    await flush();
    useGameStore.getState().makeMove('e7', 'e5'); // the opponent's piece; the board would not allow it
    expect(sans()).toEqual(['e4']);
    expect(api.calls.some((c) => c.startsWith('move'))).toBe(false);
  });

  it('plays a legal premove when it becomes the user turn', async () => {
    const s = make();
    s.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    useGameStore.getState().makeMove('g1', 'f3');
    s.push(gameState('e2e4 e7e5 g1f3'));
    await flush();
    ctl.addPremove('f1c4');
    await flush();
    expect(api.calls.filter((c) => c.startsWith('move'))).toEqual(['move game1234 g1f3']);
    expect(ctl.premoveList).toEqual(['f1c4']);
    s.push(gameState('e2e4 e7e5 g1f3 b8c6'));
    await flush();
    expect(api.calls.filter((c) => c.startsWith('move'))).toEqual(['move game1234 g1f3', 'move game1234 f1c4']);
    expect(sans()).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect(premoveLists.at(-1)).toEqual([]);
  });

  it('drops an illegal premove', async () => {
    const s = make();
    s.push(gameFull({ moves: 'e2e4 d7d5 e4d5' }));
    await flush();
    // Not our turn: the premove is kept; a1a5 is geometrically possible for a rook but illegal
    // (the a2 pawn blocks), so it is dropped when Black has moved.
    ctl.addPremove('a1a5');
    await flush();
    expect(ctl.premoveList).toEqual(['a1a5']);
    s.push(gameState('e2e4 d7d5 e4d5 d8d5'));
    await flush();
    expect(api.calls.some((c) => c.startsWith('move'))).toBe(false);
    expect(ctl.premoveList).toEqual([]);
    expect(sans()).toHaveLength(4);
  });
});

describe('LiveGameController premove queue', () => {
  it('queue mode: several premoves are sent in order, one per turn', async () => {
    mode = 'queue';
    const s = make();
    s.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    useGameStore.getState().makeMove('g1', 'f3');
    await flush();
    ctl.addPremove('f1c4');
    ctl.addPremove('e1g1');
    await flush();
    expect(ctl.premoveList).toEqual(['f1c4', 'e1g1']);
    s.push(gameState('e2e4 e7e5 g1f3 b8c6'));
    await flush();
    expect(ctl.premoveList).toEqual(['e1g1']);
    s.push(gameState('e2e4 e7e5 g1f3 b8c6 f1c4'));
    await flush();
    expect(ctl.premoveList).toEqual(['e1g1']); // still the opponent's turn
    s.push(gameState('e2e4 e7e5 g1f3 b8c6 f1c4 g8f6'));
    await flush();
    expect(api.calls.filter((c) => c.startsWith('move'))).toEqual([
      'move game1234 g1f3',
      'move game1234 f1c4',
      'move game1234 e1g1',
    ]);
    expect(sans().slice(-1)).toEqual(['O-O']);
  });

  it('the opponent move that makes the first premove illegal clears the whole queue', async () => {
    mode = 'queue';
    const s = make();
    s.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    useGameStore.getState().makeMove('d1', 'h5');
    await flush();
    ctl.addPremove('h5f7');
    ctl.addPremove('f1c4');
    expect(ctl.premoveList).toEqual(['h5f7', 'f1c4']);
    // g6 blocks the diagonal h5–f7: the first premove is illegal now, so the queue goes.
    s.push(gameState('e2e4 e7e5 d1h5 g7g6'));
    await flush();
    expect(ctl.premoveList).toEqual([]);
    expect(api.calls.filter((c) => c.startsWith('move'))).toEqual(['move game1234 d1h5']);
    expect(sans()).toHaveLength(4);
  });

  it('single mode replaces the premove, none ignores it', async () => {
    const s = make();
    s.push(gameFull({ moves: 'e2e4' }));
    await flush();
    ctl.addPremove('d2d4');
    ctl.addPremove('g1f3');
    expect(ctl.premoveList).toEqual(['g1f3']);
    ctl.clearPremoves();
    mode = 'none';
    ctl.addPremove('d2d4');
    expect(ctl.premoveList).toEqual([]);
  });
});

describe('LiveGameController clocks and state', () => {
  it('only the side to move ticks, from the second move on', async () => {
    const s = make();
    s.push(gameFull({ moves: 'e2e4' }));
    await flush();
    now += 5_000;
    expect(remainingMs(last(), 'black', now)).toBe(600_000); // clocks start after both moved
    s.push(gameState('e2e4 e7e5', { wtime: 590_000, btime: 598_000 }));
    await flush();
    now += 2_500;
    expect(remainingMs(last(), 'white', now)).toBe(587_500);
    expect(remainingMs(last(), 'black', now)).toBe(598_000);
    now += 1_000_000;
    expect(remainingMs(last(), 'white', now)).toBe(0);
  });

  it('formats clocks with tenths under ten seconds', () => {
    expect(formatClock(600_000)).toBe('10:00');
    expect(formatClock(61_999)).toBe('1:01');
    expect(formatClock(9_870)).toBe('0:09.8');
    expect(formatClock(-5)).toBe('0:00.0');
    expect(formatClock(3_725_000)).toBe('1:02:05');
  });

  it('tracks draw offers', async () => {
    const s = make();
    s.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    s.push(gameState('e2e4 e7e5', { bdraw: true }));
    await flush();
    expect(last().drawOffer).toBe('opponent');
    s.push(gameState('e2e4 e7e5', { wdraw: true }));
    await flush();
    expect(last().drawOffer).toBe('mine');
    s.push(gameState('e2e4 e7e5'));
    await flush();
    expect(last().drawOffer).toBeUndefined();
  });

  it('detects the finish (status, winner) and stops following the store', async () => {
    const s = make();
    s.push(gameFull({ moves: 'f2f3 e7e5 g2g4' }));
    await flush();
    s.push(gameState('f2f3 e7e5 g2g4 d8h4', { status: 'mate', winner: 'black' }));
    await flush();
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'mate', reason: 'mate', winner: 'black' });
    expect(sans()).toEqual(['f3', 'e5', 'g4', 'Qh4#']);
    // After the game the board is free again.
    useGameStore.getState().reset();
    expect(sans()).toEqual([]);
  });

  it('opponent gone: claim time from claimWinInSeconds, cleared when back', async () => {
    const s = make();
    s.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    s.push({ type: 'opponentGone', gone: true, claimWinInSeconds: 10 });
    await flush();
    expect(last().opponentGone).toEqual({ claimAt: now + 10_000 });
    s.push({ type: 'opponentGone', gone: false });
    await flush();
    expect(last().opponentGone).toBeUndefined();
  });
});

describe('LiveGameController stream', () => {
  it('reconnects with backoff when the stream drops and resyncs from gameFull', async () => {
    const s1 = make();
    s1.push(gameFull({ moves: 'e2e4' }));
    await flush();
    s1.end();
    await flush(10);
    expect(api.gameStreams).toHaveLength(2);
    expect(sleeps).toEqual([reconnectDelay(0)]);
    api.gameStreams[1]!.push(gameFull({ moves: 'e2e4 e7e5' }));
    await flush();
    expect(sans()).toEqual(['e4', 'e5']);
    api.gameStreams[1]!.fail(new BoardApiError('network', 'x'));
    await flush(10);
    expect(api.gameStreams).toHaveLength(3);
    expect(sleeps).toEqual([500, 500]); // the attempt counter resets after a received event
  });

  it('gives up with an error on unauthorized', async () => {
    const s = make();
    s.fail(new BoardApiError('unauthorized', 'Log in'));
    await flush(10);
    expect(errors).toEqual(['Log in']);
    expect(api.gameStreams).toHaveLength(1);
  });

  it('backoff grows and is capped', () => {
    expect([0, 1, 2, 3, 10].map(reconnectDelay)).toEqual([500, 1000, 2000, 4000, 30_000]);
  });
});
