import type {
  AnalysisDeniedReason,
  EngineDescriptor,
  HelloMessage,
  Limits,
  WelcomeNode,
} from '@daisychess/engine-core';
import type { AnalysisChannel } from './AnalysisChannel.js';
import type { Deliver, SessionPeer } from './ClientSessions.js';

/** Who is being routed: the resolved client address and the connection id (logs). */
export interface RoutePeer {
  ip: string;
  connId: number;
}

/**
 * Where one player connection's analysis runs (ADR-020 relay layering §2), decided once at
 * `hello`. `welcome` is composed from {@link limits}, {@link engines} and {@link node}; then
 * {@link open} is called exactly once to create the connection's channel.
 */
export interface AnalysisRoute {
  readonly limits: Limits;
  readonly engines: readonly EngineDescriptor[];
  /** `welcome.node` (hub only; absent on a standalone server). */
  readonly node?: WelcomeNode;
  open(deliver: Deliver, peer: SessionPeer): AnalysisChannel;
}

export type RouteResult =
  { ok: true; route: AnalysisRoute } | { ok: false; reason: AnalysisDeniedReason };

/**
 * Decides the route of a connection at `hello`: `LocalRouter` (standalone: access token → this
 * server's engines) or `HubRouter` (ROLE=hub: token → private node / pool / `local`). A denied
 * route gives the restricted welcome (rooms and review reads only) with
 * `welcome.analysisDenied`. `route` may answer synchronously (both built-in routers do), which
 * keeps the `hello` → `welcome` path free of an extra tick.
 */
export interface AnalysisRouter {
  /** `welcome.limits` of a restricted (denied) welcome. */
  readonly restrictedLimits: Limits;
  route(hello: HelloMessage, peer: RoutePeer): RouteResult | Promise<RouteResult>;
}

/**
 * Denial reasons that still prove a valid token (the node is offline or full, the budget is used
 * up): such a connection may write to the review store ("writes with any valid token", ADR-020
 * §1). `no_token`/`bad_token`/`expired`/`revoked` may not.
 */
export function deniedWithValidToken(reason: AnalysisDeniedReason): boolean {
  return reason === 'node_offline' || reason === 'no_capacity' || reason === 'budget_exhausted';
}
