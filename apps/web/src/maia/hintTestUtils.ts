/** Fake Maia server for the hint tests (structural {@link MaiaClient}; no sockets). */
import type { EngineDescriptor, EngineInfo, PolicyEntry } from '@daisychess/engine-core';
import type { CreateMaiaClient, MaiaClient } from './hints';

export const coded = (code: string, message = code): Error =>
  Object.assign(new Error(message), { name: 'RemoteEngineError', code });

const descriptor = (id: string, rating: number): EngineDescriptor => ({
  id,
  name: `Maia ${rating}`,
  enabled: true,
  defaults: { threads: 1, hash: 16 },
  style: 'human',
  rating,
  maxNodes: 1,
});

/** Answer of one query: a policy, an error to throw, or `undefined` (no policy info). */
export type FakeAnswer = PolicyEntry[] | Error | undefined;

export interface FakeMaiaServer {
  createClient: CreateMaiaClient;
  /** Queries as `<rating>:<fen>` in order. */
  queries: string[];
  /** `analyze.policyMoves` of each query (undefined when none), in query order. */
  policyMoves: (readonly string[] | undefined)[];
  /** Engine ids of every created client, in order. */
  created: string[];
  /** Engine ids of disposed clients. */
  disposed: string[];
  /** Max clients alive at the same time. */
  maxAlive: number;
}

export function fakeMaiaServer(
  answer: (
    rating: number,
    fen: string,
    attempt: number,
    policyMoves: readonly string[] | undefined,
  ) => FakeAnswer,
  opts: {
    load?: (engineId: string) => Error | undefined;
    engines?: (engineId: string) => EngineDescriptor[];
  } = {},
): FakeMaiaServer {
  const attempts = new Map<string, number>();
  let alive = 0;
  const server: FakeMaiaServer = {
    queries: [],
    policyMoves: [],
    created: [],
    disposed: [],
    maxAlive: 0,
    createClient: (engineId) => {
      const rating = Number(engineId.replace('maia-', ''));
      server.created.push(engineId);
      alive++;
      server.maxAlive = Math.max(server.maxAlive, alive);
      let loaded = false;
      let disposed = false;
      const client: MaiaClient = {
        get engines() {
          return loaded ? (opts.engines?.(engineId) ?? [descriptor(engineId, rating)]) : undefined;
        },
        load: async () => {
          const err = opts.load?.(engineId);
          if (err) throw err;
          loaded = true;
        },
        analyze: (fen, opts) => {
          server.queries.push(`${rating}:${fen}`);
          server.policyMoves.push(opts?.policyMoves);
          const k = `${rating}:${fen}`;
          const attempt = attempts.get(k) ?? 0;
          attempts.set(k, attempt + 1);
          const a = answer(rating, fen, attempt, opts?.policyMoves);
          async function* gen(): AsyncGenerator<EngineInfo> {
            await Promise.resolve();
            if (a instanceof Error) throw a;
            yield { depth: 1, multipv: 1, score: { cp: 10 }, pv: [] };
            if (a) yield { depth: 1, multipv: 1, score: { cp: 10 }, pv: [], policy: a };
          }
          return gen();
        },
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          alive--;
          server.disposed.push(engineId);
        },
      };
      return client;
    },
  };
  return server;
}

/** Sleep that resolves at once (records the requested delays). */
export function instantSleep(log: number[] = []): (ms: number) => Promise<void> {
  return (ms) => {
    log.push(ms);
    return Promise.resolve();
  };
}
