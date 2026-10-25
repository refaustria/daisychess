/**
 * Operator portal API (ADR-020 §2, §5, M24-9) under `/api/portal/*`, registered only with
 * ROLE=hub. JSON in, JSON out, same origin as the SPA (`/portal/`), no HTML.
 *
 * Authentication: `POST /login` exchanges a lichess access token (from the SPA's PKCE flow) for
 * a `__Host-dc_portal` session cookie; the lichess token is used for one `GET /api/account`
 * through the loopback egress proxy and then dropped. Every state-changing request needs the
 * CSRF header and a same-origin `Origin` (`auth.ts`). Operators see only their own nodes and
 * tokens (another operator's id answers 404 exactly like a missing one); administrators
 * (`HUB_ADMIN_LICHESS`) additionally get `/admin/*`.
 *
 * Secrets: a `dcn_`/`dc1_` token appears exactly once, in the response that created (or
 * rotated) it; list/detail responses carry ids and metadata only. Nothing here logs a token, a
 * cookie, or a client address; rate-limit state is in memory only.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TOKEN_PATTERNS, TOKEN_TIERS, type LinkCloseReason } from '@daisychess/engine-core';
import type { PortalSettings } from '../../config.js';
import type { PoolLogger } from '../../engines/EnginePool.js';
import type { RateLimit } from '../../sessions/rateLimit.js';
import { resolveClientIp, type TrustedProxies } from '../../ws/clientIp.js';
import type { OriginPolicy } from '../../ws/origin.js';
import type { NodeRegistry } from '../NodeRegistry.js';
import {
  NODE_STATES,
  utcDay,
  utcDayStart,
  type HubStore,
  type NodeRecord,
  type OperatorRecord,
  type TokenRecord,
  type UsageRow,
} from '../store/HubStore.js';
import {
  HubInputError,
  LOCAL_NODE_ID,
  MAX_LABEL_LENGTH,
  MAX_NODE_NAME_LENGTH,
  MAX_POOL_SHARE,
  MAX_TOKEN_NODE_IDS,
  type HubTokenService,
} from '../tokens.js';
import {
  CSRF_HEADER,
  CSRF_VALUE,
  PORTAL_SESSION_TTL_MS,
  WindowLimiter,
  hashSessionId,
  newSessionId,
  portalOriginAllowed,
  sessionCookie,
  sessionIdFromCookies,
} from './auth.js';
import { LichessError, type LichessAccountFetcher } from './lichess.js';

export const PORTAL_PREFIX = '/api/portal';
/** Usage views cover this many UTC days, today included. */
export const USAGE_DAYS = 30;
/** Request bodies are small; anything bigger is refused (413). */
const BODY_LIMIT = 8 * 1024;
const DAY_MS = 86_400_000;

/** `POST /login` per client address. */
export const DEFAULT_LOGIN_RATE_LIMIT: RateLimit = Object.freeze({ max: 10, windowMs: 60_000 });
/** Every other portal request per client address, and separately per session. */
export const DEFAULT_API_RATE_LIMIT: RateLimit = Object.freeze({ max: 120, windowMs: 60_000 });

/** Open player connections by token (the `/ws` server satisfies it). */
export interface PortalConnections {
  /** Closes every open connection of `tokenId`; returns how many. */
  closeTokenConnections(tokenId: string): number;
  /** Open connections of `tokenId`. */
  tokenConnections(tokenId: string): number;
}

/** Node links (`LinkServer` satisfies it). */
export interface PortalLinks {
  closeNode(nodeId: string, reason: LinkCloseReason, message?: string): boolean;
  /** Ends the node's shared (pool) player connections (M24-12); private ones stay. */
  evictShared(nodeId: string, message: string): number;
}

export interface PortalOptions {
  store: HubStore;
  tokens: HubTokenService;
  registry: NodeRegistry;
  links: PortalLinks;
  connections: PortalConnections;
  settings: PortalSettings;
  /** `ALLOWED_ORIGINS` (an explicit list also names valid portal origins). */
  allowedOrigins: OriginPolicy;
  trustedProxies: TrustedProxies;
  fetchAccount: LichessAccountFetcher;
  logger: PoolLogger;
  now?: () => number;
  random?: (size: number) => Uint8Array;
  loginRateLimit?: RateLimit;
  apiRateLimit?: RateLimit;
}

