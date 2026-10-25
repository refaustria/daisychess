/**
 * Node ⇄ hub link protocol (docs/DECISIONS.md ADR-020 §3).
 *
 * A community engine node opens one outbound WebSocket to the hub (`/link`) and the hub relays
 * player connections over it: every player connection routed to the node becomes a `cid` on the
 * link, and the player's analysis messages travel inside `client.msg` envelopes in both
 * directions. JSON text frames, one message per frame, discriminated by `type`.
 *
 * Lifecycle
 * - First frame from the node: `node.hello` (within `LINK_DEFAULTS.helloTimeoutMs`, else the hub
 *   closes 1008). The hub answers `node.welcome`, or `node.error` and closes.
 * - `node.status` every `node.welcome.heartbeatMs` and whenever the session count changes; the
 *   hub's scheduler reads it. Dead links are detected with WebSocket ping/pong.
 * - `client.open {cid}` precedes every `client.msg` for that `cid`; `client.close {cid}` ends it
 *   (the node stops and releases every session of the `cid`; idempotent) and the node may
 *   acknowledge with `client.closed {cid}` once its leases are gone.
 * - `node.drain` asks the hub to route nothing new; the node closes the link after its running
 *   searches ended or `node.welcome.drainMs` passed. `link.close` announces a hub-side close.
 * - Relayed player messages keep their meaning exactly (ADR-006): `(cid, sessionId)` is the
 *   node's session key, every accepted search ends with exactly one terminal message, order per
 *   session is preserved. Only the analysis subset is relayed: `analyze`/`stop`/`release` to the
 *   node, `info`/`bestmove`/`error` (session- or search-level) back. Rooms and the review store
 *   are served by the hub itself and never traverse the link, so no large-message tier exists
 *   here: a frame is a player frame (≤ `MAX_MESSAGE_BYTES`) plus a small envelope.
 * - Unknown fields are stripped; unknown `type` is rejected; frames over `MAX_LINK_MESSAGE_BYTES`
 *   are rejected (the hub closes the link on one).
 *
 * This module has no Node or DOM dependency so the hub, the node CLI and tests share it.
 */
import { z } from 'zod';
import {
  AnalyzeMessageSchema,
  BestMoveMessageSchema,
  EngineDescriptorSchema,
  EngineIdSchema,
  ErrorMessageSchema,
  InfoMessageSchema,
  LimitsSchema,
  MAX_TOKEN_LENGTH,
  ReleaseMessageSchema,
  StopMessageSchema,
  type ParseResult,
} from './protocol.js';
import { TokenIdSchema, TokenTierSchema } from './tokens.js';

/**
 * Version of this link contract, independent of the player protocol's `PROTOCOL_VERSION`.
 * Bumped on any incompatible change, together with the hub's `NODE_MIN_VERSION`; a node whose
 * `node.hello.linkVersion` differs is answered with `node.error link_version`.
 */
export const LINK_PROTOCOL_VERSION = 1;

/**
 * Maximum UTF-8 size of one link frame in either direction: a player frame
 * (`MAX_MESSAGE_BYTES`, 16 KiB) plus the `client.msg` envelope, rounded up. Review records
 * (ADR-017) never traverse the link (the review store is central), so unlike the player protocol
 * there is no large-message tier.
 */
export const MAX_LINK_MESSAGE_BYTES = 20 * 1024;

