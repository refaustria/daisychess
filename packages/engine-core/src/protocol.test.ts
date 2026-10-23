import { describe, expect, it } from 'vitest';
import {
  checkAnalyzeLimits,
  DEFAULT_LIMITS,
  isValidFen,
  MAX_MESSAGE_BYTES,
  parseClientMessage,
  parseServerMessage,
  PROTOCOL_BOUNDS,
  PROTOCOL_ERROR_CODES,
  MAX_TOKEN_LENGTH,
  PROTOCOL_VERSION,
  type AnalyzeMessage,
  type ClientMessage,
  type ServerMessage,
} from './index.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const analyze: AnalyzeMessage = {
  type: 'analyze',
  sessionId: 'tab-1_A',
  searchId: 7,
  engine: 'stockfish',
  fen: START,
  multipv: 3,
  depth: 24,
  movetime: 5000,
  threads: 4,
  hash: 256,
};

const clientMessages: ClientMessage[] = [
  {
    type: 'hello',
    protocolVersion: PROTOCOL_VERSION,
    client: { name: 'chesslab-web', version: '0.1.0' },
  },
  { type: 'hello', protocolVersion: PROTOCOL_VERSION },
  analyze,
  { type: 'analyze', sessionId: 's', searchId: 1, engine: 'stockfish', fen: START },
  { type: 'stop', sessionId: 'tab-1_A' },
  { type: 'release', sessionId: 'tab-1_A' },
  { type: 'ping', t: 1_700_000_000_000 },
  { type: 'ping' },
];

const serverMessages: ServerMessage[] = [
  {
    type: 'welcome',
    protocolVersion: PROTOCOL_VERSION,
    serverVersion: '0.1.0',
    limits: { ...DEFAULT_LIMITS },
    engines: [
      { id: 'stockfish', name: 'Stockfish 19', enabled: true, defaults: { threads: 4, hash: 256 } },
      {
        id: 'fairy-stockfish',
        name: 'Fairy-Stockfish',
        enabled: false,
        defaults: { threads: 2, hash: 128 },
      },
    ],
  },
  {
    type: 'info',
    sessionId: 'tab-1_A',
    searchId: 7,
    info: {
      depth: 18,
      seldepth: 25,
      multipv: 1,
      score: { cp: 35 },
      pv: ['e2e4', 'e7e5'],
      nps: 1_200_000,
      nodes: 4_000_000,
      time: 3333,
    },
  },
  {
    type: 'info',
    sessionId: 's',
    searchId: 1,
    info: { depth: 3, multipv: 2, score: { mate: -2 }, pv: ['e7e8q'] },
  },
  {
    type: 'bestmove',
    sessionId: 'tab-1_A',
    searchId: 7,
    bestMove: { move: 'e2e4', ponder: 'e7e5' },
    reason: 'completed',
  },
  { type: 'bestmove', sessionId: 'tab-1_A', searchId: 8, bestMove: null, reason: 'stopped' },
  {
    type: 'bestmove',
    sessionId: 'tab-1_A',
    searchId: 9,
    bestMove: { move: 'g1f3' },
    reason: 'limit',
  },
  { type: 'error', code: 'invalid_message', message: 'unknown message type "foo"' },
  { type: 'error', code: 'session_not_found', message: 'no such session', sessionId: 'x' },
  { type: 'error', code: 'engine_crashed', message: 'exit code 139', sessionId: 'x', searchId: 3 },
  { type: 'pong', t: 1_700_000_000_000 },
  { type: 'pong' },
];

