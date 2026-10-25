// Response shapes of the hub's portal API (apps/server/src/hub/portal/routes.ts is the source of
// truth). Only the fields the SPA reads are listed.

export type NodeStatus = 'online' | 'draining' | 'offline';
export type NodeState = 'normal' | 'suspect' | 'disabled';
export type TokenStatus = 'active' | 'revoked' | 'expired';
export type TokenKind = 'player' | 'pool';
export type TokenTier = 'small' | 'standard' | 'full';

export interface Me {
  operator: {
    id: string;
    lichessId: string;
    username: string;
    admin: boolean;
    createdAt: number;
    lastLoginAt: number | null;
  };
  sessionExpiresAt: number;
  limits: { maxNodes: number; maxTokens: number; poolTokens: number };
}

export interface NodeView {
  id: string;
  name: string;
  pool: boolean;
  poolShare: number;
  state: NodeState;
  suspectCount: number;
  createdAt: number;
  lastSeenAt: number | null;
  lastVersion: string | null;
  revokedAt: number | null;
  rotationOverlapUntil: number | null;
  status: NodeStatus;
  live: {
    version: string;
    platform: string;
    arch: string;
    engines: string[];
    maxSessions: number;
    sessions: number | null;
    load1: number | null;
    clients: number;
    rttMs: number | null;
    connectedAt: number;
    inPool: boolean;
  } | null;
}

export interface AdminNodeView extends NodeView {
  operatorId: string;
  operatorUsername: string | null;
}

export interface TokenView {
  id: string;
  kind: TokenKind;
  label: string;
  nodeIds: string[];
  poolFallback: boolean;
  tier: TokenTier;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  status: TokenStatus;
  connections: number;
}

export interface UsageTotals {
  sessions: number;
  searches: number;
  engineMs: number;
}

export interface UsageDay extends UsageTotals {
  day: string;
}

export interface UsageReport {
  sinceDay: string;
  days: UsageDay[];
  total: UsageTotals;
}

export interface AdminOperator {
  id: string;
  lichessId: string;
  username: string;
  admin: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  disabledAt: number | null;
  nodes: number;
  liveTokens: number;
}

export interface NodeCreateInput {
  name: string;
  pool?: boolean;
  poolShare?: number;
}

export interface NodePatchInput {
  name?: string;
  pool?: boolean;
  poolShare?: number;
}

export interface TokenCreateInput {
  kind: TokenKind;
  label?: string;
  nodeIds?: string[];
  poolFallback?: boolean;
  tier?: TokenTier;
  expiresInDays?: number;
}

export interface TokenPatchInput {
  label?: string;
  nodeIds?: string[];
  poolFallback?: boolean;
  tier?: TokenTier;
  expiresInDays?: number;
  expiresAt?: number | null;
}