type PortalAuth = 'none' | 'operator' | 'admin';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Portal routes: who may call it (default `operator`). */
    portalAuth?: PortalAuth;
  }
}

interface PortalContext {
  operator: OperatorRecord;
  admin: boolean;
  sessionHash: string;
  sessionExpiresAt: number;
}

// ------------------------------------------------------------------------------- body schemas

const Id = z.string().regex(TOKEN_PATTERNS.id);
const NodeIdRef = z.string().min(1).max(16);

const LoginBody = z
  .object({
    lichessToken: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[\x21-\x7e]+$/),
  })
  .strict();

const NodeCreateBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_NODE_NAME_LENGTH * 4),
    pool: z.boolean().optional(),
    poolShare: z.number().int().min(0).max(MAX_POOL_SHARE).optional(),
  })
  .strict();

const NodePatchBody = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_NODE_NAME_LENGTH * 4)
      .optional(),
    pool: z.boolean().optional(),
    poolShare: z.number().int().min(0).max(MAX_POOL_SHARE).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');

const Expiry = z
  .object({
    /** Absolute ms since the epoch; null = never. */
    expiresAt: z.number().int().nullable().optional(),
    /** Relative alternative to `expiresAt`. */
    expiresInDays: z.number().int().min(1).max(3_650).optional(),
  })
  .strict();

const TokenCreateBody = z
  .object({
    kind: z.enum(['player', 'pool']).default('player'),
    label: z
      .string()
      .max(MAX_LABEL_LENGTH * 4)
      .optional(),
    nodeIds: z.array(NodeIdRef).max(MAX_TOKEN_NODE_IDS).optional(),
    poolFallback: z.boolean().optional(),
    tier: z.enum(TOKEN_TIERS).optional(),
    ...Expiry.shape,
  })
  .strict()
  .refine((b) => b.expiresAt === undefined || b.expiresInDays === undefined, {
    message: 'give expiresAt or expiresInDays, not both',
  });

const TokenPatchBody = z
  .object({
    label: z
      .string()
      .max(MAX_LABEL_LENGTH * 4)
      .optional(),
    nodeIds: z.array(NodeIdRef).max(MAX_TOKEN_NODE_IDS).optional(),
    poolFallback: z.boolean().optional(),
    tier: z.enum(TOKEN_TIERS).optional(),
    ...Expiry.shape,
  })
  .strict()
  .refine((b) => b.expiresAt === undefined || b.expiresInDays === undefined, {
    message: 'give expiresAt or expiresInDays, not both',
  })
  .refine((b) => Object.keys(b).length > 0, 'nothing to change');

const DisableBody = z.object({ disabled: z.boolean() }).strict();
/** Administrator moderation: the node state and/or the permanent pool ban (M24-12). */
const NodeStateBody = z
  .object({ state: z.enum(NODE_STATES).optional(), poolBanned: z.boolean().optional() })
  .strict()
  .refine((b) => b.state !== undefined || b.poolBanned !== undefined, 'nothing to change');

// ------------------------------------------------------------------------------------ views

export interface NodeView {
  id: string;
  name: string;
  pool: boolean;
  poolShare: number;
  state: NodeRecord['state'];
  suspectCount: number;
  /** End of the current (or last) spot-check cool-down (M24-12). */
  suspectUntil: number | null;
  /**
   * Permanently out of the pool (M24-12, e.g. after repeated spot-check failures); its private
   * tokens keep working. Only the administrator can lift it — `pool` cannot override it.
   */
  poolBanned: boolean;
  /** `spot-check failures` or `hub administrator`; null when not banned. */
  poolBanReason: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  lastVersion: string | null;
  revokedAt: number | null;
  /** While a rotation overlap runs: when the previous credential stops working. */
  rotationOverlapUntil: number | null;
  status: 'online' | 'draining' | 'offline';
  /** Present while the node is connected. */
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
    /** Effective pool membership (node switch && portal setting && state normal). */
    inPool: boolean;
  } | null;
}

