import { describe, expect, it } from 'vitest';
import type { GameClock } from '../../clock/gameClock';
import type { LiveGame } from '../../live/LiveGameController';
import { START_FEN, type MoveRecord } from '../../store/gameStore';
import {
  liveClockState,
  liveClockTicks,
  selectBoardPlayers,
  type BoardPlayersInput,
} from './boardPlayers';

const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const e4: MoveRecord = { san: 'e4', from: 'e2', to: 'e4', fen: AFTER_E4 };

const liveGame = (over: Partial<LiveGame> = {}): LiveGame => ({
  id: 'game1234',
  color: 'white',
  opponent: { name: 'Opp', rating: 1600, title: 'FM' },
  rated: true,
  clock: { initial: 600_000, increment: 5_000 },
  speed: 'rapid',
  status: 'started',
  moves: ['e2e4', 'e7e5'],
  firstToMove: 'white',
  wtime: 312_000,
  btime: 8_400,
  lastStateAt: 1_000,
  ...over,
});

const clock = (over: Partial<GameClock> = {}): GameClock => ({
  w: 180_000,
  b: 175_000,
  runningSide: null,
  lastTickAt: 0,
  flagged: null,
  initialMs: 180_000,
  incrementMs: 2_000,
  ...over,
});

const input = (over: Partial<BoardPlayersInput> = {}): BoardPlayersInput => ({
  live: { status: 'idle' },
  play: { mode: 'idle', playerColor: 'white', setup: { strength: '1500' }, clock: null },
  game: { headers: {}, startFen: START_FEN, moves: [] },
  now: 1_000,
  ...over,
});

describe('selectBoardPlayers: PGN clocks (M22-1)', () => {
  const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const AFTER_NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
  const moves: MoveRecord[] = [
    { ...e4, clock: { remainingMs: 300_000, spentMs: 0 } },
    { san: 'e5', from: 'e7', to: 'e5', fen: AFTER_E5, clock: { remainingMs: 295_000 } },
    { san: 'Nf3', from: 'g1', to: 'f3', fen: AFTER_NF3, clock: { remainingMs: 25_000 } },
  ];
  const timeControl = { initialMs: 300_000, incrementMs: 0 };
  const at = (ply: number, over: Partial<BoardPlayersInput['game']> = {}) =>
    selectBoardPlayers(
      input({ game: { headers: {}, startFen: START_FEN, moves, ply, timeControl, ...over } }),
    );

  it('initial time before the first move, then the value after the side’s latest move', () => {
    expect(at(0).white.clock).toEqual({
      ms: 300_000,
      state: 'idle',
      initialMs: 300_000,
      testId: 'pgn-clock-white',
    });
    expect(at(0).black.clock?.ms).toBe(300_000);
    expect(at(1).black.clock?.ms).toBe(300_000);
    expect(at(2).black.clock?.ms).toBe(295_000);
    expect(at(2).white.clock?.ms).toBe(300_000);
    expect(at(3).white.clock?.ms).toBe(25_000);
    expect(at(3).black.clock?.ms).toBe(295_000);
    expect(at(3).source).toBe('pgn');
  });

  it('defaults to the tip; without a time control the first value is the initial time', () => {
    const p = at(0, { ply: undefined, timeControl: undefined });
    expect(p.white.clock?.ms).toBe(25_000);
    expect(p.white.clock?.initialMs).toBe(300_000);
    expect(at(0, { timeControl: undefined }).black.clock?.ms).toBe(295_000);
  });

  it('no clocks without clock data or outside the PGN source', () => {
    expect(at(2, { moves: [e4] }).white.clock).toBeUndefined();
    const play = selectBoardPlayers(
      input({
        play: { mode: 'playing', playerColor: 'white', setup: { strength: '1500' }, clock: null },
        game: { headers: {}, startFen: START_FEN, moves, ply: 2, timeControl },
      }),
    );
    expect(play.source).toBe('play');
    expect(play.white.clock).toBeUndefined();
  });
});