describe('round trips', () => {
  it.each(clientMessages.map((m) => [m.type, m] as const))('client %s', (_type, msg) => {
    expect(parseClientMessage(JSON.stringify(msg))).toEqual({ ok: true, message: msg });
    expect(parseClientMessage(msg)).toEqual({ ok: true, message: msg });
  });
  it.each(serverMessages.map((m) => [m.type, m] as const))('server %s', (_type, msg) => {
    expect(parseServerMessage(JSON.stringify(msg))).toEqual({ ok: true, message: msg });
    expect(parseServerMessage(msg)).toEqual({ ok: true, message: msg });
  });
  it('covers every message type of both unions', () => {
    const clientTypes = new Set(clientMessages.map((m) => m.type));
    const serverTypes = new Set(serverMessages.map((m) => m.type));
    expect([...clientTypes].sort()).toEqual(['analyze', 'hello', 'ping', 'release', 'stop']);
    expect([...serverTypes].sort()).toEqual(['bestmove', 'error', 'info', 'pong', 'welcome']);
  });
  it('welcome carries the current protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    const welcome = serverMessages[0];
    expect(welcome?.type === 'welcome' && welcome.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe('envelope handling', () => {
  it('rejects malformed JSON with the parser message', () => {
    const r = parseClientMessage('{"type": ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^invalid JSON: /);
  });
  it('rejects non-object payloads', () => {
    for (const v of [null, 42, [], true, undefined]) {
      expect(parseClientMessage(v)).toEqual({ ok: false, error: 'message must be a JSON object' });
      expect(parseServerMessage(JSON.stringify(v ?? null))).toEqual({
        ok: false,
        error: 'message must be a JSON object',
      });
    }
    // A string is parsed as JSON text first; a JSON string literal is then a non-object.
    expect(parseClientMessage('"ping"')).toEqual({
      ok: false,
      error: 'message must be a JSON object',
    });
  });
  it('rejects unknown and missing types with the offending value', () => {
    expect(parseClientMessage({ type: 'analyse' })).toEqual({
      ok: false,
      error: 'unknown message type "analyse"',
    });
    expect(parseClientMessage({ sessionId: 'a' })).toEqual({
      ok: false,
      error: 'unknown message type undefined',
    });
    expect(parseClientMessage({ type: 7 })).toEqual({ ok: false, error: 'unknown message type 7' });
    // Server message types are not valid client messages and vice versa.
    expect(parseClientMessage({ type: 'welcome' })).toEqual({
      ok: false,
      error: 'unknown message type "welcome"',
    });
    expect(parseServerMessage({ type: 'analyze' })).toEqual({
      ok: false,
      error: 'unknown message type "analyze"',
    });
  });
  it('rejects oversized text frames before parsing', () => {
    const big = JSON.stringify({ type: 'ping', pad: 'x'.repeat(MAX_MESSAGE_BYTES) });
    expect(parseClientMessage(big)).toEqual({
      ok: false,
      error: `message exceeds ${MAX_MESSAGE_BYTES} bytes`,
    });
  });
  it('strips unknown fields', () => {
    expect(parseClientMessage({ type: 'stop', sessionId: 'a', bogus: 1 })).toEqual({
      ok: true,
      message: { type: 'stop', sessionId: 'a' },
    });
    expect(
      parseServerMessage({
        type: 'info',
        sessionId: 'a',
        searchId: 1,
        info: { depth: 1, multipv: 1, score: { cp: 0 }, pv: ['e2e4'], extra: true },
      }),
    ).toEqual({
      ok: true,
      message: {
        type: 'info',
        sessionId: 'a',
        searchId: 1,
        info: { depth: 1, multipv: 1, score: { cp: 0 }, pv: ['e2e4'] },
      },
    });
  });
  it('prefixes validation errors with the message type and field path', () => {
    const r = parseClientMessage({
      type: 'analyze',
      sessionId: 'a b',
      searchId: 1.5,
      engine: 'stockfish',
      fen: START,
    });
    expect(r).toEqual({
      ok: false,
      error:
        'analyze: sessionId: sessionId must be 1-64 characters of [A-Za-z0-9_-]; searchId: searchId must be an integer',
    });
  });
});

describe('client message constraints', () => {
  const bad = (patch: Record<string, unknown>) => parseClientMessage({ ...analyze, ...patch });
  const expectError = (r: ReturnType<typeof parseClientMessage>, re: RegExp) => {
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  };

  it('hello requires a positive integer protocol version', () => {
    expectError(parseClientMessage({ type: 'hello', protocolVersion: 0 }), /protocolVersion/);
    expectError(parseClientMessage({ type: 'hello', protocolVersion: '1' }), /protocolVersion/);
    expectError(parseClientMessage({ type: 'hello' }), /protocolVersion/);
    expectError(
      parseClientMessage({ type: 'hello', protocolVersion: 1, client: { name: '' } }),
      /client\.name/,
    );
    // A different (future) version still parses; the server answers with protocol_mismatch.
    expect(parseClientMessage({ type: 'hello', protocolVersion: PROTOCOL_VERSION + 1 }).ok).toBe(
      true,
    );
  });
  it('hello accepts an optional access token up to MAX_TOKEN_LENGTH characters', () => {
    const base = { type: 'hello', protocolVersion: PROTOCOL_VERSION };
    const without = parseClientMessage(base);
    expect(without.ok && without.message.type === 'hello' && without.message.token).toBe(undefined);
    const withToken = parseClientMessage({ ...base, token: 'secret' });
    expect(withToken.ok && withToken.message.type === 'hello' && withToken.message.token).toBe(
      'secret',
    );
    expect(parseClientMessage({ ...base, token: 'x'.repeat(MAX_TOKEN_LENGTH) }).ok).toBe(true);
    expectError(parseClientMessage({ ...base, token: 'x'.repeat(MAX_TOKEN_LENGTH + 1) }), /token/);
    expectError(parseClientMessage({ ...base, token: 42 }), /token/);
  });
  it('error codes include unauthorized (additive, protocol 1)', () => {
    expect(PROTOCOL_ERROR_CODES).toContain('unauthorized');
    expect(PROTOCOL_VERSION).toBe(1);
    expect(parseServerMessage({ type: 'error', code: 'unauthorized', message: 'x' }).ok).toBe(true);
  });
  it('analyze requires sessionId, searchId, engine and fen', () => {
    for (const key of ['sessionId', 'searchId', 'engine', 'fen']) {
      const msg: Record<string, unknown> = { ...analyze };
      delete msg[key];
      expectError(parseClientMessage(msg), new RegExp(`^analyze: ${key}:`));
    }
  });
  it('validates sessionId format', () => {
    expect(bad({ sessionId: 'x'.repeat(64) }).ok).toBe(true);
    expectError(bad({ sessionId: 'x'.repeat(65) }), /sessionId must be 1-64/);
    expectError(bad({ sessionId: '' }), /sessionId must be 1-64/);
    expectError(bad({ sessionId: 'a/b' }), /sessionId must be 1-64/);
  });
  it('validates searchId as a positive safe integer', () => {
    expectError(bad({ searchId: 0 }), /searchId must be >= 1/);
    expectError(bad({ searchId: -1 }), /searchId must be >= 1/);
    expectError(bad({ searchId: 2 ** 53 }), /searchId/);
    expectError(bad({ searchId: '1' }), /searchId/);
  });
  it('validates engine ids like the registry does', () => {
    expect(bad({ engine: 'Fairy-Stockfish_2' }).ok).toBe(true);
    expectError(bad({ engine: '-stockfish' }), /engine id must be/);
    expectError(bad({ engine: 'stock fish' }), /engine id must be/);
    expectError(bad({ engine: 'a'.repeat(65) }), /engine id must be/);
  });
  it('validates the fen syntactically', () => {
    expectError(bad({ fen: 'not a fen' }), /fen is not a syntactically valid FEN/);
    expectError(bad({ fen: `${START} ${'x'.repeat(100)}` }), /fen must be at most 100 characters/);
    expectError(bad({ fen: `${START}\nquit` }), /fen is not a syntactically valid FEN/);
  });
  it('enforces protocol bounds on numeric options', () => {
    const { depth, movetimeMs, multipv, threads, hashMb } = PROTOCOL_BOUNDS;
    expect(
      bad({
        depth: depth.max,
        movetime: movetimeMs.max,
        multipv: multipv.max,
        threads: threads.max,
        hash: hashMb.max,
      }).ok,
    ).toBe(true);
    expect(
      bad({
        depth: depth.min,
        movetime: movetimeMs.min,
        multipv: multipv.min,
        threads: threads.min,
        hash: hashMb.min,
      }).ok,
    ).toBe(true);
    expectError(bad({ depth: 0 }), /depth must be >= 1/);
    expectError(bad({ depth: depth.max + 1 }), new RegExp(`depth must be <= ${depth.max}`));
    expectError(bad({ depth: 2.5 }), /depth must be an integer/);
    expectError(bad({ movetime: 99 }), /movetime must be >= 100/);
    expectError(bad({ movetime: movetimeMs.max + 1 }), /movetime must be <= 600000/);
    expectError(bad({ multipv: 0 }), /multipv must be >= 1/);
    expectError(bad({ multipv: multipv.max + 1 }), /multipv must be <=/);
    expectError(bad({ threads: 0 }), /threads must be >= 1/);
    expectError(bad({ threads: threads.max + 1 }), /threads must be <=/);
    expectError(bad({ hash: 0 }), /hash must be >= 1/);
    expectError(bad({ hash: hashMb.max + 1 }), /hash must be <=/);
    expectError(bad({ depth: '24' }), /depth/);
  });
  it('stop and release require a valid sessionId', () => {
    expectError(parseClientMessage({ type: 'stop' }), /^stop: sessionId:/);
    expectError(parseClientMessage({ type: 'release', sessionId: '' }), /^release: sessionId:/);
  });
  it('ping accepts an optional numeric timestamp only', () => {
    expectError(parseClientMessage({ type: 'ping', t: 'now' }), /^ping: t:/);
  });
});

describe('server message constraints', () => {
  const info = (patch: Record<string, unknown>) =>
    parseServerMessage({
      type: 'info',
      sessionId: 'a',
      searchId: 1,
      info: { depth: 1, multipv: 1, score: { cp: 0 }, pv: ['e2e4'], ...patch },
    });
  const expectError = (r: ReturnType<typeof parseServerMessage>, re: RegExp) => {
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  };

  it('welcome validates limits, engines and version', () => {
    const welcome = serverMessages[0] as Extract<ServerMessage, { type: 'welcome' }>;
    expectError(
      parseServerMessage({ ...welcome, protocolVersion: 0 }),
      /^welcome: protocolVersion/,
    );
    expectError(
      parseServerMessage({ ...welcome, limits: { ...welcome.limits, maxDepth: 100 } }),
      /limits\.maxDepth: maxDepth must be <= 99/,
    );
    expectError(
      parseServerMessage({
        ...welcome,
        limits: { ...welcome.limits, maxSessionsPerConnection: 0 },
      }),
      /maxSessionsPerConnection must be >= 1/,
    );
    expectError(
      parseServerMessage({
        ...welcome,
        engines: [{ id: 'sf', name: 'SF', enabled: true, defaults: { threads: 0, hash: 1 } }],
      }),
      /engines\.0\.defaults\.threads: defaults\.threads must be >= 1/,
    );
    expectError(
      parseServerMessage({
        ...welcome,
        engines: [{ id: 'sf', name: '', enabled: true, defaults: { threads: 1, hash: 1 } }],
      }),
      /engines\.0\.name/,
    );
    expectError(
      parseServerMessage({
        ...welcome,
        engines: [{ id: 'sf', name: 'SF', defaults: { threads: 1, hash: 1 } }],
      }),
      /engines\.0\.enabled/,
    );
    expect(parseServerMessage({ ...welcome, engines: [] }).ok).toBe(true);
  });
  it('info mirrors EngineInfo and rejects ambiguous or malformed scores', () => {
    expectError(
      info({ score: { cp: 1, mate: 2 } }),
      /info\.score: score must be either \{ cp \} or \{ mate \}/,
    );
    expectError(info({ score: {} }), /info\.score/);
    expectError(info({ score: { cp: 1.5 } }), /info\.score/);
    expectError(info({ score: { cp: 100_001 } }), /info\.score/);
    expect(info({ score: { mate: 0 } }).ok).toBe(true);
  });
  it('info requires a non-empty pv of UCI moves within bounds', () => {
    expectError(info({ pv: [] }), /pv must contain at least one move/);
    expectError(info({ pv: ['e2-e4'] }), /info\.pv\.0: move must be in UCI notation/);
    expectError(info({ pv: ['Nf3'] }), /info\.pv\.0/);
    expectError(
      info({ pv: Array.from({ length: PROTOCOL_BOUNDS.pvMaxLength + 1 }, () => 'e2e4') }),
      /info\.pv/,
    );
    expect(info({ pv: ['e1g1', 'e7e8q', 'a7a8n'] }).ok).toBe(true);
  });
  it('info rejects negative or fractional counters', () => {
    expectError(info({ depth: -1 }), /depth must be >= 0/);
    expectError(info({ multipv: 0 }), /multipv must be >= 1/);
    expectError(info({ nps: -5 }), /nps must be >= 0/);
    expectError(info({ nodes: 1.5 }), /nodes must be an integer/);
    expectError(info({ time: '12' }), /info\.time/);
  });
  it('bestmove validates moves and reason', () => {
    const base = {
      type: 'bestmove',
      sessionId: 'a',
      searchId: 1,
      bestMove: { move: 'e2e4' },
      reason: 'completed',
    };
    expectError(
      parseServerMessage({ ...base, bestMove: { move: 'xx' } }),
      /bestMove\.move: move must be in UCI notation/,
    );
    expectError(
      parseServerMessage({ ...base, bestMove: { move: 'e2e4', ponder: 'e7' } }),
      /bestMove\.ponder/,
    );
    expectError(parseServerMessage({ ...base, reason: 'done' }), /reason/);
    expectError(parseServerMessage({ ...base, bestMove: undefined }), /bestMove/);
    expectError(parseServerMessage({ ...base, searchId: undefined }), /searchId/);
  });
  it('error requires a known code and sessionId when searchId is present', () => {
    expectError(
      parseServerMessage({ type: 'error', code: 'oops', message: 'x' }),
      /code: Invalid option/,
    );
    expectError(
      parseServerMessage({ type: 'error', code: 'internal_error', message: 'x', searchId: 1 }),
      /searchId requires sessionId/,
    );
    expectError(
      parseServerMessage({ type: 'error', code: 'internal_error', message: 'x'.repeat(1001) }),
      /message/,
    );
    for (const code of PROTOCOL_ERROR_CODES) {
      expect(parseServerMessage({ type: 'error', code, message: code }).ok).toBe(true);
    }
  });
});

describe('isValidFen', () => {
  it('accepts standard, 4-field, Chess960 and en-passant FENs', () => {
    expect(isValidFen(START)).toBe(true);
    expect(isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -')).toBe(true);
    expect(isValidFen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')).toBe(true);
    expect(isValidFen('bqnbrkrn/pppppppp/8/8/8/8/PPPPPPPP/BQNBRKRN w HEhe - 0 1')).toBe(true);
    expect(isValidFen('8/8/8/8/8/4k3/8/4K3 w - - 0 1')).toBe(true);
    expect(isValidFen('4k3/8/8/8/8/8/8/4K3 b Kq - 99 200')).toBe(true);
  });
  it('rejects wrong rank counts, rank widths and missing or duplicate kings', () => {
    expect(isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1')).toBe(false); // 7 ranks
    expect(isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNRR w KQkq - 0 1')).toBe(false); // 9 squares
    expect(isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR1 w KQkq - 0 1')).toBe(false); // 9 squares via digit
    expect(isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN1 w KQkq - 0 1')).toBe(true); // 7 pieces + 1 empty = 8
    expect(isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBN w KQkq - 0 1')).toBe(false); // 7 squares
    expect(isValidFen('8/8/8/8/8/8/8/8 w - - 0 1')).toBe(false); // no kings
    expect(isValidFen('4k3/8/8/8/8/8/8/4K2K w - - 0 1')).toBe(false); // two white kings
    expect(isValidFen('rnbqxbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')).toBe(false); // bad piece
  });
  it('rejects malformed trailing fields', () => {
    expect(isValidFen('4k3/8/8/8/8/8/8/4K3 x - - 0 1')).toBe(false); // side
    expect(isValidFen('4k3/8/8/8/8/8/8/4K3 w  - 0 1')).toBe(false); // empty castling
    expect(isValidFen('4k3/8/8/8/8/8/8/4K3 w KQkq e4 0 1')).toBe(false); // ep rank
    expect(isValidFen('4k3/8/8/8/8/8/8/4K3 w - - 0')).toBe(false); // half without full move
    expect(isValidFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1 extra')).toBe(false);
    expect(isValidFen(' 4k3/8/8/8/8/8/8/4K3 w - - 0 1')).toBe(false); // leading space
    expect(isValidFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1\nquit')).toBe(false);
    expect(isValidFen('')).toBe(false);
    expect(isValidFen('4k3/8/8/8/8/8/8/4K3 w - - 0 1'.padEnd(101, ' '))).toBe(false);
  });
  // Every FEN below was fed to the real Stockfish 19 binary (docs/SECURITY.md): the rejected ones
  // make it exit(1) ("Unsupported position" / "Invalid FEN"), the accepted ones return a bestmove.
  it('rejects positions that make Stockfish terminate: pawn ranks and material', () => {
    expect(isValidFen('PPPPPPPP/pppppppp/8/8/8/8/8/Kk6 w - - 0 1')).toBe(false); // pawns on the 8th rank
    expect(isValidFen('k7/8/8/8/8/8/8/K6P w - - 0 1')).toBe(false); // pawn on the 1st rank
    expect(isValidFen('k7/pppppppp/7p/8/8/8/8/K7 w - - 0 1')).toBe(false); // 9 black pawns
    expect(isValidFen('k7/pppppppp/8/8/8/8/8/K7 w - - 0 1')).toBe(true); // 8 pawns
    expect(isValidFen('k7/8/8/8/8/1QQQQ3/1QQQQQ1Q/K7 w - - 0 1')).toBe(false); // 10 queens = 9 promotions > 8 missing pawns
    expect(isValidFen('k7/8/8/8/8/1QQQ4/1QQQQQ1Q/K7 w - - 0 1')).toBe(true); // 9 queens = 8 promotions
    expect(isValidFen('k7/8/8/8/8/8/8/KRRRRRRR w - - 0 1')).toBe(true); // 7 rooks = 5 promotions
    expect(isValidFen('nnnnknnn/8/8/8/8/8/8/NNNNKNNN w - - 0 1')).toBe(true); // 7 knights = 5 promotions
    expect(
      isValidFen(
        'qqqqqqqk/qqqqqqqq/qqqqqqqq/qqqqqqqq/QQQQQQQQ/QQQQQQQQ/QQQQQQQQ/QQQQQQQK w - - 0 1',
      ),
    ).toBe(false); // > 32 pieces
  });
  it('rejects en-passant squares on the wrong rank for the side to move', () => {
    expect(isValidFen('k7/8/8/8/8/8/8/K7 w - e3 0 1')).toBe(false);
    expect(isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq h3 0 1')).toBe(false);
    expect(isValidFen('k7/8/8/8/8/8/8/K7 b - e6 0 1')).toBe(false);
    // Right rank but no capturable pawn: Stockfish drops the square silently, so it is accepted.
    expect(isValidFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq a6 0 1')).toBe(true);
    expect(isValidFen('rnbqkbnr/ppp1pppp/8/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3')).toBe(true);
  });
  it('rejects positions where the side not to move is in check', () => {
    expect(isValidFen('kK6/8/8/8/8/8/8/8 w - - 0 1')).toBe(false); // adjacent kings
    expect(isValidFen('8/8/8/8/8/8/8/Kk6 w - - 0 1')).toBe(false);
    expect(isValidFen('k6R/8/8/8/8/8/8/K7 w - - 0 1')).toBe(false); // rook gives check, White to move
    expect(isValidFen('k7/8/8/8/8/8/8/K6r b - - 0 1')).toBe(false); // mirror
    expect(isValidFen('k7/8/8/8/8/8/8/K6q w - - 0 1')).toBe(true); // White to move, White in check: legal
    expect(isValidFen('k7/8/8/8/8/8/7q/K7 w - - 0 1')).toBe(true); // queen on h2 does not attack a8
    expect(isValidFen('k7/1P6/8/8/8/8/8/K7 w - - 0 1')).toBe(false); // white pawn attacks a8
    expect(isValidFen('k7/8/1N6/8/8/8/8/K7 w - - 0 1')).toBe(false); // knight check
    expect(isValidFen('k7/8/2B5/8/8/8/8/K7 w - - 0 1')).toBe(false); // bishop check
    expect(isValidFen('k7/1p6/2B5/8/8/8/8/K7 w - - 0 1')).toBe(true); // blocked bishop
    expect(isValidFen('k7/8/8/8/8/8/8/K6R w - - 0 1')).toBe(true);
    expect(isValidFen('K7/8/8/8/8/8/8/k7 w - - 0 1')).toBe(true);
    expect(isValidFen('k7/8/8/8/8/8/8/K7 w KQkq - 0 1')).toBe(true); // bogus castling rights are sanitised, not fatal
    expect(isValidFen('k7/8/8/8/8/8/8/K7 w - - 9999 9999')).toBe(true);
  });
});

describe('checkAnalyzeLimits', () => {
  const base: AnalyzeMessage = {
    type: 'analyze',
    sessionId: 's',
    searchId: 1,
    engine: 'stockfish',
    fen: START,
  };
  it('accepts messages within limits and messages without optional fields', () => {
    expect(checkAnalyzeLimits(base, DEFAULT_LIMITS)).toBeNull();
    expect(
      checkAnalyzeLimits(
        { ...base, depth: 30, movetime: 600_000, multipv: 5, threads: 4, hash: 512 },
        DEFAULT_LIMITS,
      ),
    ).toBeNull();
  });
  it('reports the first exceeded limit with value and limit', () => {
    expect(checkAnalyzeLimits({ ...base, depth: 31 }, DEFAULT_LIMITS)).toBe(
      'depth 31 exceeds the server limit of 30',
    );
    expect(checkAnalyzeLimits({ ...base, movetime: 600_001 }, DEFAULT_LIMITS)).toBe(
      'movetime 600001 exceeds the server limit of 600000',
    );
    expect(checkAnalyzeLimits({ ...base, multipv: 6 }, DEFAULT_LIMITS)).toBe(
      'multipv 6 exceeds the server limit of 5',
    );
    expect(checkAnalyzeLimits({ ...base, threads: 5 }, DEFAULT_LIMITS)).toBe(
      'threads 5 exceeds the server limit of 4',
    );
    expect(checkAnalyzeLimits({ ...base, hash: 513 }, DEFAULT_LIMITS)).toBe(
      'hash 513 exceeds the server limit of 512',
    );
    expect(checkAnalyzeLimits({ ...base, depth: 31, hash: 513 }, DEFAULT_LIMITS)).toBe(
      'depth 31 exceeds the server limit of 30',
    );
  });
  it('uses the given limits, not the defaults', () => {
    expect(
      checkAnalyzeLimits({ ...base, depth: 31 }, { ...DEFAULT_LIMITS, maxDepth: 40 }),
    ).toBeNull();
    expect(checkAnalyzeLimits({ ...base, threads: 2 }, { ...DEFAULT_LIMITS, maxThreads: 1 })).toBe(
      'threads 2 exceeds the server limit of 1',
    );
  });
  it('DEFAULT_LIMITS is frozen and within protocol bounds', () => {
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
    expect(DEFAULT_LIMITS.maxDepth).toBeLessThanOrEqual(PROTOCOL_BOUNDS.depth.max);
    expect(DEFAULT_LIMITS.maxMultipv).toBeLessThanOrEqual(PROTOCOL_BOUNDS.multipv.max);
    expect(DEFAULT_LIMITS.maxThreads).toBeLessThanOrEqual(PROTOCOL_BOUNDS.threads.max);
    expect(DEFAULT_LIMITS.maxHash).toBeLessThanOrEqual(PROTOCOL_BOUNDS.hashMb.max);
    expect(DEFAULT_LIMITS.maxMovetimeMs).toBeLessThanOrEqual(PROTOCOL_BOUNDS.movetimeMs.max);
    expect(DEFAULT_LIMITS.maxSessionsPerConnection).toBeLessThanOrEqual(
      PROTOCOL_BOUNDS.sessionsPerConnection.max,
    );
  });
});
