import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveGame } from '../live/LiveGameController';
import { useLiveStore } from '../live/liveStore';
import { usePlayStore } from '../play/playStore';
import { gameKey } from '../review/reviewCache';
import { useReviewStore, type StoredReviewInfo } from '../review/reviewStore';
import { useRoomStore } from '../room/roomStore';
import type { RoomView } from '../room/view';
import { useGameStore } from '../store/gameStore';
import type { LedgerGameInput } from './gameLedger';
import { installLedger } from './installLedger';

const SCHOLAR =
  '[White "Alice"]\n[Black "Bob"]\n[Site "https://lichess.org/abcdefgh"]\n[Date "2026.10.01"]\n[Result "1-0"]\n\n1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0';

const STORED: StoredReviewInfo = {
  preset: 'fast',
  createdAt: 1,
  engine: { kind: 'browser' } as StoredReviewInfo['engine'],
  fromCache: false,
  source: 'local',
};

const record = vi.fn((g: LedgerGameInput) => Promise.resolve({ ...g }));
let names: string[] = [];
let uninstall: () => void = () => undefined;

/** The review store shows a finished review of the game on the board. */
function reviewDone(stored: StoredReviewInfo | null = { ...STORED }): void {
  useReviewStore.setState({
    status: 'done',
    reviewed: useGameStore.getState().moves,
    stored: stored ?? undefined,
  });
}

function playMoves(...uci: string[]): void {
  for (const m of uci) useGameStore.getState().makeMove(m.slice(0, 2), m.slice(2, 4));
}

const liveGame = (color: 'white' | 'black'): LiveGame =>
  ({ id: 'g1', color, moves: [], status: 'started' }) as unknown as LiveGame;

const room = (status: RoomView['status'], you: RoomView['you']): RoomView =>
  ({ status, you }) as unknown as RoomView;

beforeEach(() => {
  record.mockClear();
  names = [];
  useGameStore.getState().reset();
  useReviewStore.setState({ status: 'idle', reviewed: undefined, stored: undefined });
  usePlayStore.setState({ mode: 'idle', reason: undefined });
  useLiveStore.setState({ status: 'idle', game: undefined });
  useRoomStore.setState({ phase: 'idle', room: undefined });
  uninstall = installLedger({ record, names: () => names, now: () => 42 });
});

afterEach(() => {
  uninstall();
  usePlayStore.setState({ mode: 'idle', reason: undefined });
  useLiveStore.setState({ status: 'idle', game: undefined });
  useRoomStore.setState({ phase: 'idle', room: undefined });
  useReviewStore.setState({ status: 'idle', reviewed: undefined, stored: undefined });
});