export interface TokenView {
  id: string;
  kind: TokenRecord['kind'];
  label: string;
  nodeIds: string[];
  poolFallback: boolean;
  tier: TokenRecord['tier'];
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  status: 'active' | 'revoked' | 'expired';
  /** Open player connections using it right now. */
  connections: number;
}

interface UsageTotals {
  sessions: number;
  searches: number;
  engineMs: number;
}

/**
 * Registers the portal routes under {@link PORTAL_PREFIX} on `app` (an encapsulated plugin: the
 * hooks and the error handler apply to these routes only).
 */
export async function registerPortalRoutes(
  app: FastifyInstance,
  opts: PortalOptions,
): Promise<void> {
  const { store, tokens, registry, links, connections, settings, logger } = opts;
  const now = opts.now ?? Date.now;
  const loginLimiter = new WindowLimiter(opts.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT);
  const ipLimiter = new WindowLimiter(opts.apiRateLimit ?? DEFAULT_API_RATE_LIMIT);
  const sessionLimiter = new WindowLimiter(opts.apiRateLimit ?? DEFAULT_API_RATE_LIMIT);
  const contexts = new WeakMap<FastifyRequest, PortalContext>();
  const adminIds = new Set(settings.adminLichessIds);
  const setupOrigin =
    settings.publicOrigin ??
    (Array.isArray(opts.allowedOrigins) ? (opts.allowedOrigins[0] ?? null) : null);

  const isAdmin = (op: OperatorRecord): boolean =>
    adminIds.has(op.lichessId) || adminIds.has(op.username.toLowerCase());

  /** Keeps the store's admin flag (used by token validation for node `local`) in line with config. */
  const syncAdmin = (op: OperatorRecord): boolean => {
    const admin = isAdmin(op);
    if (op.admin !== admin) {
      store.setOperatorAdmin(op.id, admin);
      op.admin = admin;
    }
    return admin;
  };

  const ctxOf = (req: FastifyRequest): PortalContext => {
    const ctx = contexts.get(req);
    // The onRequest hook guarantees a context on every authenticated route.
    if (!ctx) throw new Error('portal: request without session context');
    return ctx;
  };

  // ---------------------------------------------------------------------------- views

  const nodeView = (rec: NodeRecord, t: number): NodeView => {
    const live = registry.get(rec.id);
    return {
      id: rec.id,
      name: rec.name,
      pool: rec.pool,
      poolShare: rec.poolShare,
      state: rec.state,
      suspectCount: rec.suspectCount,
      suspectUntil: rec.suspectUntil,
      poolBanned: rec.poolBannedAt !== null,
      poolBanReason: rec.poolBanReason,
      createdAt: rec.createdAt,
      lastSeenAt: rec.lastSeenAt,
      lastVersion: live?.version ?? rec.lastVersion,
      revokedAt: rec.revokedAt,
      rotationOverlapUntil:
        rec.revokedAt === null && rec.prevExpiresAt !== null && rec.prevExpiresAt > t
          ? rec.prevExpiresAt
          : null,
      status: live ? live.state : 'offline',
      live: live
        ? {
            version: live.version,
            platform: live.platform,
            arch: live.arch,
            engines: live.engines.map((e) => e.id),
            maxSessions: live.maxSessions,
            sessions: live.status?.sessions ?? null,
            load1: live.status?.load1 ?? null,
            clients: live.link.clients,
            rttMs: live.rttMs,
            connectedAt: live.connectedAt,
            inPool: live.pool,
          }
        : null,
    };
  };

  const tokenView = (rec: TokenRecord, t: number): TokenView => ({
    id: rec.id,
    kind: rec.kind,
    label: rec.label,
    nodeIds: [...rec.nodeIds],
    poolFallback: rec.poolFallback,
    tier: rec.tier,
    expiresAt: rec.expiresAt,
    revokedAt: rec.revokedAt,
    createdAt: rec.createdAt,
    lastUsedAt: rec.lastUsedAt,
    status:
      rec.revokedAt !== null
        ? 'revoked'
        : rec.expiresAt !== null && rec.expiresAt <= t
          ? 'expired'
          : 'active',
    connections: rec.revokedAt === null ? connections.tokenConnections(rec.id) : 0,
  });

  const meView = (ctx: PortalContext) => ({
    operator: {
      id: ctx.operator.id,
      lichessId: ctx.operator.lichessId,
      username: ctx.operator.username,
      admin: ctx.admin,
      createdAt: ctx.operator.createdAt,
      lastLoginAt: ctx.operator.lastLoginAt,
    },
    sessionExpiresAt: ctx.sessionExpiresAt,
    limits: {
      maxNodes: settings.maxNodes,
      maxTokens: settings.maxTokens,
      poolTokens: settings.poolTokensPerOperator,
    },
  });

  const usageSince = (t: number): string => utcDay(utcDayStart(t) - (USAGE_DAYS - 1) * DAY_MS);

  const byDay = (rows: readonly UsageRow[]): ({ day: string } & UsageTotals)[] => {
    const days = new Map<string, UsageTotals>();
    for (const r of rows) add(days, r.day, r);
    return [...days].map(([day, u]) => ({ day, ...u }));
  };

  // ---------------------------------------------------------------------------- plugin

  await app.register(
    async (p) => {
      p.addHook('onRequest', async (req, reply) => {
        const t = now();
        reply.header('cache-control', 'no-store');
        const auth: PortalAuth = req.routeOptions.config.portalAuth ?? 'operator';
        const ip = resolveClientIp(
          req.raw.socket.remoteAddress,
          req.headers['x-real-ip'],
          opts.trustedProxies,
        );
        const limiter = auth === 'none' ? loginLimiter : ipLimiter;
        if (!limiter.allow(ip, t)) return tooMany(reply, limiter.retryAfterMs(ip, t));
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const origin = req.headers.origin;
          if (
            req.headers[CSRF_HEADER] !== CSRF_VALUE ||
            !portalOriginAllowed(
              typeof origin === 'string' ? origin : undefined,
              req.headers.host,
              settings.publicOrigin,
              opts.allowedOrigins,
            )
          ) {
            return reply
              .code(403)
              .send({ error: 'csrf', message: 'missing X-Requested-With or cross-origin request' });
          }
        }
        if (auth === 'none') return;
        const sid = sessionIdFromCookies(req.headers.cookie);
        const sessionHash = sid ? hashSessionId(sid) : null;
        const session = sessionHash ? store.getPortalSession(sessionHash, t) : undefined;
        const operator = session ? store.getOperator(session.operatorId) : undefined;
        if (!session || !operator || operator.disabledAt !== null || operator.deletedAt !== null) {
          if (session) store.deletePortalSession(session.idHash);
          return reply.code(401).send({ error: 'unauthorized', message: 'log in first' });
        }
        if (!sessionLimiter.allow(session.idHash, t)) {
          return tooMany(reply, sessionLimiter.retryAfterMs(session.idHash, t));
        }
        const admin = syncAdmin(operator);
        if (auth === 'admin' && !admin) {
          return reply.code(403).send({ error: 'forbidden', message: 'administrators only' });
        }
        contexts.set(req, {
          operator,
          admin,
          sessionHash: session.idHash,
          sessionExpiresAt: session.expiresAt,
        });
      });

      p.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
        const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
        if (status < 500) {
          const error =
            status === 413 ? 'too_large' : status === 415 ? 'unsupported_media_type' : 'invalid';
          return reply.code(status).send({ error, message: 'invalid request' });
        }
        logger.error(
          { component: 'portal', route: req.routeOptions.url, err: err.message },
          'portal route failed',
        );
        return reply.code(500).send({ error: 'internal', message: 'internal error' });
      });

      const route = { bodyLimit: BODY_LIMIT };

      // ---------------------------------------------------------------- session

      p.post('/login', { ...route, config: { portalAuth: 'none' } }, async (req, reply) => {
        const body = LoginBody.safeParse(req.body);
        if (!body.success) return invalid(reply, 'lichessToken is required');
        let account;
        try {
          account = await opts.fetchAccount(body.data.lichessToken);
        } catch (err) {
          if (err instanceof LichessError && err.kind === 'rejected') {
            logger.info({ component: 'portal' }, 'portal login refused by lichess');
            return reply
              .code(401)
              .send({ error: 'lichess_rejected', message: 'lichess did not accept the token' });
          }
          logger.warn(
            { component: 'portal', err: err instanceof LichessError ? err.message : 'error' },
            'portal login: lichess unavailable',
          );
          return reply
            .code(502)
            .send({ error: 'lichess_unavailable', message: 'lichess could not be reached' });
        }
        const t = now();
        const operator = tokens.upsertOperator(
          { lichessId: account.id, username: account.username },
          t,
        );
        if (operator.disabledAt !== null || operator.deletedAt !== null) {
          logger.info(
            { component: 'portal', operator: operator.id },
            'portal login of a disabled operator',
          );
          return reply
            .code(403)
            .send({ error: 'operator_disabled', message: 'this account is disabled on this hub' });
        }
        const admin = syncAdmin(operator);
        const previous = sessionIdFromCookies(req.headers.cookie);
        if (previous) store.deletePortalSession(hashSessionId(previous));
        const id = newSessionId(opts.random);
        const sessionHash = hashSessionId(id);
        const expiresAt = t + PORTAL_SESSION_TTL_MS;
        store.insertPortalSession({
          idHash: sessionHash,
          operatorId: operator.id,
          createdAt: t,
          expiresAt,
        });
        reply.header('set-cookie', sessionCookie(id, PORTAL_SESSION_TTL_MS));
        logger.info({ component: 'portal', operator: operator.id, admin }, 'portal login');
        return meView({ operator, admin, sessionHash, sessionExpiresAt: expiresAt });
      });

      p.post('/logout', route, async (req, reply) => {
        const ctx = ctxOf(req);
        store.deletePortalSession(ctx.sessionHash);
        reply.header('set-cookie', sessionCookie('', 0));
        logger.info({ component: 'portal', operator: ctx.operator.id }, 'portal logout');
        return reply.code(204).send();
      });

      p.get('/me', async (req) => meView(ctxOf(req)));

      // ---------------------------------------------------------------- nodes

      p.get('/nodes', async (req) => {
        const t = now();
        const nodes = store.listNodes({ operatorId: ctxOf(req).operator.id });
        return { nodes: nodes.map((n) => nodeView(n, t)) };
      });

      p.post('/nodes', route, async (req, reply) => {
        const ctx = ctxOf(req);
        const body = NodeCreateBody.safeParse(req.body);
        if (!body.success) return invalid(reply, issues(body.error));
        if (store.countActiveNodes(ctx.operator.id) >= settings.maxNodes) {
          return limit(reply, `at most ${settings.maxNodes} nodes per operator`);
        }
        return handleInput(reply, () => {
          const t = now();
          const minted = tokens.mintNode(
            {
              operatorId: ctx.operator.id,
              name: body.data.name,
              ...stripUndefined({ pool: body.data.pool, poolShare: body.data.poolShare }),
            },
            t,
          );
          logger.info(
            { component: 'portal', operator: ctx.operator.id, node: minted.record.id },
            'node created',
          );
          return reply
            .code(201)
            .send({ node: nodeView(minted.record, t), nodeToken: minted.token });
        });
      });

      p.get('/nodes/:id', async (req, reply) => {
        const node = ownNode(req);
        return node ? { node: nodeView(node, now()) } : notFound(reply);
      });

      p.patch('/nodes/:id', route, async (req, reply) => {
        const ctx = ctxOf(req);
        const id = idParam(req);
        if (!id) return notFound(reply);
        const body = NodePatchBody.safeParse(req.body);
        if (!body.success) return invalid(reply, issues(body.error));
        return handleInput(reply, () => {
          const node = tokens.updateNode(id, stripUndefined(body.data), {
            operatorId: ctx.operator.id,
          });
          if (!node) return notFound(reply);
          registry.applySettings(node.id, node);
          logger.info({ component: 'portal', operator: ctx.operator.id, node: id }, 'node updated');
          return { node: nodeView(node, now()) };
        });
      });

      p.post('/nodes/:id/rotate', route, async (req, reply) => {
        const ctx = ctxOf(req);
        const id = idParam(req);
        if (!id) return notFound(reply);
        return handleInput(reply, () => {
          const t = now();
          const rotated = tokens.rotateNodeCredential(id, t, { operatorId: ctx.operator.id });
          if (!rotated) return notFound(reply);
          logger.info(
            { component: 'portal', operator: ctx.operator.id, node: id },
            'node credential rotated',
          );
          return { node: nodeView(rotated.record, t), nodeToken: rotated.token };
        });
      });

      p.post('/nodes/:id/revoke', route, async (req, reply) => {
        const ctx = ctxOf(req);
        const id = idParam(req);
        if (!id) return notFound(reply);
        const t = now();
        if (!tokens.revokeNode(id, t, { operatorId: ctx.operator.id })) return notFound(reply);
        const closed = links.closeNode(id, 'revoked', 'node revoked by its operator');
        logger.info(
          { component: 'portal', operator: ctx.operator.id, node: id, closed },
          'node revoked',
        );
        return { node: nodeView(store.getNode(id) as NodeRecord, t), linkClosed: closed };
      });

      p.delete('/nodes/:id', async (req, reply) => {
        const ctx = ctxOf(req);
        const node = ownNode(req);
        if (!node) return notFound(reply);
        links.closeNode(node.id, 'revoked', 'node deleted by its operator');
        tokens.deleteNode(node.id, { operatorId: ctx.operator.id });
        logger.info(
          { component: 'portal', operator: ctx.operator.id, nodeId: node.id },
          'node deleted',
        );
        return reply.code(204).send();
      });

      p.get('/nodes/:id/usage', async (req, reply) => {
        const node = ownNode(req);
        if (!node) return notFound(reply);
        const sinceDay = usageSince(now());
        const rows = store.listUsage({ sinceDay, nodeIds: [node.id] });
        return { nodeId: node.id, sinceDay, days: byDay(rows), total: sum(rows) };
      });

      // ---------------------------------------------------------------- tokens

      p.get('/tokens', async (req) => {
        const t = now();
        const list = store.listTokens({ operatorId: ctxOf(req).operator.id });
        return { tokens: list.map((x) => tokenView(x, t)) };
      });

      p.post('/tokens', route, async (req, reply) => {
        const ctx = ctxOf(req);
        const body = TokenCreateBody.safeParse(req.body);
        if (!body.success) return invalid(reply, issues(body.error));
        const t = now();
        const b = body.data;
        if (store.countAllLiveTokens(ctx.operator.id, t) >= settings.maxTokens) {
          return limit(reply, `at most ${settings.maxTokens} live tokens per operator`);
        }
        if (
          b.kind === 'pool' &&
          store.countLiveTokens(ctx.operator.id, 'pool', t) >= settings.poolTokensPerOperator
        ) {
          return limit(
            reply,
            `at most ${settings.poolTokensPerOperator} live pool tokens per operator`,
          );
        }
        return handleInput(reply, () => {
          const minted = tokens.mintToken(
            {
              operatorId: ctx.operator.id,
              kind: b.kind,
              ...stripUndefined({
                label: b.label,
                nodeIds: b.nodeIds,
                poolFallback: b.poolFallback,
                tier: b.tier,
              }),
              ...expiryOf(b, t),
            },
            t,
          );
          logger.info(
            {
              component: 'portal',
              operator: ctx.operator.id,
              tokenId: minted.record.id,
              kind: b.kind,
            },
            'token created',
          );
          return reply.code(201).send({
            token: tokenView(minted.record, t),
            playerToken: minted.token,
            setupLink: setupOrigin
              ? `${setupOrigin}/#setup-token=${encodeURIComponent(minted.token)}`
              : null,
          });
        });
      });

      p.get('/tokens/:id', async (req, reply) => {
        const token = ownToken(req);
        return token ? { token: tokenView(token, now()) } : notFound(reply);
      });

      p.patch('/tokens/:id', route, async (req, reply) => {
        const ctx = ctxOf(req);
        const id = idParam(req);
        if (!id) return notFound(reply);
        const body = TokenPatchBody.safeParse(req.body);
        if (!body.success) return invalid(reply, issues(body.error));
        const t = now();
        const b = body.data;
        return handleInput(reply, () => {
          const token = tokens.updateToken(
            id,
            {
              ...stripUndefined({
                label: b.label,
                nodeIds: b.nodeIds,
                poolFallback: b.poolFallback,
                tier: b.tier,
              }),
              ...expiryOf(b, t),
            },
            t,
            { operatorId: ctx.operator.id },
          );
          if (!token) return notFound(reply);
          logger.info(
            { component: 'portal', operator: ctx.operator.id, tokenId: id },
            'token updated',
          );
          return { token: tokenView(token, t) };
        });
      });

      p.post('/tokens/:id/revoke', route, async (req, reply) => {
        const ctx = ctxOf(req);
        const id = idParam(req);
        if (!id) return notFound(reply);
        const t = now();
        if (!tokens.revokeToken(id, t, { operatorId: ctx.operator.id })) return notFound(reply);
        const closed = connections.closeTokenConnections(id);
        logger.info(
          { component: 'portal', operator: ctx.operator.id, tokenId: id, closed },
          'token revoked',
        );
        return {
          token: tokenView(store.getToken(id) as TokenRecord, t),
          closedConnections: closed,
        };
      });

      p.get('/tokens/:id/usage', async (req, reply) => {
        const ctx = ctxOf(req);
        const token = ownToken(req);
        if (!token) return notFound(reply);
        const sinceDay = usageSince(now());
        const rows = store.listUsage({ sinceDay, tokenIds: [token.id] });
        // Pool nodes of other operators are not named: their use is summed up as `pool`.
        const own = new Set(store.listNodes({ operatorId: ctx.operator.id }).map((n) => n.id));
        if (ctx.admin) own.add(LOCAL_NODE_ID);
        const nodes = new Map<string, UsageTotals>();
        for (const r of rows) add(nodes, own.has(r.nodeId) ? r.nodeId : 'pool', r);
        return {
          tokenId: token.id,
          sinceDay,
          days: byDay(rows),
          byNode: [...nodes].map(([nodeId, u]) => ({ nodeId, ...u })),
          total: sum(rows),
        };
      });

      // ---------------------------------------------------------------- admin

      const admin = { config: { portalAuth: 'admin' as const } };

      p.get('/admin/operators', admin, async () => {
        const t = now();
        return {
          operators: store.listOperators().map((op) => ({
            id: op.id,
            lichessId: op.lichessId,
            username: op.username,
            admin: isAdmin(op),
            createdAt: op.createdAt,
            lastLoginAt: op.lastLoginAt,
            disabledAt: op.disabledAt,
            nodes: store.countActiveNodes(op.id),
            liveTokens: store.countAllLiveTokens(op.id, t),
          })),
        };
      });

      p.get('/admin/nodes', admin, async () => {
        const t = now();
        const names = new Map(store.listOperators().map((o) => [o.id, o.username]));
        return {
          nodes: store.listNodes().map((n) => ({
            ...nodeView(n, t),
            operatorId: n.operatorId,
            operatorUsername: names.get(n.operatorId) ?? null,
          })),
        };
      });

      p.post('/admin/operators/:id/disable', { ...route, ...admin }, async (req, reply) => {
        const ctx = ctxOf(req);
        const id = idParam(req);
        const target = id ? store.getOperator(id) : undefined;
        if (!target) return notFound(reply);
        const body = DisableBody.safeParse(req.body);
        if (!body.success) return invalid(reply, issues(body.error));
        if (body.data.disabled && target.id === ctx.operator.id) {
          return invalid(reply, 'you cannot disable yourself');
        }
        const t = now();
        store.setOperatorDisabled(target.id, body.data.disabled, t);
        let links_ = 0;
        let conns = 0;
        if (body.data.disabled) {
          store.deletePortalSessionsOf(target.id);
          for (const n of store.listNodes({ operatorId: target.id })) {
            if (links.closeNode(n.id, 'revoked', 'operator disabled by the hub administrator'))
              links_++;
          }
          for (const tok of store.listTokens({ operatorId: target.id })) {
            conns += connections.closeTokenConnections(tok.id);
          }
        }
        logger.info(
          {
            component: 'portal',
            admin: ctx.operator.id,
            operator: target.id,
            disabled: body.data.disabled,
            closedLinks: links_,
            closedConnections: conns,
          },
          'operator disabled state changed',
        );
        const updated = store.getOperator(target.id) as OperatorRecord;
        return {
          operator: {
            id: updated.id,
            username: updated.username,
            disabledAt: updated.disabledAt,
          },
          closedLinks: links_,
          closedConnections: conns,
        };
      });

      p.post('/admin/nodes/:id/state', { ...route, ...admin }, async (req, reply) => {
        const ctx = ctxOf(req);
        const id = idParam(req);
        if (!id) return notFound(reply);
        const body = NodeStateBody.safeParse(req.body);
        if (!body.success) return invalid(reply, issues(body.error));
        const t = now();
        let node = store.getNode(id);
        if (!node) return notFound(reply);
        if (body.data.poolBanned !== undefined) {
          node = tokens.setNodePoolBan(id, body.data.poolBanned, t) ?? node;
        }
        if (body.data.state !== undefined) {
          node = tokens.setNodeState(id, body.data.state, t) ?? node;
        }
        let linkClosed = false;
        let evicted = 0;
        if (node.state === 'disabled') {
          linkClosed = links.closeNode(id, 'revoked', 'node disabled by the hub administrator');
        } else {
          registry.applySettings(id, node);
          // Out of the pool: its pool players reconnect elsewhere; private ones stay.
          if (node.state === 'suspect' || node.poolBannedAt !== null) {
            evicted = links.evictShared(id, 'engine node removed from the pool');
          }
        }
        logger.info(
          {
            component: 'portal',
            admin: ctx.operator.id,
            nodeId: id,
            state: node.state,
            poolBanned: node.poolBannedAt !== null,
            evicted,
          },
          'node state changed',
        );
        return { node: nodeView(node, t), linkClosed };
      });

      // ---------------------------------------------------------------- helpers (scoped)

      function ownNode(req: FastifyRequest): NodeRecord | undefined {
        const id = idParam(req);
        return id ? store.getNode(id, { operatorId: ctxOf(req).operator.id }) : undefined;
      }

      function ownToken(req: FastifyRequest): TokenRecord | undefined {
        const id = idParam(req);
        return id ? store.getToken(id, { operatorId: ctxOf(req).operator.id }) : undefined;
      }
    },
    { prefix: PORTAL_PREFIX },
  );
}

