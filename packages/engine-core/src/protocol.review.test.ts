import { describe, expect, it } from 'vitest';
import {
  CapabilitiesSchema,
  GameKeySchema,
  LARGE_MESSAGE_TYPES,
  MAX_LARGE_MESSAGE_BYTES,
  MAX_MESSAGE_BYTES,
  OptsKeySchema,
  PositionResultSchema,
  REVIEW_BOUNDS,
  REVIEW_STORE_REASONS,
  ReviewEngineInfoSchema,
  ReviewGetMessageSchema,
  ReviewOptionsSchema,
  ReviewPositionsGetMessageSchema,
  ReviewPositionsMessageSchema,
  ReviewPositionsPutMessageSchema,
  ReviewPositionsStoredMessageSchema,
  ReviewPresetSchema,
  ReviewRecordMessageSchema,
  ReviewStatsGetMessageSchema,
  ReviewStatsMessageSchema,
  ReviewStoredMessageSchema,
  ReviewSummarySchema,
  ReviewedMoveSchema,
  SanMoveSchema,
  SanMovesSchema,
  SideSummarySchema,
  StoredMoveDetailSchema,
  StoredReviewRecordSchema,
  StoredReviewSchema,
  parseClientMessage,
  parseServerMessage,
  reviewGameKey,
  type StoredReview,
  type StoredReviewRecord,
} from './index.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const KEY = reviewGameKey(START, ['e2e4', 'e7e5']);

const counts = { best: 1, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0, forced: 0 };

export const RECORD: StoredReviewRecord = {
  version: 1,
  options: { movetime: 300 },
  engine: { kind: 'server', name: 'Stockfish 19', threads: 4 },
  summary: {
    white: { accuracy: 99.5, counts },
    black: { accuracy: 98, counts },
    moves: [
      {
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        mover: 'white',
        evalBefore: { cp: 20 },
        evalAfter: { cp: 30 },
        bestMove: 'e2e4',
        winProbBefore: 51,
        winProbAfter: 52,
        winProbLoss: 0,
        classification: 'best',
      },
      {
        ply: 2,
        san: 'e5',
        uci: 'e7e5',
        mover: 'black',
        evalBefore: { cp: 30 },
        evalAfter: { cp: 25 },
        winProbBefore: 48,
        winProbAfter: 49,
        winProbLoss: 0,
        classification: 'best',
      },
    ],
  },
  moveDetails: {
    '1': {
      ply: 1,
      mover: 'white',
      moveLabel: '1.',
      playedUci: 'e2e4',
      playedSan: 'e4',
      bestLine: ['e2e4', 'e7e5'],
      bestLineSan: '1. e4 e5',
      bestLineMoves: ['e4', 'e5'],
      bestLineFen: AFTER_E5,
      fenBefore: START,
      fenAfter: AFTER_E4,
      evalBeforeWhite: { cp: 20 },
      evalAfterWhite: { cp: 30 },
      swing: '+0.10',
      winProbLoss: 0,
      classification: 'best',
      playedIsBest: true,
    },
  },
};

export const STORED: StoredReview = {
  ...RECORD,
  gameKey: KEY,
  startFen: START,
  moves: ['e4', 'e5'],
  preset: 'fast',
  createdAt: 1_761_000_000_000,
};

