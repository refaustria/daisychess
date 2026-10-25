import { randomBytes } from 'node:crypto';
import {
  ClientOpenMessageSchema,
  LINK_BOUNDS,
  LINK_DEFAULTS,
  type ClientClosedMessage,
  type ClientMsgFromNode,
  type ClientOpenMessage,
  type HubToNodeMessage,
  type Limits,
  type TokenTier,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { Deliver, SessionPeer } from '../sessions/ClientSessions.js';
import { allowRate, type RateLimit } from '../sessions/rateLimit.js';
import { RelaySessions, type RelaySessionsOptions } from './RelaySessions.js';

/** What the router (M24-6) decided for one player connection, announced in `client.open`. */
export interface RouteContext {
  /** Composed limits (`minLimits(tier, node)`); also enforced hub-side before relaying. */
  limits: Limits;
  /** Routed through the pool: the node learns nothing about the player's token. */
  shared: boolean;
  tier: TokenTier;
  /** Private routes only (the token belongs to this node's operator); dropped when `shared`. */
  tokenId?: string;
  /** Private routes only; dropped when `shared`. */
  label?: string;
}

export interface HubNodeLinkOptions {
  nodeId: string;
  /** Sends one validated frame on the node's socket; false when the link is gone. */
  send: (msg: HubToNodeMessage) => boolean;
  logger: PoolLogger;
  /**
   * The node abused the link (too many frames for unknown `cid`s); the owner closes the link
   * with `link.close rate_limited`. Called at most once.
   */
  onAbuse: (reason: 'rate_limited', message: string) => void;
  /** `client.msg`/`client.closed` frames for unknown `cid`s tolerated per minute. Default 100. */
  unknownCidLimit?: RateLimit;
  /** Tuning of every {@link RelaySessions} of this link. */
  relay?: Pick<RelaySessionsOptions, 'closeTimeoutMs' | 'infoPerSecondPerSearch' | 'now'>;
  /** `cid` source (tests). Default: 96 random bits, base64url (16 characters). */
  randomCid?: () => string;
  now?: () => number;
}

export interface HubNodeLinkStats {
  clients: number;
  opened: number;
  unknownCid: number;
}

/** Recently finished cids whose late frames are ignored silently (not counted as unknown). */
const RECENT_CIDS = 1_024;

const defaultCid = (): string => randomBytes(12).toString('base64url');

/**
 * The hub's end of one node's link (ADR-020 relay layering §6), owned by `LinkServer`: every
 * player connection routed to the node becomes a {@link RelaySessions} under a hub-assigned,
 * unpredictable `cid`. Node frames for a `cid` are dispatched to its relay; frames for unknown
 * `cid`s are ignored and counted (more than 100 in a minute closes the link `rate_limited`). When
 * the link goes away, {@link lost} ends every relay with terminal messages.
 */
export class HubNodeLink {
  private readonly relays = new Map<string, RelaySessions>();
  /** `cid`s of shared (pool) routes, for {@link evictShared}. */
  private readonly shared = new Set<string>();
  private readonly recent = new Set<string>();
  private readonly unknownTimes: number[] = [];
  private readonly unknownLimit: RateLimit;
  private readonly randomCid: () => string;
  private readonly now: () => number;
  private alive = true;
  private abused = false;
  private opened = 0;
  private unknownCid = 0;

  constructor(private readonly opts: HubNodeLinkOptions) {
    this.unknownLimit = opts.unknownCidLimit ?? {
      max: LINK_DEFAULTS.unknownCidPerMinute,
      windowMs: 60_000,
    };
    this.randomCid = opts.randomCid ?? defaultCid;
    this.now = opts.now ?? Date.now;
  }

  get nodeId(): string {
    return this.opts.nodeId;
  }

  /** False once the link was lost; {@link open} then returns an already-lost channel. */
  get isOpen(): boolean {
    return this.alive;
  }

  /** Open player connections (`cid`s) on this link. */
  get clients(): number {
    return this.relays.size;
  }

  stats(): HubNodeLinkStats {
    return { clients: this.relays.size, opened: this.opened, unknownCid: this.unknownCid };
  }

  /**
   * Routes one player connection to this node: allocates a `cid`, sends `client.open` and
   * returns the channel. On a lost link the channel is returned already lost (its `lost` promise
   * resolved), so the caller's 1012 path handles it like any other node loss.
   */
  open(deliver: Deliver, peer: SessionPeer, route: RouteContext): RelaySessions {
    const cid = this.allocateCid();
    const relay = new RelaySessions(
      deliver,
      { nodeId: this.opts.nodeId, send: (m) => this.alive && this.opts.send(m) },
      cid,
      {
        ...this.opts.relay,
        logger: this.opts.logger,
        limits: route.limits,
        onDone: () => this.forget(cid, relay),
      },
    );
    if (!this.alive) {
      relay.onNodeLost();
      return relay;
    }
    const open: ClientOpenMessage = {
      type: 'client.open',
      cid,
      limits: { ...route.limits },
      shared: route.shared,
      tier: route.tier,
    };
    if (!route.shared) {
      if (route.tokenId !== undefined) open.tokenId = route.tokenId;
      const label = route.label?.slice(0, LINK_BOUNDS.labelMaxLength);
      if (label) open.label = label;
    }
    const valid = ClientOpenMessageSchema.safeParse(open);
    if (!valid.success) {
      // A router bug (limits out of protocol bounds, malformed token id): fail loudly.
      throw new TypeError(`invalid route for client.open: ${valid.error.issues[0]?.message ?? ''}`);
    }
    this.relays.set(cid, relay);
    if (route.shared) this.shared.add(cid);
    this.opened++;
    this.opts.logger.info(
      {
        node: this.opts.nodeId,
        cid,
        conn: peer.id,
        shared: route.shared,
        tier: route.tier,
        ...(open.tokenId ? { tokenId: open.tokenId } : {}),
      },
      'link: client routed to node',
    );
    if (!this.opts.send(open)) relay.onNodeLost();
    return relay;
  }

  /** A `client.msg` or `client.closed` frame from the node (validated by `parseNodeToHubMessage`). */
  onFrame(msg: ClientMsgFromNode | ClientClosedMessage): void {
    if (!this.alive) return;
    const relay = this.relays.get(msg.cid);
    if (!relay) {
      if (this.recent.has(msg.cid)) return;
      this.countUnknown(msg.cid);
      return;
    }
    if (msg.type === 'client.closed') relay.onClientClosed();
    else relay.onNodeMessage(msg.msg);
  }

  /**
   * Ends every shared (pool) relay of this link like a node loss (terminals, then the player's
   * socket closes 1012) and tells the node to drop those clients; private relays are untouched
   * (M24-12: the node left the pool). Returns how many relays were ended.
   */
  evictShared(message: string): number {
    if (!this.alive) return 0;
    let n = 0;
    for (const cid of [...this.shared]) {
      const relay = this.relays.get(cid);
      if (relay?.evict(message)) n++;
    }
    return n;
  }

  /** The link is gone: every relay ends its open searches and sessions. Idempotent. */
  lost(): void {
    if (!this.alive) return;
    this.alive = false;
    const relays = [...this.relays.values()];
    for (const relay of relays) relay.onNodeLost();
    this.relays.clear();
    this.shared.clear();
  }

  // -------------------------------------------------------------------------------------------

  private allocateCid(): string {
    for (;;) {
      const cid = this.randomCid();
      if (!LINK_BOUNDS.cidPattern.test(cid))
        throw new Error('cid generator produced an invalid cid');
      if (!this.relays.has(cid) && !this.recent.has(cid)) return cid;
    }
  }

  private forget(cid: string, relay: RelaySessions): void {
    if (this.relays.get(cid) !== relay) return;
    this.relays.delete(cid);
    this.shared.delete(cid);
    this.recent.add(cid);
    if (this.recent.size > RECENT_CIDS) {
      const oldest = this.recent.values().next().value;
      if (oldest !== undefined) this.recent.delete(oldest);
    }
  }

  private countUnknown(cid: string): void {
    this.unknownCid++;
    if (this.unknownCid % 100 === 1) {
      this.opts.logger.warn(
        { node: this.opts.nodeId, cid, total: this.unknownCid },
        'link: frame for an unknown cid ignored',
      );
    }
    if (this.abused) return;
    if (!allowRate(this.unknownTimes, this.unknownLimit, this.now())) {
      this.abused = true;
      this.opts.onAbuse(
        'rate_limited',
        `more than ${this.unknownLimit.max} frames for unknown cids in ${this.unknownLimit.windowMs} ms`,
      );
    }
  }
}
