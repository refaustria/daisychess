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
  ROOM_BOUNDS,
  ROOM_ERROR_CODES,
  ROOM_STATUSES,
  ROOM_RESULTS,
  ROOM_END_REASONS,
  normalizeNick,
  NickSchema,
  RoomIdSchema,
  PlayerTokenSchema,
  RoomSideSchema,
  RoomColorChoiceSchema,
  RoomClockSettingSchema,
  RoomClockStateSchema,
  RoomPlayerSchema,
  RoomCreateMessageSchema,
  RoomJoinMessageSchema,
  RoomAttachMessageSchema,
  RoomMoveMessageSchema,
  RoomResignMessageSchema,
  RoomDrawMessageSchema,
  RoomAbortMessageSchema,
  RoomClaimMessageSchema,
  RoomLeaveMessageSchema,
  RoomSeatMessageSchema,
  RoomStateMessageSchema,
  RoomErrorMessageSchema,
  CapabilitiesSchema,
  UciMoveSchema,
  type AnalyzeMessage,
  type ClientMessage,
  type RoomStateMessage,
  type ServerMessage,
} from './index.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ROOM_ID = 'Ab3_dEfGh-jKlMnOpQrStU';
const TOKEN = 'x'.repeat(43);

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
  {
    type: 'room.create',
    nick: 'Alice',
    clock: { initialMs: 180_000, incrementMs: 2_000 },
    color: 'random',
  },
  { type: 'room.create', nick: 'Bob', clock: null, color: 'white' },
  { type: 'room.join', roomId: ROOM_ID, nick: 'Carol' },
  { type: 'room.join', roomId: ROOM_ID },
  { type: 'room.attach', roomId: ROOM_ID, playerToken: TOKEN },
  { type: 'room.move', roomId: ROOM_ID, uci: 'e7e8q' },
  { type: 'room.resign', roomId: ROOM_ID },
  { type: 'room.draw', roomId: ROOM_ID, action: 'offer' },
  { type: 'room.abort', roomId: ROOM_ID },
  { type: 'room.claim', roomId: ROOM_ID },
  { type: 'room.leave', roomId: ROOM_ID },
];

const roomState: RoomStateMessage = {
  type: 'room.state',
  roomId: ROOM_ID,
  status: 'playing',
  players: { white: { nick: 'Alice', connected: true }, black: { nick: 'Bob', connected: false } },
  you: 'white',
  spectators: 1,
  startFen: START,
  fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
  moves: ['e2e4'],
  clock: { initialMs: 180_000, incrementMs: 2_000, white: 180_000, black: 180_000, running: null },
  claimableAt: 1_700_000_060_000,
  serverTime: 1_700_000_000_000,
};

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
  {
    type: 'welcome',
    protocolVersion: PROTOCOL_VERSION,
    serverVersion: '0.1.0',
    limits: { ...DEFAULT_LIMITS },
    engines: [],
    capabilities: { analysis: false, rooms: true },
  },
  {
    type: 'error',
    code: 'forbidden',
    message: 'no analysis while playing',
    sessionId: 'x',
    searchId: 1,
  },
  { type: 'room.seat', roomId: ROOM_ID, playerToken: TOKEN, color: 'black' },
  roomState,
  {
    type: 'room.state',
    roomId: ROOM_ID,
    status: 'finished',
    players: { white: { nick: 'Alice', connected: true } },
    you: 'spectator',
    spectators: 0,
    startFen: START,
    fen: START,
    moves: [],
    clock: null,
    reason: 'abort',
    serverTime: 1_700_000_000_000,
  },
  {
    ...roomState,
    status: 'finished',
    result: '1/2-1/2',
    reason: 'agreement',
    drawOffer: 'black',
    clock: { ...roomState.clock!, running: 'white' },
  },
  { type: 'room.error', roomId: ROOM_ID, code: 'not_your_turn', message: 'wait' },
  { type: 'room.error', code: 'too_many_rooms', message: 'server full' },
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
    expect([...clientTypes].sort()).toEqual([
      'analyze',
      'hello',
      'ping',
      'release',
      'room.abort',
      'room.attach',
      'room.claim',
      'room.create',
      'room.draw',
      'room.join',
      'room.leave',
      'room.move',
      'room.resign',
      'stop',
    ]);
    expect([...serverTypes].sort()).toEqual([
      'bestmove',
      'error',
      'info',
      'pong',
      'room.error',
      'room.seat',
      'room.state',
      'welcome',
    ]);
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

