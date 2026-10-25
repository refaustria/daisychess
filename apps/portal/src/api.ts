import type {
  AdminNodeView,
  AdminOperator,
  Me,
  NodeCreateInput,
  NodePatchInput,
  NodeState,
  NodeView,
  TokenCreateInput,
  TokenPatchInput,
  TokenView,
  UsageReport,
} from './types';

/** Same-origin API of the hub (nginx proxies `/api/portal/` to it). */
export const API_BASE = '/api/portal';
/** The hub refuses state-changing requests without this header (simple CSRF rule). */
export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'daisychess-portal';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const FRIENDLY: Record<string, string> = {
  lichess_rejected: 'lichess did not accept the login. Please try again.',
  lichess_unavailable: 'lichess could not be reached from the hub. Try again in a minute.',
  operator_disabled: 'This account is disabled on this hub. Contact the administrator.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  limit_reached: '',
  unauthorized: 'Your session has ended. Please log in again.',
};

/** User-facing text of an error (never contains a secret: the hub never echoes one). */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const friendly = FRIENDLY[err.code];
    return friendly ? friendly : err.message || `Request failed (HTTP ${err.status})`;
  }
  return 'Could not reach the hub. Check your connection and try again.';
}

/** Created/rotated credentials: returned once by the hub and kept in memory only. */
export interface CreatedNode {
  node: NodeView;
  nodeToken: string;
}
export interface CreatedToken {
  token: TokenView;
  playerToken: string;
  setupLink: string | null;
}

export interface PortalApi {
  login(lichessToken: string): Promise<Me>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  listNodes(): Promise<NodeView[]>;
  createNode(input: NodeCreateInput): Promise<CreatedNode>;
  updateNode(id: string, patch: NodePatchInput): Promise<NodeView>;
  rotateNode(id: string): Promise<CreatedNode>;
  revokeNode(id: string): Promise<NodeView>;
  deleteNode(id: string): Promise<void>;
  nodeUsage(id: string): Promise<UsageReport>;
  listTokens(): Promise<TokenView[]>;
  createToken(input: TokenCreateInput): Promise<CreatedToken>;
  updateToken(id: string, patch: TokenPatchInput): Promise<TokenView>;
  revokeToken(id: string): Promise<{ token: TokenView; closedConnections: number }>;
  tokenUsage(id: string): Promise<UsageReport>;
  adminOperators(): Promise<AdminOperator[]>;
  adminNodes(): Promise<AdminNodeView[]>;
  adminDisableOperator(id: string, disabled: boolean): Promise<void>;
  adminNodeState(id: string, change: { state?: NodeState; poolBanned?: boolean }): Promise<NodeView>;
}

export interface ApiOptions {
  fetch?: typeof fetch;
  /** Called on every 401 (session ended): the app returns to the login screen. */
  onUnauthorized?: () => void;
}

export function createApi(opts: ApiOptions = {}): PortalApi {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (method !== 'GET') headers[CSRF_HEADER] = CSRF_VALUE;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(`${API_BASE}${path}`, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new ApiError(0, 'network', 'Could not reach the hub. Check your connection and try again.');
    }
    if (res.status === 204) return undefined as T;
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON (proxy error page) */
    }
    if (!res.ok) {
      const o = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
      const code = typeof o.error === 'string' ? o.error : `http_${res.status}`;
      const message = typeof o.message === 'string' ? o.message : '';
      if (res.status === 401 && path !== '/login') opts.onUnauthorized?.();
      throw new ApiError(res.status, code, message);
    }
    return json as T;
  }

  const id = encodeURIComponent;
  return {
    login: (lichessToken) => call('POST', '/login', { lichessToken }),
    logout: () => call('POST', '/logout'),
    me: () => call('GET', '/me'),
    listNodes: async () => (await call<{ nodes: NodeView[] }>('GET', '/nodes')).nodes,
    createNode: (input) => call('POST', '/nodes', input),
    updateNode: async (nid, patch) => (await call<{ node: NodeView }>('PATCH', `/nodes/${id(nid)}`, patch)).node,
    rotateNode: (nid) => call('POST', `/nodes/${id(nid)}/rotate`, {}),
    revokeNode: async (nid) => (await call<{ node: NodeView }>('POST', `/nodes/${id(nid)}/revoke`, {})).node,
    deleteNode: (nid) => call('DELETE', `/nodes/${id(nid)}`),
    nodeUsage: (nid) => call('GET', `/nodes/${id(nid)}/usage`),
    listTokens: async () => (await call<{ tokens: TokenView[] }>('GET', '/tokens')).tokens,
    createToken: (input) => call('POST', '/tokens', input),
    updateToken: async (tid, patch) => (await call<{ token: TokenView }>('PATCH', `/tokens/${id(tid)}`, patch)).token,
    revokeToken: (tid) => call('POST', `/tokens/${id(tid)}/revoke`, {}),
    tokenUsage: (tid) => call('GET', `/tokens/${id(tid)}/usage`),
    adminOperators: async () => (await call<{ operators: AdminOperator[] }>('GET', '/admin/operators')).operators,
    adminNodes: async () => (await call<{ nodes: AdminNodeView[] }>('GET', '/admin/nodes')).nodes,
    adminDisableOperator: async (oid, disabled) => {
      await call('POST', `/admin/operators/${id(oid)}/disable`, { disabled });
    },
    adminNodeState: async (nid, change) => (await call<{ node: NodeView }>('POST', `/admin/nodes/${id(nid)}/state`, change)).node,
  };
}
