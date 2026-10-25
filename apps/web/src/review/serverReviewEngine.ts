import type { AnalyzeOptions, BestMove, Engine, EngineInfo, Limits } from '@daisychess/engine-core';

/**
 * The part of `RemoteEngineClient` the review uses (structural, so this module does not pull the
 * client into the main chunk and tests can pass a fake).
 */
export interface RemoteReviewClient extends Engine {
  /** Display name of the selected server engine (after `load()`), e.g. "Stockfish 19". */
  readonly engineName?: string;
  /** `welcome.limits` (after `load()`). */
  readonly limits?: Limits;
  analyze(
    fen: string,
    opts: AnalyzeOptions,
  ): AsyncIterable<EngineInfo> & { readonly bestMove?: Promise<BestMove | null> };
}

/** Hash per review session (MB), capped by `welcome.limits.maxHash`. */
export const REVIEW_SERVER_HASH_MB = 256;
/** A server search that yields nothing for this long counts as a dropped server (fallback). */
export const REVIEW_STALL_TIMEOUT_MS = 30_000;

type Handle = AsyncIterable<EngineInfo> & { readonly bestMove?: Promise<BestMove | null> };

/** Error shape of `RemoteEngineError` (name + protocol code) without importing the class. */
export function remoteError(message: string, code: string): Error {
  return Object.assign(new Error(message), { name: 'RemoteEngineError', code });
}

/**
 * Review engine on the DaisyChess server: adapts a {@link RemoteReviewClient} (one connection, one
 * dedicated server session) to the {@link Engine} interface `BatchAnalyzer` expects.
 *
 * - After `load()` the session asks for the server's maximum threads (`limits.maxThreads`) and
 *   {@link REVIEW_SERVER_HASH_MB} (capped by `limits.maxHash`).
 * - `depth`/`movetime` are clamped to `limits.maxDepth`/`limits.maxMovetimeMs`, so a preset never
 *   fails with `limit_exceeded`.
 * - Stall watchdog: a search that delivers no `info`/end for {@link REVIEW_STALL_TIMEOUT_MS}
 *   rejects with a `RemoteEngineError` (code `timeout`); the review store then falls back to the
 *   browser. (The client itself only times out *stopped* searches.)
 * - Scores arrive White-POV (the client converts them), as `BatchAnalyzer` expects by default.
 */
export class ServerReviewEngine implements Engine {
  private threadCount: number | undefined;
  private readonly stallTimeoutMs: number;

  constructor(
    readonly client: RemoteReviewClient,
    opts: { stallTimeoutMs?: number } = {},
  ) {
    this.stallTimeoutMs = opts.stallTimeoutMs ?? REVIEW_STALL_TIMEOUT_MS;
  }

  /** Threads requested per search (the server's per-session maximum), after `load()`. */
  get threads(): number | undefined {
    return this.threadCount;
  }

  get engineName(): string | undefined {
    return this.client.engineName;
  }

  async load(): Promise<void> {
    await this.client.load();
    const limits = this.client.limits;
    if (!limits) return;
    this.threadCount = limits.maxThreads;
    await this.client.setOptions({
      Threads: limits.maxThreads,
      Hash: Math.min(REVIEW_SERVER_HASH_MB, limits.maxHash),
    });
  }

  setOptions(options: Record<string, string | number | boolean>): Promise<void> {
    return this.client.setOptions(options);
  }

  /** Search options after clamping to `welcome.limits`. */
  clampOptions(opts: AnalyzeOptions): AnalyzeOptions {
    const l = this.client.limits;
    if (!l) return { ...opts };
    return {
      ...opts,
      ...(opts.depth !== undefined && { depth: Math.min(opts.depth, l.maxDepth) }),
      ...(opts.movetime !== undefined && { movetime: Math.min(opts.movetime, l.maxMovetimeMs) }),
      ...(opts.multipv !== undefined && { multipv: Math.min(opts.multipv, l.maxMultipv) }),
    };
  }

  analyze(fen: string, opts: AnalyzeOptions): Handle {
    const handle = this.client.analyze(fen, this.clampOptions(opts));
    const stallMs = this.stallTimeoutMs;
    const iterate = (): AsyncIterator<EngineInfo> => {
      const it = handle[Symbol.asyncIterator]();
      return {
        next: () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const stalled = new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(remoteError(`Engine server sent nothing for ${stallMs} ms`, 'timeout')),
              stallMs,
            );
          });
          return Promise.race([it.next(), stalled]).finally(() => clearTimeout(timer));
        },
        return: () =>
          Promise.resolve(it.return?.()).then(
            () => ({ value: undefined, done: true as const }),
            () => ({ value: undefined, done: true as const }),
          ),
      };
    };
    return {
      ...(handle.bestMove ? { bestMove: handle.bestMove } : {}),
      [Symbol.asyncIterator]: iterate,
    };
  }

  stop(): Promise<void> {
    return this.client.stop();
  }

  /** Releases the server session (and its per-address slot) and closes the connection. */
  dispose(): Promise<void> {
    return this.client.dispose();
  }
}