describe('rooms (ADR-013)', () => {
  const okC = (m: unknown) => expect(parseClientMessage(m).ok, JSON.stringify(m)).toBe(true);
  const badC = (m: unknown, re: RegExp) => {
    const r = parseClientMessage(m);
    expect(r.ok, JSON.stringify(m)).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  };
  const okS = (m: unknown) => expect(parseServerMessage(m).ok, JSON.stringify(m)).toBe(true);
  const badS = (m: unknown, re: RegExp) => {
    const r = parseServerMessage(m);
    expect(r.ok, JSON.stringify(m)).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  };

  it('stays additive: protocol 1, forbidden error code, capabilities optional', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_ERROR_CODES).toContain('forbidden');
    const welcome = serverMessages[0] as Extract<ServerMessage, { type: 'welcome' }>;
    expect(welcome.capabilities).toBeUndefined();
    expect(CapabilitiesSchema.safeParse({ analysis: true, rooms: false }).success).toBe(true);
    expect(CapabilitiesSchema.safeParse({ analysis: true }).success).toBe(false);
    badS({ ...welcome, capabilities: { analysis: 'yes', rooms: true } }, /capabilities\.analysis/);
  });

  it('constants are consistent and frozen-shaped', () => {
    expect(ROOM_STATUSES).toEqual(['waiting', 'playing', 'finished']);
    expect(ROOM_RESULTS).toEqual(['1-0', '0-1', '1/2-1/2']);
    expect([...ROOM_END_REASONS].sort()).toEqual(
      [
        'abandoned',
        'abort',
        'agreement',
        'checkmate',
        'draw',
        'resign',
        'stalemate',
        'timeout',
      ].sort(),
    );
    expect(ROOM_ERROR_CODES).toHaveLength(8);
    expect(ROOM_BOUNDS.maxPlies).toBe(1_000);
    expect(ROOM_BOUNDS.nick).toEqual({ min: 1, max: 20 });
    // A 1000-ply snapshot stays within one frame.
    const big = { ...roomState, moves: Array.from({ length: 1_000 }, () => 'e7e8q') };
    expect(JSON.stringify(big).length).toBeLessThan(MAX_MESSAGE_BYTES);
    okS(big);
    badS({ ...roomState, moves: [...big.moves, 'e2e4'] }, /moves/);
  });

  it('normalizeNick strips controls and bidi marks, collapses whitespace, trims', () => {
    expect(normalizeNick('  Alice  ')).toBe('Alice');
    expect(normalizeNick('Al\u0000ice​‮')).toBe('Alice');
    expect(normalizeNick('A\t\n  B')).toBe('A B');
    expect(normalizeNick('\u0007')).toBe('');
    expect(normalizeNick('Zoë 😀')).toBe('Zoë 😀');
  });

  it('NickSchema normalises, then requires 1–20 characters', () => {
    expect(NickSchema.parse('  Bob ')).toBe('Bob');
    expect(NickSchema.safeParse('').success).toBe(false);
    expect(NickSchema.safeParse('   ').success).toBe(false);
    expect(NickSchema.safeParse('\u0001\u0002').success).toBe(false);
    expect(NickSchema.safeParse('x'.repeat(20)).success).toBe(true);
    expect(NickSchema.safeParse('x'.repeat(21)).success).toBe(false);
    expect(NickSchema.safeParse('x'.repeat(ROOM_BOUNDS.nickRawMaxLength + 1)).success).toBe(false);
    // the normalised nick is what the message carries
    const r = parseClientMessage({
      type: 'room.create',
      nick: ' A\u0000lice ',
      clock: null,
      color: 'white',
    });
    expect(r.ok && r.message.type === 'room.create' && r.message.nick).toBe('Alice');
    badC(
      { type: 'room.create', nick: ' \u0000 ', clock: null, color: 'white' },
      /nick must not be empty/,
    );
    badC({ type: 'room.join', roomId: ROOM_ID, nick: 'x'.repeat(21) }, /nick must be at most 20/);
  });

  it('room ids and player tokens are URL-safe strings of bounded length', () => {
    expect(RoomIdSchema.safeParse(ROOM_ID).success).toBe(true);
    expect(RoomIdSchema.safeParse('x'.repeat(16)).success).toBe(true);
    expect(RoomIdSchema.safeParse('x'.repeat(15)).success).toBe(false);
    expect(RoomIdSchema.safeParse('x'.repeat(65)).success).toBe(false);
    expect(RoomIdSchema.safeParse('abc/def+ghi=jkl=mno=').success).toBe(false);
    expect(PlayerTokenSchema.safeParse(TOKEN).success).toBe(true);
    expect(PlayerTokenSchema.safeParse('x'.repeat(22)).success).toBe(true);
    expect(PlayerTokenSchema.safeParse('x'.repeat(21)).success).toBe(false);
    expect(PlayerTokenSchema.safeParse('x'.repeat(129)).success).toBe(false);
    badC({ type: 'room.attach', roomId: 'short', playerToken: TOKEN }, /roomId/);
    badC({ type: 'room.attach', roomId: ROOM_ID, playerToken: 'short' }, /playerToken/);
  });

  it('sides, colour choices, UCI moves', () => {
    expect(RoomSideSchema.options).toEqual(['white', 'black']);
    expect(RoomColorChoiceSchema.options).toEqual(['white', 'black', 'random']);
    expect(UciMoveSchema.safeParse('e2e4').success).toBe(true);
    expect(UciMoveSchema.safeParse('e7e8q').success).toBe(true);
    expect(UciMoveSchema.safeParse('e7e8k').success).toBe(false);
    expect(UciMoveSchema.safeParse('Nf3').success).toBe(false);
    badC({ type: 'room.create', nick: 'a', clock: null, color: 'both' }, /color/);
    badC({ type: 'room.move', roomId: ROOM_ID, uci: 'e2-e4' }, /uci/);
  });

  it('clock settings mirror the custom time control bounds (0.25–180 min, 0–60 s)', () => {
    expect(RoomClockSettingSchema.safeParse({ initialMs: 15_000, incrementMs: 0 }).success).toBe(
      true,
    );
    expect(
      RoomClockSettingSchema.safeParse({ initialMs: 10_800_000, incrementMs: 60_000 }).success,
    ).toBe(true);
    expect(RoomClockSettingSchema.safeParse({ initialMs: 14_999, incrementMs: 0 }).success).toBe(
      false,
    );
    expect(
      RoomClockSettingSchema.safeParse({ initialMs: 60_000, incrementMs: 60_001 }).success,
    ).toBe(false);
    expect(RoomClockSettingSchema.safeParse({ initialMs: 60_000.5, incrementMs: 0 }).success).toBe(
      false,
    );
    badC(
      { type: 'room.create', nick: 'a', clock: { initialMs: 1, incrementMs: 0 }, color: 'white' },
      /clock\.initialMs/,
    );
    badC({ type: 'room.create', nick: 'a', color: 'white' }, /clock/); // null must be explicit
    okC({ type: 'room.create', nick: 'a', clock: null, color: 'white' });
  });

  it('clock state: non-negative remaining times, running side or null', () => {
    const c = { initialMs: 60_000, incrementMs: 0, white: 1, black: 0, running: 'black' };
    expect(RoomClockStateSchema.safeParse(c).success).toBe(true);
    expect(RoomClockStateSchema.safeParse({ ...c, white: -1 }).success).toBe(false);
    expect(RoomClockStateSchema.safeParse({ ...c, running: 'both' }).success).toBe(false);
    expect(RoomClockStateSchema.safeParse({ ...c, running: undefined }).success).toBe(false);
  });

  it('players and room.state fields', () => {
    expect(RoomPlayerSchema.safeParse({ nick: 'A', connected: true }).success).toBe(true);
    expect(RoomPlayerSchema.safeParse({ nick: '', connected: true }).success).toBe(false);
    expect(RoomPlayerSchema.safeParse({ nick: 'A' }).success).toBe(false);
    badS({ ...roomState, status: 'open' }, /status/);
    badS({ ...roomState, you: 'host' }, /you/);
    badS({ ...roomState, spectators: -1 }, /spectators/);
    badS({ ...roomState, fen: 'nope' }, /fen/);
    badS({ ...roomState, result: '*' }, /result/);
    badS({ ...roomState, reason: 'flag' }, /reason/);
    badS({ ...roomState, drawOffer: 'spectator' }, /drawOffer/);
    badS({ ...roomState, serverTime: undefined }, /serverTime/);
    okS({ ...roomState, players: {} });
    expect(RoomStateMessageSchema.safeParse(roomState).success).toBe(true);
    expect(
      RoomSeatMessageSchema.safeParse({
        type: 'room.seat',
        roomId: ROOM_ID,
        playerToken: TOKEN,
        color: 'white',
      }).success,
    ).toBe(true);
    badS({ type: 'room.seat', roomId: ROOM_ID, playerToken: TOKEN, color: 'random' }, /color/);
    expect(
      RoomErrorMessageSchema.safeParse({ type: 'room.error', code: 'bad_state', message: 'x' })
        .success,
    ).toBe(true);
    badS({ type: 'room.error', code: 'unauthorized', message: 'x' }, /code/);
    badS({ type: 'room.error', code: 'bad_state', message: 'x'.repeat(1_001) }, /message/);
  });

  it('every room request needs its roomId (create excepted) and valid enums', () => {
    for (const schema of [
      RoomJoinMessageSchema,
      RoomAttachMessageSchema,
      RoomMoveMessageSchema,
      RoomResignMessageSchema,
      RoomDrawMessageSchema,
      RoomAbortMessageSchema,
      RoomClaimMessageSchema,
      RoomLeaveMessageSchema,
    ]) {
      const type = schema.shape.type.value;
      const r = parseClientMessage({
        type,
        nick: 'a',
        playerToken: TOKEN,
        uci: 'e2e4',
        action: 'offer',
      });
      expect(r.ok, type).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/roomId/);
    }
    expect(RoomCreateMessageSchema.shape.type.value).toBe('room.create');
    badC({ type: 'room.draw', roomId: ROOM_ID, action: 'maybe' }, /action/);
    okC({ type: 'room.draw', roomId: ROOM_ID, action: 'accept' });
    okC({ type: 'room.draw', roomId: ROOM_ID, action: 'decline' });
    okC({ type: 'room.join', roomId: ROOM_ID });
  });
});