/** Hard bounds of the link messages. */
export const LINK_BOUNDS = {
  /** `cid`: hub-assigned per link; never a token, a token id or an IP. */
  cidPattern: /^[A-Za-z0-9_-]{1,32}$/,
  /** `major.minor.patch` with an optional pre-release, e.g. `0.3.1` or `0.4.0-rc.1`. */
  versionPattern: /^\d{1,5}\.\d{1,5}\.\d{1,5}(-[0-9A-Za-z.-]{1,20})?$/,
  /** Node display name (set in the portal, normalised like nicks). */
  nodeNameMaxLength: 32,
  /** Operator-chosen label of a player token, e.g. "Anna's iPad". */
  labelMaxLength: 64,
  maxEngines: 64,
  /** Node-wide engine sessions. */
  maxSessions: { min: 1, max: 1_024 },
  heartbeatMs: { min: 1_000, max: 120_000 },
  drainMs: { min: 0, max: 600_000 },
  publicUrlMaxLength: 256,
  /** `wss://` only (ADR-020 §5); reserved for direct mode. */
  publicUrlPattern: /^wss:\/\/[^\s/?#]+(?:[/?#]\S*)?$/,
  /** WebSocket close codes a hub may announce in `link.close`. */
  closeCode: { min: 1_000, max: 4_999 },
} as const;

/**
 * Operational defaults of ADR-020 §3 shared by hub and node (each side may make its own stricter
 * through configuration; the wire carries `heartbeatMs` and `drainMs` in `node.welcome`).
 */
export const LINK_DEFAULTS = {
  /** `node.status` cadence. */
  heartbeatMs: 10_000,
  /** The hub closes a link that sent no valid `node.hello` within this time. */
  helloTimeoutMs: 10_000,
  /** How long running searches may finish after `node.drain`; then `engine_crashed`. */
  drainMs: 30_000,
  /** Missed WebSocket pongs before either side drops the link. */
  missedPongsToDrop: 2,
  /** Frames per second the hub accepts from one node. */
  maxMessagesPerSecond: 5_000,
  /** `client.msg` for unknown `cid`s per minute before the hub closes `rate_limited`. */
  unknownCidPerMinute: 100,
  /** Per search, the node drops `info` above this rate (never terminal messages). */
  infoPerSecondPerSearch: 60,
  /** The node drops `info` for a `cid` while its socket buffers more than this. */
  maxBufferedBytes: 1024 * 1024,
  /** Node reconnect: exponential backoff with ±20 % jitter, forever (unless fatal). */
  reconnectMinMs: 1_000,
  reconnectMaxMs: 60_000,
  reconnectJitter: 0.2,
} as const;

// ---------------------------------------------------------------------------------------------
// Building blocks

const int = (name: string, { min, max }: { min: number; max: number }) =>
  z.number().int(`${name} must be an integer`).min(min).max(max);

export const CidSchema = z
  .string()
  .regex(LINK_BOUNDS.cidPattern, 'cid must be 1-32 characters of [A-Za-z0-9_-]');

/** Software version of a node or hub, see {@link LINK_BOUNDS.versionPattern}. */
export const VersionSchema = z
  .string()
  .regex(LINK_BOUNDS.versionPattern, 'version must be major.minor.patch[-prerelease]');

export const NodeNameSchema = z.string().min(1).max(LINK_BOUNDS.nodeNameMaxLength);

/** Why the hub refused a `node.hello`. Sent as `node.error`, then the hub closes the link. */
export const NODE_ERROR_CODES = [
  /** Unknown node id or wrong secret. Fatal: the node exits instead of retrying. */
  'bad_token',
  /** The node was revoked in the portal. Fatal. */
  'revoked',
  /** `linkVersion` differs from the hub's {@link LINK_PROTOCOL_VERSION}. Fatal: update the node. */
  'link_version',
  /** `node.version` is below the hub's `NODE_MIN_VERSION`. Fatal: update the node. */
  'node_outdated',
  /**
   * Reserved: a link for this node id is already active and the hub kept it. Hub policy is
   * "newer link wins", so a node normally sees `link.close replaced` instead. Fatal.
   */
  'replaced',
  /** Too many handshakes or frames from this node/IP. Retry with backoff. */
  'rate_limited',
  /** The first frame was not a valid `node.hello`. Retry with backoff. */
  'invalid_message',
] as const;
export type NodeErrorCode = (typeof NODE_ERROR_CODES)[number];

/** Why the hub closes an established link (`link.close`). */
export const LINK_CLOSE_REASONS = [
  /** The node was revoked in the portal. Fatal. */
  'revoked',
  /** The hub restarts or shuts down. Reconnect with backoff. */
  'shutdown',
  /** Another process connected with this node's token; the newer link won. Fatal. */
  'replaced',
  /** Frame rate, frame size or unknown-`cid` limits exceeded. Reconnect with backoff. */
  'rate_limited',
] as const;
export type LinkCloseReason = (typeof LINK_CLOSE_REASONS)[number];

/**
 * Link ends after which a node must stop retrying and exit non-zero (so a Docker restart policy
 * does not hammer the hub, and two processes sharing one token are noticed). Every other end is
 * followed by a reconnect with backoff.
 */
export const LINK_FATAL_ENDS: readonly (NodeErrorCode | LinkCloseReason)[] = [
  'bad_token',
  'revoked',
  'link_version',
  'node_outdated',
  'replaced',
];

export function isFatalLinkEnd(reason: NodeErrorCode | LinkCloseReason): boolean {
  return LINK_FATAL_ENDS.includes(reason);
}

/** Why a node asks to be drained (`node.drain`). */
export const NODE_DRAIN_REASONS = ['shutdown', 'update'] as const;
export type NodeDrainReason = (typeof NODE_DRAIN_REASONS)[number];

/** Per-engine status in `node.status`. */
export const NodeEngineStatusSchema = z.object({
  id: EngineIdSchema,
  /** Leased engine instances. */
  busy: int('busy', { min: 0, max: LINK_BOUNDS.maxSessions.max }),
  /** Started, idle instances. */
  idle: int('idle', { min: 0, max: LINK_BOUNDS.maxSessions.max }),
  /** The engine failed to start or crashed recently; the pool scheduler avoids this node for it. */
  degraded: z.boolean(),
});
export type NodeEngineStatus = z.infer<typeof NodeEngineStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Node → hub

/**
 * First frame of a link. `engines` and `limits` are exactly what the node would put in its own
 * `welcome`; `maxSessions` is the node-wide session cap; `pool` is the node's own switch
 * (`POOL=on`) — effective pool membership is `pool && portal setting`. `publicUrl` is reserved
 * for direct mode (ADR-020 §1) and ignored by a relay-only hub.
 */
export const NodeHelloMessageSchema = z.object({
  type: z.literal('node.hello'),
  linkVersion: z.number().int().min(1),
  /** `dcn_…` node token (ADR-020 §2); the hub answers `bad_token` for anything it cannot parse. */
  nodeToken: z.string().min(1).max(MAX_TOKEN_LENGTH),
  node: z.object({
    version: VersionSchema,
    /** e.g. `linux`, `darwin`, `win32`. */
    platform: z.string().min(1).max(32),
    /** e.g. `x64`, `arm64`. */
    arch: z.string().min(1).max(32),
  }),
  engines: z.array(EngineDescriptorSchema).max(LINK_BOUNDS.maxEngines),
  limits: LimitsSchema,
  maxSessions: int('maxSessions', LINK_BOUNDS.maxSessions),
  pool: z.boolean(),
  publicUrl: z
    .string()
    .max(LINK_BOUNDS.publicUrlMaxLength)
    .regex(LINK_BOUNDS.publicUrlPattern, 'publicUrl must be a wss:// URL')
    .optional(),
});

/** The scheduler's input. Sent every `heartbeatMs` and whenever `sessions` changes. */
export const NodeStatusMessageSchema = z.object({
  type: z.literal('node.status'),
  sessions: int('sessions', { min: 0, max: LINK_BOUNDS.maxSessions.max }),
  maxSessions: int('maxSessions', LINK_BOUNDS.maxSessions),
  /** 1-minute load average (0 where the platform has none). */
  load1: z.number().min(0).max(100_000),
  engines: z.array(NodeEngineStatusSchema).max(LINK_BOUNDS.maxEngines),
});

/** What a node may say about a player: only session- or search-level messages. */
export const NodeRelayMessageSchema = z.discriminatedUnion('type', [
  InfoMessageSchema,
  BestMoveMessageSchema,
  ErrorMessageSchema,
]);
export type NodeRelayMessage = z.infer<typeof NodeRelayMessageSchema>;

/**
 * A relayed player message from the node. A connection-level `error` (no `sessionId`) is
 * rejected here: a node has nothing to say about a player's connection, only about sessions
 * it leases, so the hub never forwards one (ADR-020 §3).
 */
export const ClientMsgFromNodeSchema = z
  .object({
    type: z.literal('client.msg'),
    cid: CidSchema,
    msg: NodeRelayMessageSchema,
  })
  .refine((m) => m.msg.type !== 'error' || m.msg.sessionId !== undefined, {
    path: ['msg', 'sessionId'],
    message: 'a node error must carry sessionId',
  });

/** Optional acknowledgement that every lease of `cid` is gone (frees per-IP slots exactly). */
export const ClientClosedMessageSchema = z.object({
  type: z.literal('client.closed'),
  cid: CidSchema,
});

/** The node wants to stop: route nothing new; running searches may finish within `drainMs`. */
export const NodeDrainMessageSchema = z.object({
  type: z.literal('node.drain'),
  reason: z.enum(NODE_DRAIN_REASONS),
});

export const NodeToHubMessageSchema = z.discriminatedUnion('type', [
  NodeHelloMessageSchema,
  NodeStatusMessageSchema,
  ClientMsgFromNodeSchema,
  ClientClosedMessageSchema,
  NodeDrainMessageSchema,
]);

export type NodeHelloMessage = z.infer<typeof NodeHelloMessageSchema>;
export type NodeStatusMessage = z.infer<typeof NodeStatusMessageSchema>;
export type ClientMsgFromNode = z.infer<typeof ClientMsgFromNodeSchema>;
export type ClientClosedMessage = z.infer<typeof ClientClosedMessageSchema>;
export type NodeDrainMessage = z.infer<typeof NodeDrainMessageSchema>;
export type NodeToHubMessage = z.infer<typeof NodeToHubMessageSchema>;

// ---------------------------------------------------------------------------------------------
// Hub → node

/** Accepted `node.hello`. `pool` is the effective pool membership (node switch and portal). */
export const NodeWelcomeMessageSchema = z.object({
  type: z.literal('node.welcome'),
  linkVersion: z.number().int().min(1),
  hubVersion: VersionSchema,
  nodeId: TokenIdSchema,
  name: NodeNameSchema,
  pool: z.boolean(),
  heartbeatMs: int('heartbeatMs', LINK_BOUNDS.heartbeatMs),
  drainMs: int('drainMs', LINK_BOUNDS.drainMs),
  /** Nodes below this are refused with `node_outdated` (the hub's `NODE_MIN_VERSION`). */
  minNodeVersion: VersionSchema,
  /** Newest published node; the node logs "a newer node is available" once a day. */
  latestNodeVersion: VersionSchema,
});

/** Refused `node.hello`; the hub closes the link right after. */
export const NodeErrorMessageSchema = z.object({
  type: z.literal('node.error'),
  code: z.enum(NODE_ERROR_CODES),
  message: z.string().max(1_000),
});

/**
 * A player connection routed to this node. `limits` are the composed limits the node must
 * enforce for this `cid` (≤ its own; it checks again against its own limits anyway). `shared`
 * tells whether the connection came through the pool; `tokenId` and `label` identify the
 * player's token to the node's operator and are therefore only present on private routes
 * (the token belongs to this node's operator) — a pool node learns nothing about the player.
 */
export const ClientOpenMessageSchema = z
  .object({
    type: z.literal('client.open'),
    cid: CidSchema,
    limits: LimitsSchema,
    shared: z.boolean(),
    tier: TokenTierSchema,
    tokenId: TokenIdSchema.optional(),
    label: z.string().min(1).max(LINK_BOUNDS.labelMaxLength).optional(),
  })
  .refine((m) => !m.shared || (m.tokenId === undefined && m.label === undefined), {
    path: ['tokenId'],
    message: 'a pool route carries neither tokenId nor label',
  });

/** What the hub relays to a node: the analysis subset of the player protocol, validated. */
export const HubRelayMessageSchema = z.discriminatedUnion('type', [
  AnalyzeMessageSchema,
  StopMessageSchema,
  ReleaseMessageSchema,
]);
export type HubRelayMessage = z.infer<typeof HubRelayMessageSchema>;

export const ClientMsgToNodeSchema = z.object({
  type: z.literal('client.msg'),
  cid: CidSchema,
  msg: HubRelayMessageSchema,
});

/** The player left or was re-routed: stop and release every session of `cid`. Idempotent. */
export const ClientCloseMessageSchema = z.object({
  type: z.literal('client.close'),
  cid: CidSchema,
});

/** The hub is about to close the link with WebSocket close code `code`. */
export const LinkCloseMessageSchema = z.object({
  type: z.literal('link.close'),
  reason: z.enum(LINK_CLOSE_REASONS),
  code: int('code', LINK_BOUNDS.closeCode),
  message: z.string().max(1_000).optional(),
});

export const HubToNodeMessageSchema = z.discriminatedUnion('type', [
  NodeWelcomeMessageSchema,
  NodeErrorMessageSchema,
  ClientOpenMessageSchema,
  ClientMsgToNodeSchema,
  ClientCloseMessageSchema,
  LinkCloseMessageSchema,
]);

export type NodeWelcomeMessage = z.infer<typeof NodeWelcomeMessageSchema>;
export type NodeErrorMessage = z.infer<typeof NodeErrorMessageSchema>;
export type ClientOpenMessage = z.infer<typeof ClientOpenMessageSchema>;
export type ClientMsgToNode = z.infer<typeof ClientMsgToNodeSchema>;
export type ClientCloseMessage = z.infer<typeof ClientCloseMessageSchema>;
export type LinkCloseMessage = z.infer<typeof LinkCloseMessageSchema>;
export type HubToNodeMessage = z.infer<typeof HubToNodeMessageSchema>;

/** Any link frame. */
export type LinkMessage = NodeToHubMessage | HubToNodeMessage;

// ---------------------------------------------------------------------------------------------
// Parsing and serialising

const NODE_TO_HUB_TYPES = NodeToHubMessageSchema.options.map((o) => o.shape.type.value);
const HUB_TO_NODE_TYPES = HubToNodeMessageSchema.options.map((o) => o.shape.type.value);

/** UTF-8 length of `text` without `TextEncoder` (engine-core uses no platform globals). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      // Surrogate pair → one 4-byte sequence; a lone surrogate encodes as 3 bytes (U+FFFD).
      const low = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function formatIssues(issues: z.core.$ZodIssue[]): string {
  return issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

function parseLink<T>(
  schema: z.ZodType<T>,
  knownTypes: readonly string[],
  input: unknown,
): ParseResult<T> {
  let value = input;
  if (typeof input === 'string') {
    // `length` (UTF-16 units) never exceeds the UTF-8 size, so it is a cheap first cut.
    if (input.length > MAX_LINK_MESSAGE_BYTES || utf8ByteLength(input) > MAX_LINK_MESSAGE_BYTES) {
      return { ok: false, error: `message exceeds ${MAX_LINK_MESSAGE_BYTES} bytes` };
    }
    try {
      value = JSON.parse(input);
    } catch (err) {
      return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'message must be a JSON object' };
  }
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string' || !knownTypes.includes(type)) {
    return { ok: false, error: `unknown message type ${JSON.stringify(type)}` };
  }
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, message: result.data }
    : { ok: false, error: `${type}: ${formatIssues(result.error.issues)}` };
}

/** Hub side: validates a frame received from a node (JSON text or a parsed value). */
export function parseNodeToHubMessage(input: unknown): ParseResult<NodeToHubMessage> {
  return parseLink(NodeToHubMessageSchema, NODE_TO_HUB_TYPES, input);
}

/** Node side: validates a frame received from the hub (JSON text or a parsed value). */
export function parseHubToNodeMessage(input: unknown): ParseResult<HubToNodeMessage> {
  return parseLink(HubToNodeMessageSchema, HUB_TO_NODE_TYPES, input);
}

export type SerializeResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Encodes a link frame and refuses one over {@link MAX_LINK_MESSAGE_BYTES} instead of letting the
 * peer close the link over it. A relayed player frame always fits (16 KiB + envelope); the only
 * way to exceed the cap is a bug on the sender's side, which this reports rather than throws.
 */
export function serializeLinkMessage(msg: LinkMessage): SerializeResult {
  const text = JSON.stringify(msg);
  const bytes = utf8ByteLength(text);
  return bytes > MAX_LINK_MESSAGE_BYTES
    ? { ok: false, error: `${msg.type}: ${bytes} bytes exceed ${MAX_LINK_MESSAGE_BYTES}` }
    : { ok: true, text };
}

// ---------------------------------------------------------------------------------------------
// Version negotiation

/**
 * Orders two {@link VersionSchema} strings: numeric `major.minor.patch`, then a pre-release sorts
 * before the release of the same number (`1.2.0-rc.1 < 1.2.0`), pre-releases among themselves
 * by plain string comparison. Returns -1, 0 or 1.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [aNum, aPre] = splitVersion(a);
  const [bNum, bPre] = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    const x = aNum[i] ?? 0;
    const y = bNum[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (aPre === bPre) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre < bPre ? -1 : 1;
}

function splitVersion(v: string): [number[], string | undefined] {
  const dash = v.indexOf('-');
  const core = dash === -1 ? v : v.slice(0, dash);
  const pre = dash === -1 ? undefined : v.slice(dash + 1);
  return [core.split('.').map((p) => Number.parseInt(p, 10) || 0), pre];
}

export type LinkCompatibility =
  | { ok: true }
  | { ok: false; code: Extract<NodeErrorCode, 'link_version' | 'node_outdated'>; message: string };

/**
 * Hub side: decides whether a `node.hello` may be served. `linkVersion` must equal the hub's
 * (the link has no backward-compatible range: both sides ship from this package), and the node's
 * software must be at least `minNodeVersion`.
 */
export function checkLinkCompatibility(
  hello: Pick<NodeHelloMessage, 'linkVersion' | 'node'>,
  hub: { minNodeVersion: string; linkVersion?: number },
): LinkCompatibility {
  const expected = hub.linkVersion ?? LINK_PROTOCOL_VERSION;
  if (hello.linkVersion !== expected) {
    return {
      ok: false,
      code: 'link_version',
      message: `link protocol ${hello.linkVersion} is not supported (hub speaks ${expected}); update @daisychess/node`,
    };
  }
  if (compareVersions(hello.node.version, hub.minNodeVersion) < 0) {
    return {
      ok: false,
      code: 'node_outdated',
      message: `node ${hello.node.version} is older than the minimum ${hub.minNodeVersion}; update @daisychess/node`,
    };
  }
  return { ok: true };
}

/**
 * Node side, from `node.welcome`: `outdated` (below `minNodeVersion`: the hub still served this
 * hello but will stop soon), `update_available` (below `latestNodeVersion`: log once a day), or
 * `current`.
 */
export function nodeVersionStatus(
  ownVersion: string,
  welcome: Pick<NodeWelcomeMessage, 'minNodeVersion' | 'latestNodeVersion'>,
): 'outdated' | 'update_available' | 'current' {
  if (compareVersions(ownVersion, welcome.minNodeVersion) < 0) return 'outdated';
  if (compareVersions(ownVersion, welcome.latestNodeVersion) < 0) return 'update_available';
  return 'current';
}
