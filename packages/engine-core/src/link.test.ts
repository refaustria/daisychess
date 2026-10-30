import { describe, expect, it } from 'vitest';
import {
  CidSchema,
  ClientCloseMessageSchema,
  ClientClosedMessageSchema,
  ClientMsgFromNodeSchema,
  ClientMsgToNodeSchema,
  ClientOpenMessageSchema,
  DEFAULT_LIMITS,
  HubRelayMessageSchema,
  HubToNodeMessageSchema,
  LINK_BOUNDS,
  LINK_CLOSE_REASONS,
  LINK_DEFAULTS,
  LINK_FATAL_ENDS,
  LINK_PROTOCOL_VERSION,
  LinkCloseMessageSchema,
  MAX_LINK_MESSAGE_BYTES,
  MAX_MESSAGE_BYTES,
  MAX_TOKEN_LENGTH,
  NODE_DRAIN_REASONS,
  NODE_ERROR_CODES,
  NodeDrainMessageSchema,
  NodeEngineStatusSchema,
  NodeErrorMessageSchema,
  NodeHelloMessageSchema,
  NodeNameSchema,
  NodeRelayMessageSchema,
  NodeStatusMessageSchema,
  NodeToHubMessageSchema,
  NodeWelcomeMessageSchema,
  PROTOCOL_BOUNDS,
  VersionSchema,
  checkLinkCompatibility,
  compareVersions,
  formatToken,
  isFatalLinkEnd,
  nodeVersionStatus,
  parseClientMessage,
  parseHubToNodeMessage,
  parseNodeToHubMessage,
  parseServerMessage,
  serializeLinkMessage,
  utf8ByteLength,
  type ClientMsgFromNode,
  type ClientMsgToNode,
  type ClientOpenMessage,
  type HubToNodeMessage,
  type InfoMessage,
  type LinkMessage,
  type NodeHelloMessage,
  type NodeStatusMessage,
  type NodeToHubMessage,
  type NodeWelcomeMessage,
} from './index.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const NODE_TOKEN = formatToken('node', 'abcdefgh', 'abcdefghijklmnopqrstuvwxyz234567');

const HELLO: NodeHelloMessage = {
  type: 'node.hello',
  linkVersion: LINK_PROTOCOL_VERSION,
  nodeToken: NODE_TOKEN,
  node: { version: '0.3.1', platform: 'linux', arch: 'arm64' },
  engines: [
    { id: 'stockfish', name: 'Stockfish 19', enabled: true, defaults: { threads: 4, hash: 256 } },
    {
      id: 'maia-1500',
      name: 'Maia 1500',
      enabled: true,
      defaults: { threads: 1, hash: 16 },
      style: 'human',
      rating: 1500,
      maxNodes: 1,
    },
  ],
  limits: { ...DEFAULT_LIMITS },
  maxSessions: 4,
  pool: true,
};

const STATUS: NodeStatusMessage = {
  type: 'node.status',
  sessions: 1,
  maxSessions: 4,
  load1: 0.42,
  engines: [
    { id: 'stockfish', busy: 1, idle: 1, degraded: false },
    { id: 'maia-1500', busy: 0, idle: 0, degraded: true },
  ],
};

const WELCOME: NodeWelcomeMessage = {
  type: 'node.welcome',
  linkVersion: LINK_PROTOCOL_VERSION,
  hubVersion: '0.4.0',
  nodeId: 'abcdefgh',
  name: 'fast-box',
  pool: true,
  heartbeatMs: LINK_DEFAULTS.heartbeatMs,
  drainMs: LINK_DEFAULTS.drainMs,
  minNodeVersion: '0.3.0',
  latestNodeVersion: '0.3.1',
};

const OPEN: ClientOpenMessage = {
  type: 'client.open',
  cid: 'c1',
  limits: { ...DEFAULT_LIMITS, maxThreads: 2, maxSessionsPerConnection: 1 },
  shared: false,
  tier: 'small',
  tokenId: 'zzzzzzzz',
  label: "Anna's iPad",
};

