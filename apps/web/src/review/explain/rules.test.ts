import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import {
  applyUci,
  buildContext,
  findRule,
  forkAllowed,
  isEnPrise,
  materialBalance,
  missedCapture,
  moverCp,
  moverMate,
  pieceHangs,
  replayBoard,
  sanLine,
  unitsLost,
} from './rules';
import { inputOf, legalLine, RULE_CASES, type CaseSpec } from './testPositions';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('applyUci / replayBoard (board-only replay)', () => {
  it('agrees with chess.js on captures, castling, en passant and promotion', () => {
    // 1. e4 d5 2. exd5 c5 3. dxc6 (e.p.) Nf6 4. cxb7 e6 5. bxa8=Q ... and White castles.
    const line = [
      'e2e4',
      'd7d5',
      'e4d5',
      'c7c5',
      'd5c6',
      'g8f6',
      'c6b7',
      'e7e6',
      'b7a8q',
      'f8e7',
      'g1f3',
      'e8g8',
      'f1e2',
      'b8c6',
      'e1g1',
    ];
    legalLine(START, line); // chess.js accepts the whole line
    const r = replayBoard(START, line, 99)!;
    expect(r.moves).toHaveLength(line.length);
    const ref = new Chess(START);
    for (const u of line) ref.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
    expect(r.end.fen().split(' ')[0]).toBe(ref.fen().split(' ')[0]);
    expect(r.moves[4]).toMatchObject({ from: 'd5', to: 'c6', captured: 'p' }); // en passant
    expect(r.moves[8]).toMatchObject({ captured: 'r', promotion: 'q', piece: 'p', lan: 'b7a8q' });
    expect(r.first?.get('e4')).toEqual({ type: 'p', color: 'w' });
  });

  it('stops at a move that does not fit the board', () => {
    const r = replayBoard(START, ['e2e4', 'e7e5', 'e4e5', 'g8f6'])!;
    expect(r.moves.map((m) => m.lan)).toEqual(['e2e4', 'e7e5']); // pawn cannot push into a pawn
    expect(replayBoard(START, ['e2e5'])!.moves).toEqual([]); // no triple step
    expect(replayBoard(START, ['f1c4'])!.moves).toEqual([]); // blocked bishop
    expect(replayBoard(START, ['e7e5'])!.moves).toEqual([]); // wrong side
    expect(replayBoard(START, ['e1g1'])!.moves).toEqual([]); // castling through pieces
    expect(replayBoard(START, ['xyz'])!.moves).toEqual([]);
    expect(replayBoard('not a fen', ['e2e4'])).toBeUndefined();
  });

  it('caps the replay at 8 plies', () => {
    const line = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3'];
    expect(replayBoard(START, line)!.moves).toHaveLength(8);
  });

  it('never takes a king', () => {
    const fen = '4k3/8/8/8/8/8/8/4RK2 w - - 0 1';
    expect(applyUci(new Chess(fen), 'e1e8', 'w')).toBeUndefined();
  });

  it('sanLine uses full legality (a pinned piece cannot move)', () => {
    const pinned = '4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1';
    expect(sanLine(pinned, ['e2c3'])).toEqual([]);
    expect(replayBoard(pinned, ['e2c3'])!.moves).toHaveLength(1); // board replay is pseudo-legal
    expect(sanLine(START, ['e2e4', 'e7e5', 'g1f3'])).toEqual(['e4', 'e5', 'Nf3']);
    expect(sanLine(START, ['e2e4', 'e7e5'], 1)).toEqual(['e4']);
  });
});