// ------------------------------------------------------------------------------- helpers

function idParam(req: FastifyRequest): string | null {
  const raw = (req.params as { id?: unknown } | undefined)?.id;
  const parsed = Id.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'not_found', message: 'not found' });
}

function invalid(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({ error: 'invalid', message });
}

function limit(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(409).send({ error: 'limit_reached', message });
}

function tooMany(reply: FastifyReply, retryAfterMs: number): FastifyReply {
  return reply
    .code(429)
    .header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
    .send({ error: 'rate_limited', message: 'too many requests' });
}

/** Maps a {@link HubInputError} from the token service to 400 / 404. */
function handleInput<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HubInputError) {
      return err.code === 'not_found' ? notFound(reply) : invalid(reply, err.message);
    }
    throw err;
  }
}

/** First Zod issue as `path: message` (never echoes the input value). */
function issues(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'invalid request';
  const at = first.path.join('.');
  return at ? `${at}: ${first.message}` : first.message;
}

function expiryOf(
  b: { expiresAt?: number | null | undefined; expiresInDays?: number | undefined },
  t: number,
): { expiresAt?: number | null } {
  if (b.expiresInDays !== undefined) return { expiresAt: t + b.expiresInDays * DAY_MS };
  if (b.expiresAt !== undefined) return { expiresAt: b.expiresAt };
  return {};
}

/** Drops `undefined` values (exactOptionalPropertyTypes-friendly patches). */
function stripUndefined<T extends Record<string, unknown>>(
  o: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

function add(map: Map<string, UsageTotals>, key: string, r: UsageTotals): void {
  const u = map.get(key) ?? { sessions: 0, searches: 0, engineMs: 0 };
  u.sessions += r.sessions;
  u.searches += r.searches;
  u.engineMs += r.engineMs;
  map.set(key, u);
}

function sum(rows: readonly UsageTotals[]): UsageTotals {
  const total = { sessions: 0, searches: 0, engineMs: 0 };
  for (const r of rows) {
    total.sessions += r.sessions;
    total.searches += r.searches;
    total.engineMs += r.engineMs;
  }
  return total;
}