const ANALYZE: ClientMsgToNode = {
  type: 'client.msg',
  cid: 'c1',
  msg: {
    type: 'analyze',
    sessionId: 'tab-1',
    searchId: 7,
    engine: 'stockfish',
    fen: START,
    depth: 20,
  },
};

const INFO_MSG: InfoMessage = {
  type: 'info',
  sessionId: 'tab-1',
  searchId: 7,
  info: { depth: 12, multipv: 1, score: { cp: 35 }, pv: ['e2e4', 'e7e5'] },
};
const INFO: ClientMsgFromNode = { type: 'client.msg', cid: 'c1', msg: INFO_MSG };

/** Serialises, parses with the given parser and expects the exact message back. */
function roundTrip<T extends LinkMessage>(
  msg: T,
  parse: (input: unknown) => { ok: true; message: unknown } | { ok: false; error: string },
): T {
  const text = serializeLinkMessage(msg);
  expect(text.ok).toBe(true);
  if (!text.ok) throw new Error(text.error);
  const r = parse(text.text);
  expect(r.ok, r.ok ? '' : r.error).toBe(true);
  if (!r.ok) throw new Error(r.error);
  expect(r.message).toEqual(msg);
  return r.message as T;
}

describe('link constants', () => {
  it('are the ADR-020 §3 values', () => {
    expect(LINK_PROTOCOL_VERSION).toBe(1);
    expect(MAX_LINK_MESSAGE_BYTES).toBe(20 * 1024);
    // A maximal player frame plus the envelope fits.
    expect(MAX_LINK_MESSAGE_BYTES - MAX_MESSAGE_BYTES).toBeGreaterThan(256);
    expect(LINK_DEFAULTS.heartbeatMs).toBe(10_000);
    expect(LINK_DEFAULTS.helloTimeoutMs).toBe(10_000);
    expect(LINK_DEFAULTS.drainMs).toBe(30_000);
    expect(LINK_DEFAULTS.maxMessagesPerSecond).toBe(5_000);
    expect(LINK_DEFAULTS.unknownCidPerMinute).toBe(100);
    expect(LINK_DEFAULTS.infoPerSecondPerSearch).toBe(60);
    expect(LINK_DEFAULTS.maxBufferedBytes).toBe(1024 * 1024);
    expect(LINK_DEFAULTS.reconnectMinMs).toBe(1_000);
    expect(LINK_DEFAULTS.reconnectMaxMs).toBe(60_000);
    expect(LINK_DEFAULTS.missedPongsToDrop).toBe(2);
    expect(LINK_BOUNDS.heartbeatMs.min).toBeLessThanOrEqual(LINK_DEFAULTS.heartbeatMs);
    expect(LINK_BOUNDS.drainMs.max).toBeGreaterThanOrEqual(LINK_DEFAULTS.drainMs);
  });

  it('list the error codes, close reasons and drain reasons', () => {
    expect(NODE_ERROR_CODES).toEqual([
      'bad_token',
      'revoked',
      'link_version',
      'node_outdated',
      'replaced',
      'rate_limited',
      'invalid_message',
    ]);
    expect(LINK_CLOSE_REASONS).toEqual(['revoked', 'shutdown', 'replaced', 'rate_limited']);
    expect(NODE_DRAIN_REASONS).toEqual(['shutdown', 'update']);
  });

  it('fatal ends stop the node from retrying', () => {
    expect(LINK_FATAL_ENDS).toEqual([
      'bad_token',
      'revoked',
      'link_version',
      'node_outdated',
      'replaced',
    ]);
    for (const code of NODE_ERROR_CODES) {
      expect(isFatalLinkEnd(code)).toBe(LINK_FATAL_ENDS.includes(code));
    }
    expect(isFatalLinkEnd('shutdown')).toBe(false);
    expect(isFatalLinkEnd('rate_limited')).toBe(false);
    expect(isFatalLinkEnd('invalid_message')).toBe(false);
    expect(isFatalLinkEnd('replaced')).toBe(true);
    expect(isFatalLinkEnd('revoked')).toBe(true);
  });
});