describe('selectBoardPlayers', () => {
  it('defaults to White/Black without a game or headers', () => {
    const p = selectBoardPlayers(input());
    expect(p).toEqual({
      source: 'pgn',
      white: { name: 'White', subtitle: undefined },
      black: { name: 'Black', subtitle: undefined },
    });
  });

  it('PGN headers: names, title and Elo; "?" placeholders are ignored', () => {
    const p = selectBoardPlayers(
      input({
        game: {
          headers: {
            White: 'Carlsen, Magnus',
            WhiteElo: '2830',
            WhiteTitle: 'GM',
            Black: '?',
            BlackElo: '?',
          },
          startFen: START_FEN,
          moves: [],
        },
      }),
    );
    expect(p.white).toEqual({ name: 'Carlsen, Magnus', subtitle: 'GM 2830' });
    expect(p.black).toEqual({ name: 'Black', subtitle: undefined });
    expect(p.white.clock).toBeUndefined();
  });

  it('engine game as White: You vs Stockfish with the preset, your clock runs', () => {
    const p = selectBoardPlayers(
      input({
        play: {
          mode: 'playing',
          playerColor: 'white',
          setup: { strength: '2100' },
          clock: clock({ runningSide: 'w' }),
        },
        game: { headers: { White: 'ignored' }, startFen: START_FEN, moves: [] },
      }),
    );
    expect(p.source).toBe('play');
    expect(p.white).toEqual({
      name: 'You',
      clock: { ms: 180_000, state: 'running', initialMs: 180_000, testId: 'play-clock-you' },
    });
    expect(p.black.name).toBe('Stockfish');
    expect(p.black.subtitle).toBe('2100 Elo');
    expect(p.black.clock).toEqual({
      ms: 175_000,
      state: 'idle',
      initialMs: 180_000,
      testId: 'play-clock-engine',
    });
  });

  it('game vs Maia: the opponent is "Maia 1500", human-like (M23-2)', () => {
    const p = selectBoardPlayers(
      input({
        play: {
          mode: 'playing',
          playerColor: 'white',
          setup: { strength: 'maia-1500' },
          clock: null,
        },
        game: { headers: {}, startFen: START_FEN, moves: [] },
      }),
    );
    expect(p.black).toEqual({ name: 'Maia 1500', subtitle: 'human-like', clock: undefined });
    expect(p.white.name).toBe('You');
  });

  it('engine game as Black: the side to move is active before its clock runs', () => {
    const p = selectBoardPlayers(
      input({
        play: {
          mode: 'playing',
          playerColor: 'black',
          setup: { strength: 'full' },
          clock: clock(),
        },
        game: { headers: {}, startFen: START_FEN, moves: [e4] },
      }),
    );
    expect(p.black.name).toBe('You');
    expect(p.black.clock?.state).toBe('active');
    expect(p.white.subtitle).toBe('Full strength');
    expect(p.white.clock?.state).toBe('idle');
  });

  it('finished engine game: flagged side, nobody active; no clock without a time control', () => {
    const finished = selectBoardPlayers(
      input({
        play: {
          mode: 'finished',
          playerColor: 'white',
          setup: { strength: '1500' },
          clock: clock({ w: 0, flagged: 'w' }),
        },
      }),
    );
    expect(finished.white.clock?.state).toBe('flagged');
    expect(finished.black.clock?.state).toBe('idle');
    const noClock = selectBoardPlayers(
      input({
        play: { mode: 'playing', playerColor: 'white', setup: { strength: '1500' }, clock: null },
      }),
    );
    expect(noClock.white).toEqual({ name: 'You', clock: undefined });
    expect(noClock.black.clock).toBeUndefined();
  });

  it('live game: lichess names, title/rating, clocks with local ticking of the side to move', () => {
    const p = selectBoardPlayers(
      input({
        live: { status: 'playing', game: liveGame(), username: 'Me' },
        // A local engine game never runs together with a live one, but live wins anyway.
        play: {
          mode: 'playing',
          playerColor: 'black',
          setup: { strength: '1500' },
          clock: clock(),
        },
        now: 3_000,
      }),
    );
    expect(p.source).toBe('live');
    expect(p.white).toEqual({
      name: 'Me',
      subtitle: 'You',
      clock: { ms: 310_000, state: 'running', initialMs: 600_000, testId: 'clock-white' },
    });
    expect(p.black).toEqual({
      name: 'Opp',
      subtitle: 'FM 1600',
      clock: { ms: 8_400, state: 'idle', initialMs: 600_000, testId: 'clock-black' },
    });
  });

  it('live game as Black against the lichess AI, without a clock and without a username', () => {
    const p = selectBoardPlayers(
      input({
        live: {
          status: 'playing',
          game: liveGame({
            color: 'black',
            clock: null,
            opponent: { name: 'Stockfish', aiLevel: 3 },
          }),
        },
      }),
    );
    expect(p.black).toEqual({ name: 'You', subtitle: undefined, clock: undefined });
    expect(p.white).toEqual({ name: 'Stockfish', subtitle: 'level 3', clock: undefined });
  });

  it('a finished live game stays until the user leaves; idle/seeking fall through', () => {
    const over = liveGame({ status: 'outoftime', reason: 'outoftime', winner: 'black', wtime: 0 });
    const p = selectBoardPlayers(input({ live: { status: 'finished', game: over } }));
    expect(p.source).toBe('live');
    expect(p.white.clock?.state).toBe('flagged');
    expect(p.black.clock?.state).toBe('idle');
    expect(selectBoardPlayers(input({ live: { status: 'seeking', game: over } })).source).toBe(
      'pgn',
    );
  });

  it('a friend game (future source) wins over everything', () => {
    const friend = { white: { name: 'Anna' }, black: { name: 'Ben', subtitle: 'friend' } };
    const p = selectBoardPlayers(input({ friend, live: { status: 'playing', game: liveGame() } }));
    expect(p).toEqual({ ...friend, source: 'friend' });
  });
});

describe('liveClockState / liveClockTicks', () => {
  it('before both first moves the side to move is active, not running', () => {
    const g = liveGame({ moves: ['e2e4'] });
    expect(liveClockState(g, 'black')).toBe('active');
    expect(liveClockState(g, 'white')).toBe('idle');
    expect(liveClockTicks(g)).toBe(false);
  });

  it('runs from move 2; a game without a clock only highlights; finished games do not tick', () => {
    expect(liveClockTicks(liveGame())).toBe(true);
    expect(liveClockState(liveGame({ clock: null }), 'white')).toBe('active');
    expect(liveClockTicks(liveGame({ clock: null }))).toBe(false);
    expect(liveClockTicks(liveGame({ status: 'mate' }))).toBe(false);
    expect(liveClockTicks(undefined)).toBe(false);
    expect(liveClockState(liveGame({ status: 'resign', winner: 'white' }), 'black')).toBe('idle');
  });
});