describe('review store building blocks (ADR-017)', () => {
  it('exposes the bounds and reasons', () => {
    expect(REVIEW_BOUNDS.plies).toEqual({ min: 2, max: 1000 });
    expect(REVIEW_BOUNDS.positionsPerMessage).toBe(64);
    expect(REVIEW_BOUNDS.recordMaxBytes).toBe(1024 * 1024);
    expect(MAX_LARGE_MESSAGE_BYTES).toBeGreaterThan(REVIEW_BOUNDS.recordMaxBytes);
    expect(LARGE_MESSAGE_TYPES).toEqual([
      'review.put',
      'review.record',
      'review.positions.put',
      'review.positions',
    ]);
    expect(REVIEW_STORE_REASONS).toContain('unauthorized');
    expect(REVIEW_STORE_REASONS).toContain('key_mismatch');
  });

  it('validates game keys, SAN moves, option keys and presets', () => {
    expect(GameKeySchema.safeParse(KEY).success).toBe(true);
    expect(GameKeySchema.safeParse(KEY.toUpperCase()).success).toBe(false);
    expect(GameKeySchema.safeParse('abc').success).toBe(false);
    for (const san of ['e4', 'Nf3', 'exd5', 'O-O', 'O-O-O+', 'e8=Q#', 'Nbd7', 'R1a3', 'Qxf7#']) {
      expect(SanMoveSchema.safeParse(san).success, san).toBe(true);
    }
    for (const bad of ['', 'e2e4', 'e9', 'Z3', 'e8=K', 'O-O-O-O', 'Nf3!!', 'exd', 'e4=Q']) {
      expect(SanMoveSchema.safeParse(bad).success, bad).toBe(false);
    }
    expect(SanMovesSchema.safeParse(['e4']).success).toBe(false);
    expect(SanMovesSchema.safeParse(['e4', 'e5']).success).toBe(true);
    expect(SanMovesSchema.safeParse(new Array(1001).fill('e4')).success).toBe(false);
    for (const k of ['mt:300', 'mt:100', 'd:18', 'd:9', 'mt:600000']) {
      expect(OptsKeySchema.safeParse(k).success, k).toBe(true);
    }
    for (const k of ['mt:30', 'd:0', 'd:100', 'x:1', 'mt:', '', 'mt:3000000']) {
      expect(OptsKeySchema.safeParse(k).success, k).toBe(false);
    }
    expect(ReviewPresetSchema.options).toEqual(['fast', 'deep']);
    expect(ReviewOptionsSchema.safeParse({ depth: 18 }).success).toBe(true);
    expect(ReviewOptionsSchema.safeParse({ movetime: 50 }).success).toBe(false);
    expect(ReviewEngineInfoSchema.safeParse({ kind: 'browser' }).success).toBe(true);
    expect(ReviewEngineInfoSchema.safeParse({ kind: 'cloud' }).success).toBe(false);
  });

  it('validates position results', () => {
    expect(PositionResultSchema.safeParse({ eval: { cp: 12 } }).success).toBe(true);
    expect(
      PositionResultSchema.safeParse({
        eval: { mate: 3 },
        bestMove: 'e2e4',
        pv: ['e2e4', 'e7e5'],
        depth: 24,
      }).success,
    ).toBe(true);
    expect(PositionResultSchema.safeParse({ eval: { cp: 1, mate: 1 } }).success).toBe(false);
    expect(PositionResultSchema.safeParse({ eval: { cp: 1 }, pv: ['bogus'] }).success).toBe(false);
    expect(
      PositionResultSchema.safeParse({ eval: { cp: 1 }, pv: new Array(17).fill('e2e4') }).success,
    ).toBe(false);
  });

  it('validates summaries, move details and whole records', () => {
    expect(ReviewedMoveSchema.safeParse(RECORD.summary.moves[0]).success).toBe(true);
    expect(SideSummarySchema.safeParse(RECORD.summary.white).success).toBe(true);
    expect(SideSummarySchema.safeParse({ accuracy: 50, counts: { best: 1 } }).success).toBe(false);
    expect(ReviewSummarySchema.safeParse(RECORD.summary).success).toBe(true);
    expect(StoredMoveDetailSchema.safeParse(RECORD.moveDetails['1']).success).toBe(true);
    expect(
      StoredMoveDetailSchema.safeParse({ ...RECORD.moveDetails['1'], fenBefore: 'junk' }).success,
    ).toBe(false);
    expect(StoredReviewRecordSchema.safeParse(RECORD).success).toBe(true);
    expect(
      StoredReviewRecordSchema.safeParse({ ...RECORD, moveDetails: { x: RECORD.moveDetails['1'] } })
        .success,
    ).toBe(false);
    expect(StoredReviewRecordSchema.safeParse({ ...RECORD, version: 0 }).success).toBe(false);
    expect(StoredReviewSchema.safeParse(STORED).success).toBe(true);
    expect(StoredReviewSchema.safeParse({ ...STORED, preset: 'ultra' }).success).toBe(false);
  });

  it('capabilities carry an optional reviewStore flag', () => {
    expect(CapabilitiesSchema.parse({ analysis: true, rooms: true })).toEqual({
      analysis: true,
      rooms: true,
    });
    expect(
      CapabilitiesSchema.parse({ analysis: false, rooms: true, reviewStore: true }).reviewStore,
    ).toBe(true);
  });
});