describe('building blocks', () => {
  it('CidSchema', () => {
    for (const cid of ['c1', '0', 'a-B_9', 'x'.repeat(32)]) {
      expect(CidSchema.safeParse(cid).success, cid).toBe(true);
    }
    for (const cid of [
      '',
      'x'.repeat(33),
      'c 1',
      'c.1',
      'ü',
      'dc1_abcdefgh_abcdefghijklmnopqrstuvwxyz234567',
    ]) {
      expect(CidSchema.safeParse(cid).success, cid).toBe(false);
    }
  });

  it('VersionSchema', () => {
    for (const v of ['0.0.0', '1.2.3', '0.4.0-rc.1', '12345.0.1', '1.0.0-beta-2']) {
      expect(VersionSchema.safeParse(v).success, v).toBe(true);
    }
    for (const v of ['', '1', '1.2', 'v1.2.3', '1.2.3.4', '1.2.3-', '1.2.3+build', '123456.0.0']) {
      expect(VersionSchema.safeParse(v).success, v).toBe(false);
    }
  });

  it('NodeNameSchema and NodeEngineStatusSchema', () => {
    expect(NodeNameSchema.safeParse('fast-box').success).toBe(true);
    expect(NodeNameSchema.safeParse('').success).toBe(false);
    expect(NodeNameSchema.safeParse('x'.repeat(33)).success).toBe(false);
    expect(NodeEngineStatusSchema.safeParse(STATUS.engines[0]).success).toBe(true);
    expect(NodeEngineStatusSchema.safeParse({ ...STATUS.engines[0], busy: -1 }).success).toBe(
      false,
    );
    expect(NodeEngineStatusSchema.safeParse({ ...STATUS.engines[0], busy: 1.5 }).success).toBe(
      false,
    );
    expect(NodeEngineStatusSchema.safeParse({ id: 'stockfish', busy: 0, idle: 0 }).success).toBe(
      false,
    );
    expect(NodeEngineStatusSchema.safeParse({ ...STATUS.engines[0], id: 'bad id' }).success).toBe(
      false,
    );
  });
});