describe('installLedger', () => {
  it('records a reviewed PGN with key, SAN moves, headers and a name-matched side', () => {
    names = ['BOB'];
    useGameStore.getState().loadPgn(SCHOLAR);
    reviewDone();
    expect(record).toHaveBeenCalledTimes(1);
    const g = useGameStore.getState();
    expect(record.mock.calls[0]![0]).toEqual({
      gameKey: gameKey(
        g.startFen,
        g.moves.map((m) => m.from + m.to + (m.promotion ?? '')),
      ),
      startFen: g.startFen,
      moves: ['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#'],
      headers: {
        White: 'Alice',
        Black: 'Bob',
        Site: 'https://lichess.org/abcdefgh',
        Date: '2026.10.01',
        Result: '1-0',
        url: 'https://lichess.org/abcdefgh',
      },
      source: 'import',
      userSide: 'black',
      reviewedAt: 42,
    });
  });

  it('leaves the side open without a name match', () => {
    useGameStore.getState().loadPgn('1. d4 d5 2. c4 e6');
    reviewDone();
    expect(record.mock.calls[0]![0]).toMatchObject({ source: 'pgn' });
    expect(record.mock.calls[0]![0]).not.toHaveProperty('userSide');
  });

  it('records once per shown review, again for a newly loaded one', () => {
    useGameStore.getState().loadPgn(SCHOLAR);
    reviewDone();
    useReviewStore.setState({ autoNotice: false });
    useReviewStore.setState({ status: 'done' });
    expect(record).toHaveBeenCalledTimes(1);
    // The stored review of the same game shown again (e.g. after a cache lookup).
    reviewDone({ ...STORED, fromCache: true });
    expect(record).toHaveBeenCalledTimes(2);
  });

  it('ignores reviews that are not stored, not finished or of another game', () => {
    useGameStore.getState().loadPgn(SCHOLAR);
    reviewDone(null);
    useReviewStore.setState({ status: 'running', stored: { ...STORED } });
    useReviewStore.setState({ status: 'error' });
    // A finished review of the previous moves array: the board has moved on.
    const old = useGameStore.getState().moves;
    useGameStore.getState().goTo(3);
    expect(useGameStore.getState().makeMove('f8', 'c5')).toBe(true);
    expect(useGameStore.getState().moves).not.toBe(old);
    expect(record).not.toHaveBeenCalled();
    useReviewStore.setState({ status: 'done', reviewed: old, stored: { ...STORED } });
    expect(record).not.toHaveBeenCalled();
  });

  it('ignores games shorter than the cached minimum', () => {
    playMoves('e2e4');
    reviewDone();
    expect(record).not.toHaveBeenCalled();
  });

  it('an engine game is recorded with the play store colour', () => {
    names = ['alice']; // the name match must not override the engine game's colour
    useGameStore.getState().loadPgn(SCHOLAR);
    usePlayStore.setState({ mode: 'playing', playerColor: 'black' });
    useGameStore.getState().reset();
    playMoves('e2e4', 'e7e5', 'g1f3');
    usePlayStore.setState({ mode: 'finished', reason: 'resign' });
    reviewDone();
    expect(record.mock.calls[0]![0]).toMatchObject({ source: 'play', userSide: 'black' });
  });

  it('a PGN loaded after an engine game is not taken for the engine game', () => {
    usePlayStore.setState({ mode: 'playing', playerColor: 'black' });
    playMoves('e2e4', 'e7e5');
    usePlayStore.setState({ mode: 'finished', reason: 'resign' });
    useGameStore.getState().loadPgn(SCHOLAR);
    reviewDone();
    expect(record.mock.calls[0]![0]).toMatchObject({ source: 'import' });
    expect(record.mock.calls[0]![0]).not.toHaveProperty('userSide');
  });

  it('an aborted engine game does not claim the next game', () => {
    usePlayStore.setState({ mode: 'playing', playerColor: 'white' });
    usePlayStore.setState({ mode: 'finished', reason: 'aborted' });
    useGameStore.getState().loadPgn('1. d4 d5 2. c4 e6');
    reviewDone();
    expect(record.mock.calls[0]![0]).toMatchObject({ source: 'pgn' });
  });

  it('an engine game started from the loaded position keeps its claim on the same headers', () => {
    useGameStore.getState().loadPgn('1. d4 d5');
    // "Play from here" keeps the headers object of the loaded game.
    usePlayStore.setState({ mode: 'playing', playerColor: 'white' });
    playMoves('c2c4', 'e7e6');
    usePlayStore.setState({ mode: 'finished', reason: 'checkmate' });
    reviewDone();
    expect(record.mock.calls[0]![0]).toMatchObject({ source: 'play', userSide: 'white' });
  });

  it('a live lichess game is recorded with the user colour, also when the headers arrive late', () => {
    useLiveStore.setState({ status: 'playing', game: liveGame('white') });
    useGameStore.setState({
      headers: { White: 'me', Black: 'opp', Site: 'https://lichess.org/g1' },
    });
    playMoves('e2e4', 'e7e5');
    useLiveStore.setState({ status: 'finished' });
    reviewDone();
    expect(record.mock.calls[0]![0]).toMatchObject({ source: 'live', userSide: 'white' });
  });

  it('a friend game is recorded with the room seat; spectators are no claim', () => {
    useRoomStore.setState({ phase: 'room', room: room('playing', 'black') });
    useGameStore.setState({ headers: { White: 'x', Black: 'y' } });
    playMoves('e2e4', 'e7e5');
    useRoomStore.setState({ room: room('finished', 'black') });
    reviewDone();
    expect(record.mock.calls[0]![0]).toMatchObject({ source: 'room', userSide: 'black' });

    record.mockClear();
    useRoomStore.setState({ phase: 'room', room: room('playing', 'spectator') });
    useGameStore.setState({ headers: { White: 'p', Black: 'q' } });
    useGameStore.getState().goTo(0);
    playMoves('d2d4', 'd7d5');
    useRoomStore.setState({ room: room('finished', 'spectator') });
    reviewDone();
    expect(record.mock.calls[0]![0]).toMatchObject({ source: 'pgn' });
    expect(record.mock.calls[0]![0]).not.toHaveProperty('userSide');
  });

  it('stops after uninstall', () => {
    uninstall();
    useGameStore.getState().loadPgn(SCHOLAR);
    reviewDone();
    expect(record).not.toHaveBeenCalled();
  });
});
