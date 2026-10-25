import type {
  EngineDescriptor,
  Limits,
  NodeDrainReason,
  NodeEngineStatus,
  NodeStatusMessage,
} from '@daisychess/engine-core';
import type { PoolLogger } from '../engines/EnginePool.js';
import type { HubNodeLink } from './HubNodeLink.js';

/** The latest `node.status` of a node (the scheduler's input, ADR-020 §4). */
export interface NodeStatusSnapshot {
  readonly sessions: number;
  readonly maxSessions: number;
  readonly load1: number;
  readonly engines: readonly NodeEngineStatus[];
  /** When the hub received it (ms). */
  readonly at: number;
}

/** `online`: routable; `draining`: sent `node.drain`, nothing new is routed to it. */
export type OnlineNodeState = 'online' | 'draining';

/** One connected node as the router (M24-6) sees it. */
export interface OnlineNode {
  readonly nodeId: string;
  /** Portal name. */
  readonly name: string;
  readonly operatorId: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  /** `node.hello.engines`: what the node's own `welcome` would announce. */
  readonly engines: readonly EngineDescriptor[];
  /** `node.hello.limits`. */
  readonly limits: Limits;
  /** Node-wide session cap (`node.hello.maxSessions`, updated by `node.status`). */
  readonly maxSessions: number;
  /** Effective pool membership: the node's own switch and the portal setting. */
  readonly pool: boolean;
  /** Sessions donated to the pool (portal setting). */
  readonly poolShare: number;
  readonly state: OnlineNodeState;
  readonly drainReason: NodeDrainReason | null;
  /** Null until the first `node.status`. */
  readonly status: NodeStatusSnapshot | null;
  readonly connectedAt: number;
  /** Last WebSocket pong round trip measured by the hub (ms); null until the first pong. */
  readonly rttMs: number | null;
  /** The relay endpoint: `link.open(deliver, peer, route)`. */
  readonly link: HubNodeLink;
}

export type NodeRegistryEvent =
  | { type: 'online'; node: OnlineNode }
  | { type: 'offline'; node: OnlineNode }
  | { type: 'draining'; node: OnlineNode }
  | { type: 'status'; node: OnlineNode };

export type NodeRegistryListener = (event: NodeRegistryEvent) => void;

/** Everything about a node known at `node.welcome` time. */
export type NodeRegistration = Omit<OnlineNode, 'state' | 'drainReason' | 'status' | 'rttMs'>;

type Entry = { -readonly [K in keyof OnlineNode]: OnlineNode[K] };

/**
 * The online nodes of the hub (ADR-020 relay layering §6), fed by `LinkServer`: registered at
 * `node.welcome`, updated by `node.status`, pongs and `node.drain`, removed when the link closes.
 * One entry per `nodeId`; when a newer link replaces an older one the old entry goes `offline`
 * and the new one comes `online`, synchronously. Reads return live, read-only views.
 */
export class NodeRegistry {
  private readonly nodes = new Map<string, Entry>();
  private readonly listeners = new Set<NodeRegistryListener>();

  constructor(private readonly log?: PoolLogger) {}

  /** The node's entry while it is connected (online or draining). */
  get(nodeId: string): OnlineNode | undefined {
    return this.nodes.get(nodeId);
  }

  /** Every connected node, online and draining, in connection order. */
  online(): readonly OnlineNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Nodes the pool scheduler may consider: online (not draining), in the pool, with a positive
   * `poolShare`. Scoring (free share, RTT, failures, sticky) is the router's job (M24-6).
   */
  poolCandidates(): readonly OnlineNode[] {
    return [...this.nodes.values()].filter(
      (n) => n.state === 'online' && n.pool && n.poolShare > 0,
    );
  }

  get size(): number {
    return this.nodes.size;
  }

  /** Subscribes to changes; returns the unsubscribe function. */
  onChange(listener: NodeRegistryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------- LinkServer side

  /** A node completed its handshake (replacing any previous entry for the same id). */
  register(reg: NodeRegistration): OnlineNode {
    const entry: Entry = {
      ...reg,
      engines: reg.engines.map((e) => ({ ...e, defaults: { ...e.defaults } })),
      limits: { ...reg.limits },
      state: 'online',
      drainReason: null,
      status: null,
      rttMs: null,
    };
    this.nodes.set(reg.nodeId, entry);
    this.emit({ type: 'online', node: entry });
    return entry;
  }

  /** Removes the node, unless `link` is no longer its current link (replaced meanwhile). */
  unregister(nodeId: string, link: HubNodeLink): boolean {
    const entry = this.nodes.get(nodeId);
    if (!entry || entry.link !== link) return false;
    this.nodes.delete(nodeId);
    this.emit({ type: 'offline', node: entry });
    return true;
  }

  updateStatus(nodeId: string, link: HubNodeLink, msg: NodeStatusMessage, at: number): void {
    const entry = this.current(nodeId, link);
    if (!entry) return;
    entry.status = {
      sessions: msg.sessions,
      maxSessions: msg.maxSessions,
      load1: msg.load1,
      engines: msg.engines.map((e) => ({ ...e })),
      at,
    };
    entry.maxSessions = msg.maxSessions;
    this.emit({ type: 'status', node: entry });
  }

  setDraining(nodeId: string, link: HubNodeLink, reason: NodeDrainReason): void {
    const entry = this.current(nodeId, link);
    if (!entry || entry.state === 'draining') return;
    entry.state = 'draining';
    entry.drainReason = reason;
    this.emit({ type: 'draining', node: entry });
  }

  setRtt(nodeId: string, link: HubNodeLink, rttMs: number): void {
    const entry = this.current(nodeId, link);
    if (entry) entry.rttMs = Math.max(0, Math.round(rttMs));
  }

  // ----------------------------------------------------------------------------------

  private current(nodeId: string, link: HubNodeLink): Entry | undefined {
    const entry = this.nodes.get(nodeId);
    return entry && entry.link === link ? entry : undefined;
  }

  private emit(event: NodeRegistryEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch (err) {
        this.log?.warn(
          { node: event.node.nodeId, event: event.type, err: (err as Error).message },
          'node registry listener failed',
        );
      }
    }
  }
}