describe('review store messages', () => {
  it('round-trips the client messages', () => {
    const msgs = [
      { type: 'review.get', gameKey: KEY, startFen: START, moves: ['e4', 'e5'] },
      {
        type: 'review.put',
        gameKey: KEY,
        startFen: START,
        moves: ['e4', 'e5'],
        preset: 'deep',
        record: RECORD,
      },
      { type: 'review.positions.get', optsKey: 'mt:300', fens: [START, AFTER_E4] },
      {
        type: 'review.positions.put',
        optsKey: 'd:18',
        entries: [{ fen: START, result: { eval: { cp: 20 }, bestMove: 'e2e4', depth: 18 } }],
      },
      { type: 'review.stats.get' },
    ];
    for (const m of msgs) {
      const r = parseClientMessage(JSON.stringify(m));
      expect(r.ok, m.type).toBe(true);
      if (r.ok) expect(r.message).toEqual(m);
    }
    expect(ReviewGetMessageSchema.safeParse(msgs[0]).success).toBe(true);
    expect(ReviewPositionsGetMessageSchema.safeParse(msgs[2]).success).toBe(true);
    expect(ReviewPositionsPutMessageSchema.safeParse(msgs[3]).success).toBe(true);
    expect(ReviewStatsGetMessageSchema.safeParse(msgs[4]).success).toBe(true);
  });

  it('rejects out-of-bounds client messages', () => {
    const fens = new Array(65).fill(START);
    expect(
      parseClientMessage({ type: 'review.positions.get', optsKey: 'mt:300', fens }).ok,
    ).toBe(false);
    expect(parseClientMessage({ type: 'review.positions.get', optsKey: 'mt:300', fens: [] }).ok).toBe(
      false,
    );
    expect(
      parseClientMessage({ type: 'review.get', gameKey: KEY, startFen: 'nope', moves: ['e4', 'e5'] })
        .ok,
    ).toBe(false);
    expect(
      parseClientMessage({ type: 'review.get', gameKey: KEY, startFen: START, moves: ['e4'] }).ok,
    ).toBe(false);
    expect(
      parseClientMessage({
        type: 'review.put',
        gameKey: KEY,
        startFen: START,
        moves: ['e4', 'e5'],
        preset: 'fast',
        record: { ...RECORD, summary: { ...RECORD.summary, white: { accuracy: 101, counts } } },
      }).ok,
    ).toBe(false);
  });

  it('round-trips the server messages', () => {
    const msgs = [
      { type: 'review.record', gameKey: KEY, found: false },
      {
        type: 'review.record',
        gameKey: KEY,
        found: true,
        preset: 'fast',
        record: RECORD,
        createdAt: 1_761_000_000_000,
      },
      { type: 'review.stored', gameKey: KEY, stored: true },
      { type: 'review.stored', gameKey: KEY, stored: false, reason: 'unauthorized' },
      {
        type: 'review.positions',
        optsKey: 'mt:300',
        results: { [START]: { eval: { cp: 20 }, depth: 21 } },
      },
      { type: 'review.positions.stored', optsKey: 'mt:300', stored: false, reason: 'quota' },
      {
        type: 'review.stats',
        enabled: true,
        reviews: 3,
        positions: 100,
        bytes: 12_345,
        maxBytes: 5_000_000_000,
      },
    ];
    for (const m of msgs) {
      const r = parseServerMessage(JSON.stringify(m));
      expect(r.ok, JSON.stringify(m).slice(0, 60)).toBe(true);
      if (r.ok) expect(r.message).toEqual(m);
    }
    expect(ReviewRecordMessageSchema.safeParse(msgs[1]).success).toBe(true);
    expect(ReviewStoredMessageSchema.safeParse(msgs[3]).success).toBe(true);
    expect(ReviewPositionsMessageSchema.safeParse(msgs[4]).success).toBe(true);
    expect(ReviewPositionsStoredMessageSchema.safeParse(msgs[5]).success).toBe(true);
    expect(ReviewStatsMessageSchema.safeParse(msgs[6]).success).toBe(true);
    expect(
      parseServerMessage({ type: 'review.stored', gameKey: KEY, stored: false, reason: 'because' })
        .ok,
    ).toBe(false);
    expect(
      parseServerMessage({ type: 'review.positions', optsKey: 'mt:300', results: { junk: {} } }).ok,
    ).toBe(false);
  });

  it('lets only the record-carrying types exceed MAX_MESSAGE_BYTES', () => {
    const big = (type: string, extra: Record<string, unknown>) =>
      JSON.stringify({ type, ...extra, pad: 'x'.repeat(MAX_MESSAGE_BYTES) });
    // A large frame of an ordinary type is refused with the ordinary limit.
    expect(parseClientMessage(big('ping', {}))).toEqual({
      ok: false,
      error: `message exceeds ${MAX_MESSAGE_BYTES} bytes`,
    });
    expect(parseClientMessage(big('review.get', { gameKey: KEY, startFen: START, moves: ['e4', 'e5'] }))).toEqual({
      ok: false,
      error: `message exceeds ${MAX_MESSAGE_BYTES} bytes`,
    });
    // A large review.put is parsed (unknown `pad` is stripped).
    const put = big('review.put', {
      gameKey: KEY,
      startFen: START,
      moves: ['e4', 'e5'],
      preset: 'fast',
      record: RECORD,
    });
    expect(put.length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    const r = parseClientMessage(put);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message.type).toBe('review.put');
    // The large limit is absolute.
    expect(
      parseClientMessage(JSON.stringify({ type: 'review.put', pad: 'x'.repeat(MAX_LARGE_MESSAGE_BYTES) })),
    ).toEqual({ ok: false, error: `message exceeds ${MAX_LARGE_MESSAGE_BYTES} bytes` });
    // Server side: a large review.record passes, a large welcome does not.
    const rec = big('review.record', { gameKey: KEY, found: true, preset: 'fast', record: RECORD });
    expect(parseServerMessage(rec).ok).toBe(true);
    expect(parseServerMessage(big('pong', {})).ok).toBe(false);
  });
});
