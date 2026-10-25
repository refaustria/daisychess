import { vi } from 'vitest';
import type { AdminNodeView, AdminOperator, Me, NodeView, TokenView } from '../types';

export const ME: Me = {
  operator: { id: 'op1', lichessId: 'alice', username: 'Alice', admin: false, createdAt: 1, lastLoginAt: 2 },
  sessionExpiresAt: Date.UTC(2026, 11, 1),
  limits: { maxNodes: 10, maxTokens: 100, poolTokens: 20 },
};
export const ADMIN_ME: Me = { ...ME, operator: { ...ME.operator, admin: true } };

export function node(over: Partial<NodeView> = {}): NodeView {
  return {
    id: 'n1',
    name: 'garage',
    pool: false,
    poolShare: 0,
    state: 'normal',
    suspectCount: 0,
    createdAt: 1,
    lastSeenAt: Date.now() - 120_000,
    lastVersion: '1.2.3',
    revokedAt: null,
    rotationOverlapUntil: null,
    status: 'online',
    live: { version: '1.2.3', platform: 'linux', arch: 'x64', engines: ['stockfish'], maxSessions: 4, sessions: 1, load1: 0.5, clients: 1, rttMs: 12, connectedAt: 1, inPool: false },
    ...over,
  };
}

export function token(over: Partial<TokenView> = {}): TokenView {
  return {
    id: 'ABCD2345',
    kind: 'player',
    label: 'for bob',
    nodeIds: ['n1'],
    poolFallback: false,
    tier: 'standard',
    expiresAt: null,
    revokedAt: null,
    createdAt: 1,
    lastUsedAt: null,
    status: 'active',
    connections: 0,
    ...over,
  };
}

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call) => { status?: number; json?: unknown } | undefined;

/** A fake hub: routes by "METHOD /path"; unknown routes answer 404. Records every call. */
export function hubMock(routes: Record<string, Handler | unknown>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api\/portal/, '');
    const call: Call = {
      method,
      path,
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const r = routes[`${method} ${path}`];
    const isDescriptor = (v: unknown): v is { status?: number; json?: unknown } =>
      typeof v === 'object' && v !== null && ('json' in v || 'status' in v);
    const out =
      typeof r === 'function'
        ? (r as Handler)(call)
        : r === undefined
          ? { status: 404, json: { error: 'not_found', message: 'not found' } }
          : isDescriptor(r)
            ? r
            : { json: r };
    const status = out?.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(out?.json ?? {}), { status, headers: { 'content-type': 'application/json' } });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

export const OPERATORS: AdminOperator[] = [
  { id: 'op1', lichessId: 'alice', username: 'Alice', admin: true, createdAt: 1, lastLoginAt: 2, disabledAt: null, nodes: 1, liveTokens: 1 },
  { id: 'op2', lichessId: 'bob', username: 'Bob', admin: false, createdAt: 1, lastLoginAt: null, disabledAt: null, nodes: 0, liveTokens: 0 },
];
export const ADMIN_NODES: AdminNodeView[] = [{ ...node(), operatorId: 'op1', operatorUsername: 'Alice' }];