describe('node → hub messages', () => {
  it('node.hello round-trips with engine descriptors incl. style/rating/maxNodes', () => {
    const parsed = roundTrip(HELLO, parseNodeToHubMessage);
    expect(parsed.engines[1]).toEqual(HELLO.engines[1]);
    expect(NodeHelloMessageSchema.safeParse(HELLO).success).toBe(true);
  });

  it('node.hello accepts a reserved wss:// publicUrl only', () => {
    expect(
      NodeHelloMessageSchema.safeParse({ ...HELLO, publicUrl: 'wss://node.example.org/ws' })
        .success,
    ).toBe(true);
    expect(
      NodeHelloMessageSchema.safeParse({ ...HELLO, publicUrl: 'wss://node.example.org' }).success,
    ).toBe(true);
    expect(
      NodeHelloMessageSchema.safeParse({ ...HELLO, publicUrl: 'ws://node.example.org' }).success,
    ).toBe(false);
    expect(NodeHelloMessageSchema.safeParse({ ...HELLO, publicUrl: 'https://x.org' }).success).toBe(
      false,
    );
    expect(NodeHelloMessageSchema.safeParse({ ...HELLO, publicUrl: 'wss://' }).success).toBe(false);
    expect(
      NodeHelloMessageSchema.safeParse({ ...HELLO, publicUrl: `wss://${'x'.repeat(260)}` }).success,
    ).toBe(false);
  });

  it('node.hello rejects malformed fields', () => {
    const bad = (patch: Record<string, unknown>) =>
      expect(
        NodeHelloMessageSchema.safeParse({ ...HELLO, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    bad({ linkVersion: 0 });
    bad({ linkVersion: 1.5 });
    bad({ nodeToken: '' });
    bad({ nodeToken: 'x'.repeat(MAX_TOKEN_LENGTH + 1) });
    bad({ node: { version: 'v1', platform: 'linux', arch: 'x64' } });
    bad({ node: { version: '0.1.0', platform: '', arch: 'x64' } });
    bad({ node: undefined });
    bad({ engines: new Array(LINK_BOUNDS.maxEngines + 1).fill(HELLO.engines[0]) });
    bad({ limits: { ...DEFAULT_LIMITS, maxDepth: PROTOCOL_BOUNDS.depth.max + 1 } });
    bad({ maxSessions: 0 });
    bad({ maxSessions: LINK_BOUNDS.maxSessions.max + 1 });
    bad({ pool: 'yes' });
    // A malformed token is a schema-level pass (string) and a hub-level `bad_token`.
    expect(
      NodeHelloMessageSchema.safeParse({ ...HELLO, nodeToken: 'not-a-node-token' }).success,
    ).toBe(true);
  });

  it('node.status round-trips and bounds its numbers', () => {
    roundTrip(STATUS, parseNodeToHubMessage);
    expect(NodeStatusMessageSchema.safeParse({ ...STATUS, load1: 0 }).success).toBe(true);
    expect(NodeStatusMessageSchema.safeParse({ ...STATUS, load1: -1 }).success).toBe(false);
    expect(NodeStatusMessageSchema.safeParse({ ...STATUS, sessions: -1 }).success).toBe(false);
    expect(NodeStatusMessageSchema.safeParse({ ...STATUS, maxSessions: 0 }).success).toBe(false);
    expect(NodeStatusMessageSchema.safeParse({ ...STATUS, engines: [] }).success).toBe(true);
  });

  it('client.msg from a node relays info, bestmove and session/search errors', () => {
    roundTrip(INFO, parseNodeToHubMessage);
    roundTrip(
      {
        type: 'client.msg',
        cid: 'c1',
        msg: {
          type: 'bestmove',
          sessionId: 'tab-1',
          searchId: 7,
          bestMove: { move: 'e2e4' },
          reason: 'completed',
        },
      },
      parseNodeToHubMessage,
    );
    roundTrip(
      {
        type: 'client.msg',
        cid: 'c1',
        msg: {
          type: 'error',
          code: 'engine_crashed',
          message: 'engine exited',
          sessionId: 'tab-1',
        },
      },
      parseNodeToHubMessage,
    );
    roundTrip(
      {
        type: 'client.msg',
        cid: 'c1',
        msg: {
          type: 'error',
          code: 'no_capacity',
          message: 'full',
          sessionId: 'tab-1',
          searchId: 7,
        },
      },
      parseNodeToHubMessage,
    );
    // The relayed payload is a valid player-protocol server message as-is.
    expect(parseServerMessage(INFO.msg).ok).toBe(true);
  });

  it('client.msg from a node rejects connection-level errors and non-analysis messages', () => {
    const r = parseNodeToHubMessage({
      type: 'client.msg',
      cid: 'c1',
      msg: { type: 'error', code: 'rate_limited', message: 'slow down' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('sessionId');
    expect(
      ClientMsgFromNodeSchema.safeParse({ type: 'client.msg', cid: 'c1', msg: { type: 'pong' } })
        .success,
    ).toBe(false);
    expect(
      ClientMsgFromNodeSchema.safeParse({
        type: 'client.msg',
        cid: 'c1',
        msg: {
          type: 'welcome',
          protocolVersion: 1,
          serverVersion: '0',
          limits: DEFAULT_LIMITS,
          engines: [],
        },
      }).success,
    ).toBe(false);
    // Player messages are not accepted in the node → hub direction either.
    expect(ClientMsgFromNodeSchema.safeParse(ANALYZE).success).toBe(false);
    expect(NodeRelayMessageSchema.safeParse(ANALYZE.msg).success).toBe(false);
    expect(NodeRelayMessageSchema.safeParse(INFO.msg).success).toBe(true);
  });

  it('client.closed and node.drain round-trip', () => {
    roundTrip({ type: 'client.closed', cid: 'c1' }, parseNodeToHubMessage);
    expect(ClientClosedMessageSchema.safeParse({ type: 'client.closed' }).success).toBe(false);
    for (const reason of NODE_DRAIN_REASONS)
      roundTrip({ type: 'node.drain', reason }, parseNodeToHubMessage);
    expect(NodeDrainMessageSchema.safeParse({ type: 'node.drain', reason: 'bored' }).success).toBe(
      false,
    );
  });

  it('the union lists exactly the five node → hub types', () => {
    expect(NodeToHubMessageSchema.options.map((o) => o.shape.type.value)).toEqual([
      'node.hello',
      'node.status',
      'client.msg',
      'client.closed',
      'node.drain',
    ]);
    // Hub → node types are unknown in this direction.
    const r = parseNodeToHubMessage(WELCOME);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown message type');
  });
});

describe('hub → node messages', () => {
  it('node.welcome round-trips and bounds heartbeat/drain', () => {
    roundTrip(WELCOME, parseHubToNodeMessage);
    const bad = (patch: Record<string, unknown>) =>
      expect(
        NodeWelcomeMessageSchema.safeParse({ ...WELCOME, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    bad({ heartbeatMs: LINK_BOUNDS.heartbeatMs.min - 1 });
    bad({ heartbeatMs: LINK_BOUNDS.heartbeatMs.max + 1 });
    bad({ drainMs: -1 });
    bad({ nodeId: 'local' });
    bad({ name: '' });
    bad({ hubVersion: 'latest' });
    bad({ minNodeVersion: '1' });
    bad({ pool: undefined });
  });

  it('node.error carries every catalogued code', () => {
    for (const code of NODE_ERROR_CODES) {
      roundTrip({ type: 'node.error', code, message: `because ${code}` }, parseHubToNodeMessage);
    }
    expect(
      NodeErrorMessageSchema.safeParse({ type: 'node.error', code: 'teapot', message: '' }).success,
    ).toBe(false);
    expect(
      NodeErrorMessageSchema.safeParse({ type: 'node.error', code: 'bad_token' }).success,
    ).toBe(false);
    expect(
      NodeErrorMessageSchema.safeParse({
        type: 'node.error',
        code: 'bad_token',
        message: 'x'.repeat(1001),
      }).success,
    ).toBe(false);
  });

  it('client.open round-trips a private route with tokenId and label', () => {
    roundTrip(OPEN, parseHubToNodeMessage);
    roundTrip(
      { type: 'client.open', cid: 'c2', limits: DEFAULT_LIMITS, shared: false, tier: 'full' },
      parseHubToNodeMessage,
    );
  });

  it('client.open on a pool route carries neither tokenId nor label', () => {
    roundTrip(
      { type: 'client.open', cid: 'c3', limits: DEFAULT_LIMITS, shared: true, tier: 'standard' },
      parseHubToNodeMessage,
    );
    const leak = parseHubToNodeMessage({ ...OPEN, shared: true });
    expect(leak.ok).toBe(false);
    if (!leak.ok) expect(leak.error).toContain('pool route');
    expect(
      ClientOpenMessageSchema.safeParse({ ...OPEN, shared: true, tokenId: undefined }).success,
    ).toBe(false);
    expect(
      ClientOpenMessageSchema.safeParse({ ...OPEN, shared: true, label: undefined }).success,
    ).toBe(false);
  });

  it('client.open rejects malformed fields', () => {
    const bad = (patch: Record<string, unknown>) =>
      expect(
        ClientOpenMessageSchema.safeParse({ ...OPEN, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    bad({ cid: '' });
    bad({ tier: 'huge' });
    bad({ tokenId: 'ABCDEFGH' });
    bad({ label: '' });
    bad({ label: 'x'.repeat(LINK_BOUNDS.labelMaxLength + 1) });
    bad({ limits: { ...DEFAULT_LIMITS, maxThreads: 0 } });
    bad({ shared: undefined });
  });

  it('client.msg to a node relays an analyze with policyMoves unchanged (ADR-024)', () => {
    const withPolicy: ClientMsgToNode = {
      ...ANALYZE,
      msg: {
        type: 'analyze',
        sessionId: 'hint-1500',
        searchId: 3,
        engine: 'maia-1500',
        fen: START,
        nodes: 1,
        policyMoves: ['e2e4', 'g1f3'],
      },
    };
    const back = roundTrip(withPolicy, parseHubToNodeMessage);
    expect(back.msg).toMatchObject({ type: 'analyze', policyMoves: ['e2e4', 'g1f3'] });
    expect(HubRelayMessageSchema.safeParse(withPolicy.msg).success).toBe(true);
    // the bound applies on the link as on the player socket
    expect(
      ClientMsgToNodeSchema.safeParse({
        ...ANALYZE,
        msg: { ...ANALYZE.msg, policyMoves: ['a2a3', 'a2a4', 'b2b3', 'b2b4', 'c2c3'] },
      }).success,
    ).toBe(false);
  });

  it('client.msg to a node relays analyze, stop and release only', () => {
    roundTrip(ANALYZE, parseHubToNodeMessage);
    roundTrip(
      { type: 'client.msg', cid: 'c1', msg: { type: 'stop', sessionId: 'tab-1' } },
      parseHubToNodeMessage,
    );
    roundTrip(
      { type: 'client.msg', cid: 'c1', msg: { type: 'release', sessionId: 'tab-1' } },
      parseHubToNodeMessage,
    );
    expect(parseClientMessage(ANALYZE.msg).ok).toBe(true);
    for (const msg of [
      { type: 'hello', protocolVersion: 1 },
      { type: 'ping' },
      { type: 'room.create', nick: 'A', clock: null, color: 'random' },
      { type: 'review.stats.get' },
      INFO.msg,
    ]) {
      expect(
        ClientMsgToNodeSchema.safeParse({ type: 'client.msg', cid: 'c1', msg }).success,
        msg.type,
      ).toBe(false);
      expect(HubRelayMessageSchema.safeParse(msg).success, msg.type).toBe(false);
    }
    // The relayed analyze is validated like a player frame (bad FEN → rejected here already).
    expect(
      ClientMsgToNodeSchema.safeParse({ ...ANALYZE, msg: { ...ANALYZE.msg, fen: 'not a fen' } })
        .success,
    ).toBe(false);
  });

  it('client.close and link.close round-trip', () => {
    roundTrip({ type: 'client.close', cid: 'c1' }, parseHubToNodeMessage);
    expect(ClientCloseMessageSchema.safeParse({ type: 'client.close', cid: 'c 1' }).success).toBe(
      false,
    );
    for (const reason of LINK_CLOSE_REASONS) {
      roundTrip({ type: 'link.close', reason, code: 1008 }, parseHubToNodeMessage);
    }
    roundTrip(
      { type: 'link.close', reason: 'shutdown', code: 1012, message: 'deploy' },
      parseHubToNodeMessage,
    );
    expect(
      LinkCloseMessageSchema.safeParse({ type: 'link.close', reason: 'shutdown' }).success,
    ).toBe(false);
    expect(
      LinkCloseMessageSchema.safeParse({ type: 'link.close', reason: 'shutdown', code: 999 })
        .success,
    ).toBe(false);
    expect(
      LinkCloseMessageSchema.safeParse({ type: 'link.close', reason: 'shutdown', code: 5000 })
        .success,
    ).toBe(false);
    expect(
      LinkCloseMessageSchema.safeParse({ type: 'link.close', reason: 'bye', code: 1000 }).success,
    ).toBe(false);
  });

  it('the union lists exactly the six hub → node types', () => {
    expect(HubToNodeMessageSchema.options.map((o) => o.shape.type.value)).toEqual([
      'node.welcome',
      'node.error',
      'client.open',
      'client.msg',
      'client.close',
      'link.close',
    ]);
    const r = parseHubToNodeMessage(HELLO);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('unknown message type');
    // `client.msg` exists in both directions with different payloads.
    expect(parseHubToNodeMessage(INFO).ok).toBe(false);
    expect(parseNodeToHubMessage(ANALYZE).ok).toBe(false);
  });
});

describe('parsers', () => {
  it('reject non-JSON, non-objects, unknown types and strip unknown fields', () => {
    const r1 = parseHubToNodeMessage('{nope');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toContain('invalid JSON');
    for (const input of ['[]', '"x"', 'null', 42, null, [1]]) {
      const r = parseNodeToHubMessage(input);
      expect(r.ok, String(input)).toBe(false);
      if (!r.ok) expect(r.error).toContain('JSON object');
    }
    const r2 = parseNodeToHubMessage({ type: 'node.hello2' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe('unknown message type "node.hello2"');
    const r3 = parseNodeToHubMessage({});
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).toBe('unknown message type undefined');
    const r4 = parseNodeToHubMessage({
      ...STATUS,
      extra: 1,
      engines: [{ ...STATUS.engines[0], ram: 2 }],
    });
    expect(r4.ok).toBe(true);
    if (r4.ok) {
      expect(r4.message).not.toHaveProperty('extra');
      expect((r4.message as NodeStatusMessage).engines[0]).not.toHaveProperty('ram');
    }
  });

  it('report the message type and path on schema failures', () => {
    const r = parseNodeToHubMessage({ ...STATUS, load1: -3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^node\.status: load1: /);
  });

  it('enforce MAX_LINK_MESSAGE_BYTES in UTF-8 bytes', () => {
    const fits = { type: 'client.closed', cid: 'c1', pad: 'x'.repeat(MAX_LINK_MESSAGE_BYTES - 60) };
    const fitsText = JSON.stringify(fits);
    expect(fitsText.length).toBeLessThanOrEqual(MAX_LINK_MESSAGE_BYTES);
    expect(parseNodeToHubMessage(fitsText).ok).toBe(true);

    const tooLong = JSON.stringify({ ...fits, pad: 'x'.repeat(MAX_LINK_MESSAGE_BYTES) });
    const r1 = parseNodeToHubMessage(tooLong);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe(`message exceeds ${MAX_LINK_MESSAGE_BYTES} bytes`);

    // Same number of UTF-16 units as `fits`, but 3 bytes per character → over the cap.
    const wide = JSON.stringify({ ...fits, pad: '€'.repeat(MAX_LINK_MESSAGE_BYTES - 60) });
    expect(wide.length).toBe(fitsText.length);
    expect(parseNodeToHubMessage(wide).ok).toBe(false);
    // Already-parsed values are not size-checked (the socket layer did that).
    expect(parseNodeToHubMessage({ ...fits, pad: 'x'.repeat(MAX_LINK_MESSAGE_BYTES) }).ok).toBe(
      true,
    );
  });

  it('a maximal player frame fits in a client.msg envelope', () => {
    // A `pv` of PROTOCOL_BOUNDS.pvMaxLength moves is the largest info a node can produce.
    const pv = new Array(PROTOCOL_BOUNDS.pvMaxLength).fill('e2e4q');
    const big: NodeToHubMessage = {
      ...INFO,
      cid: 'x'.repeat(32),
      msg: { ...INFO_MSG, sessionId: 'y'.repeat(64), info: { ...INFO_MSG.info, pv } },
    };
    const text = serializeLinkMessage(big);
    expect(text.ok).toBe(true);
    if (text.ok) expect(parseNodeToHubMessage(text.text).ok).toBe(true);
  });
});

describe('serializeLinkMessage', () => {
  it('encodes compact JSON', () => {
    const r = serializeLinkMessage({ type: 'client.close', cid: 'c1' });
    expect(r).toEqual({ ok: true, text: '{"type":"client.close","cid":"c1"}' });
  });

  it('refuses frames over MAX_LINK_MESSAGE_BYTES instead of throwing', () => {
    const msg = {
      type: 'node.error',
      code: 'bad_token',
      message: 'é'.repeat(MAX_LINK_MESSAGE_BYTES / 2),
    } as HubToNodeMessage;
    const r = serializeLinkMessage(msg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^node\.error: \d+ bytes exceed 20480$/);
  });
});

describe('utf8ByteLength', () => {
  it('matches UTF-8 encoding rules', () => {
    expect(utf8ByteLength('')).toBe(0);
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('𝄞')).toBe(4); // surrogate pair
    expect(utf8ByteLength('\ud834')).toBe(3); // lone surrogate → U+FFFD
    expect(utf8ByteLength('a€𝄞é')).toBe(1 + 3 + 4 + 2);
  });
});

describe('versions', () => {
  it('compareVersions orders numerically with pre-releases first', () => {
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBe(-1);
    expect(compareVersions('1.2.0', '1.2.0-rc.1')).toBe(1);
    expect(compareVersions('1.2.0-rc.1', '1.2.0-rc.2')).toBe(-1);
    expect(compareVersions('1.2.0-rc.1', '1.2.0-rc.1')).toBe(0);
    expect(compareVersions('1.2.0-beta', '1.1.9')).toBe(1);
  });

  it('checkLinkCompatibility accepts a matching link version and a recent node', () => {
    expect(checkLinkCompatibility(HELLO, { minNodeVersion: '0.3.0' })).toEqual({ ok: true });
    expect(checkLinkCompatibility(HELLO, { minNodeVersion: '0.3.1' })).toEqual({ ok: true });
    expect(checkLinkCompatibility(HELLO, { minNodeVersion: '0.3.0', linkVersion: 1 })).toEqual({
      ok: true,
    });
  });

  it('checkLinkCompatibility refuses link version mismatches before node versions', () => {
    const r = checkLinkCompatibility({ ...HELLO, linkVersion: 2 }, { minNodeVersion: '0.3.0' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('link_version');
      expect(r.message).toContain('hub speaks 1');
      expect(r.message).toContain('@daisychess/node');
    }
    const r2 = checkLinkCompatibility(HELLO, { minNodeVersion: '9.0.0', linkVersion: 2 });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('link_version');
  });

  it('checkLinkCompatibility refuses outdated nodes', () => {
    const r = checkLinkCompatibility(HELLO, { minNodeVersion: '0.4.0' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('node_outdated');
      expect(r.message).toContain('0.3.1');
      expect(r.message).toContain('0.4.0');
    }
    expect(isFatalLinkEnd(r.ok ? 'shutdown' : r.code)).toBe(true);
  });

  it('nodeVersionStatus tells a node whether to update', () => {
    expect(nodeVersionStatus('0.3.1', WELCOME)).toBe('current');
    expect(nodeVersionStatus('0.3.2', WELCOME)).toBe('current');
    expect(nodeVersionStatus('0.3.0', WELCOME)).toBe('update_available');
    expect(nodeVersionStatus('0.2.9', WELCOME)).toBe('outdated');
    expect(nodeVersionStatus('0.3.0-rc.1', WELCOME)).toBe('outdated');
  });
});