describe('material and attacks', () => {
  it('materialBalance counts 1/3/3/5/9 from one side', () => {
    const c = new Chess('4k3/8/8/8/8/8/8/R2QK3 w - - 0 1');
    expect(materialBalance(c, 'w')).toBe(14);
    expect(materialBalance(c, 'b')).toBe(-14);
  });

  it('unitsLost lists the vanished units, most valuable first', () => {
    const a = new Chess('r2qk3/pp6/8/8/8/8/8/4K3 w - - 0 1');
    const b = new Chess('4k3/p7/8/8/8/8/8/4K3 w - - 0 1');
    expect(unitsLost(a, b, 'b')).toEqual(['q', 'r', 'p']);
    expect(unitsLost(a, b, 'w')).toEqual([]);
  });

  it('isEnPrise: undefended, or attacked by a cheaper unit', () => {
    // Knight e5 attacked by the d6 pawn (cheaper); bishop c4 attacked only by the queen and
    // defended by the knight; the rook on h1 stands undefended on the queen's diagonal.
    const c = new Chess('4k3/8/3p4/3qN3/2B5/8/8/4K2R w - - 0 1');
    expect(isEnPrise(c, 'e5', 'w')).toBe(true);
    expect(isEnPrise(c, 'c4', 'w')).toBe(false);
    expect(isEnPrise(c, 'h1', 'w')).toBe(true);
    expect(isEnPrise(c, 'd6', 'w')).toBe(false); // not White's unit
    expect(isEnPrise(new Chess('4k3/8/8/8/8/8/8/4K2R w - - 0 1'), 'h1', 'w')).toBe(false);
    expect(isEnPrise(c, 'e1', 'w')).toBe(false); // kings are never en prise
    // A rook attacked by a rook but defended is not en prise.
    expect(isEnPrise(new Chess('3rk3/8/8/8/8/8/8/3RK3 w - - 0 1'), 'd1', 'w')).toBe(false);
  });

  it('moverMate / moverCp flip for Black', () => {
    expect(moverMate({ mate: 3 }, 'white')).toBe(3);
    expect(moverMate({ mate: 3 }, 'black')).toBe(-3);
    expect(moverMate({ cp: 10 }, 'white')).toBeNull();
    expect(moverCp({ cp: 120 }, 'black')).toBe(-120);
    expect(moverCp({ mate: 1 }, 'black')).toBeNull();
  });
});

const ctxOf = (spec: CaseSpec) => buildContext(inputOf(spec))!;
const caseNamed = (prefix: string) => RULE_CASES.find((c) => c.name.startsWith(prefix))!;

describe('predicates', () => {
  it('piece_hangs prefers the unit taken first, and reports a moved one', () => {
    const f = pieceHangs(ctxOf(caseNamed('piece_hangs: 3. Nxe5')));
    expect(f).toEqual({
      rule: 'piece_hangs',
      square: 'e5',
      piece: 'n',
      moved: true,
      alreadyHanging: false,
      capturePly: 0,
    });
  });

  it('piece_hangs: a unit already en prise that was not moved is "not saved"', () => {
    const f = pieceHangs(ctxOf(caseNamed('piece_hangs: h3')));
    expect(f).toMatchObject({ square: 'e5', moved: false, alreadyHanging: true });
  });

  it('piece_hangs needs the line to take it: a recaptured trade is not a hanging piece', () => {
    // 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Bxc6 dxc6: the bishop "hangs" on c6 but it is a trade.
    const spec: CaseSpec = {
      name: 'trade',
      fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
      played: 'b5c6',
      best: ['b5a4'],
      evalBefore: { cp: 40 },
      evalAfter: { cp: 10 },
      reply: ['d7c6', 'e1g1'],
    };
    expect(pieceHangs(ctxOf(spec))).toBeUndefined();
    expect(findRule(ctxOf(spec)).rule).toBe('eval_drop');
  });

  it('fork_allowed is not a fork when the forking unit can just be taken', () => {
    // Nc7+ "forks" king and rook, but the queen on d8 takes the undefended knight.
    const spec: CaseSpec = {
      name: 'guarded',
      fen: 'r2qk2r/pp3ppp/8/1N6/6Q1/7P/PP3PP1/5RK1 b kq - 0 1',
      played: 'h7h6',
      best: ['e8g8'],
      evalBefore: { cp: -575 },
      evalAfter: { cp: -500 },
      reply: ['b5c7', 'd8c7'],
    };
    expect(forkAllowed(ctxOf(spec))).toBeUndefined();
  });

  it('missed_capture: a capture that wins nothing is not reported', () => {
    // 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6: Bxc6 dxc6 is an even trade.
    const spec: CaseSpec = {
      name: 'even trade',
      fen: 'r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
      played: 'b5a4',
      best: ['b5c6', 'd7c6', 'e1g1'],
      evalBefore: { cp: 40 },
      evalAfter: { cp: 30 },
      reply: ['g8f6'],
    };
    expect(missedCapture(ctxOf(spec))).toBeUndefined();
  });

  it('buildContext rejects unreadable positions', () => {
    const input = inputOf(caseNamed('eval_drop: 2. a3'));
    expect(buildContext({ ...input, detail: { ...input.detail, fenAfter: 'x' } })).toBeUndefined();
  });
});
