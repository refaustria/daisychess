import type { AnalyzeOptions, BestMove, EngineInfo, PolicyEntry } from '@daisychess/engine-core';
import { Chess } from 'chess.js';
import { authMessage } from '../server/tokenMessages';
import type { PlayEngine } from '../play/PlayController';

/**
 * Maia as the opponent of "Play vs engine" and of the drill (M23-2, ADR-019).
 *
 * {@link MaiaOpponent} is a {@link PlayEngine} backed by one dedicated server session
 * (`RemoteEngineClient` on the engine `maia-<rating>`). Per move it sends one `analyze` without
 * `nodes` (the server runs the engine's `maxNodes: 1`, i.e. the policy head's move) and picks:
 *
 * - "Vary moves" on: a sample from the top-5 `policy` of the last `info`, weighted p^(1/T)
 *   (T = {@link DEFAULT_TEMPERATURE}); off: the policy's top move (= `bestmove`).
 * - Fallback `bestmove` when the policy is missing or holds no legal move; every candidate is
 *   checked against the legal moves (chess.js), an illegal one is never played.
 * - A think delay of 300–1200 ms (more when the policy is spread out), never more than 5 % of the
 *   remaining clock time, so replies do not come instantly.
 *
 * Errors: `no_capacity` (all Maia processes of the server are busy) is retried with backoff up to
 * {@link BUSY_BACKOFF_MS}.length times, then the move fails with {@link MAIA_BUSY_MESSAGE}; a lost
 * connection is reconnected once per move; a missing/wrong token fails with
 * `authMessage()`.
 */

/** The part of `RemoteEngineClient` the opponent uses (structural; tests pass a fake). */
export interface MaiaClient {
  load(): Promise<void>;
  analyze(
    fen: string,
    opts: AnalyzeOptions,
  ): AsyncIterable<EngineInfo> & { readonly bestMove?: Promise<BestMove | null> };
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

export const MAIA_BUSY_MESSAGE = 'Maia is busy, try again';
export const SERVER_UNAVAILABLE_MESSAGE = 'Server unavailable';
/** Waits before the 1st, 2nd and 3rd retry of a `no_capacity` answer. */
export const BUSY_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000];
export const DEFAULT_TEMPERATURE = 1;
export const MIN_THINK_MS = 300;
export const MAX_THINK_MS = 1_200;
/** The think delay never takes more than this share of the remaining clock time. */
export const MAX_CLOCK_SHARE = 0.05;
/** Policy entries considered for sampling. */
export const SAMPLE_TOP = 5;

/** Error with a protocol-like code (same shape as `RemoteEngineError`, without importing it). */
export class MaiaError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'MaiaError';
  }
}

const codeOf = (err: unknown): string | undefined => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
};

/** The legal moves of `fen` in UCI notation (empty for an invalid FEN). */
export function legalUciMoves(fen: string): Set<string> {
  try {
    return new Set(
      new Chess(fen).moves({ verbose: true }).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`),
    );
  } catch {
    return new Set();
  }
}

const CASTLE_AS_ROOK: Record<string, string> = {
  e1h1: 'e1g1',
  e1a1: 'e1c1',
  e8h8: 'e8g8',
  e8a8: 'e8c8',
};

/**
 * `uci` as a legal move of `fen`, or null. Castling written king-takes-rook (`e1h1`, Lc0's
 * internal notation) is mapped to the standard `e1g1`.
 */
export function legalMove(fen: string, uci: string | null | undefined, legal = legalUciMoves(fen)) {
  if (!uci) return null;
  const move = uci.toLowerCase();
  if (legal.has(move)) return move;
  const castle = CASTLE_AS_ROOK[move];
  return castle && legal.has(castle) ? castle : null;
}

/** Shannon entropy of the (renormalised) distribution, scaled to 0…1 by log(n); 0 for n ≤ 1. */
export function policyEntropy(entries: readonly PolicyEntry[]): number {
  const ps = entries.map((e) => e.p).filter((p) => p > 0);
  if (ps.length <= 1) return 0;
  const sum = ps.reduce((a, b) => a + b, 0);
  let h = 0;
  for (const p of ps) {
    const q = p / sum;
    h -= q * Math.log(q);
  }
  return Math.min(1, Math.max(0, h / Math.log(ps.length)));
}

/**
 * Draws one entry, weighted p^(1/temperature) (temperature 1 = proportional to p, → 0 = the
 * most probable one). `random` returns [0, 1). Null for an empty list or zero weights.
 */
export function samplePolicy(
  entries: readonly PolicyEntry[],
  random: () => number,
  temperature = DEFAULT_TEMPERATURE,
): PolicyEntry | null {
  if (entries.length === 0) return null;
  if (!(temperature > 0.01)) {
    return entries.reduce((best, e) => (e.p > best.p ? e : best), entries[0]!);
  }
  const weights = entries.map((e) => (e.p > 0 ? Math.pow(e.p, 1 / temperature) : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  let r = Math.min(Math.max(random(), 0), 1 - Number.EPSILON) * total;
  for (let i = 0; i < entries.length; i++) {
    r -= weights[i]!;
    if (r < 0) return entries[i]!;
  }
  return entries[entries.length - 1]!;
}

export interface ChooseMoveInput {
  fen: string;
  /** `policy` of the search's last info (most probable first), if any. */
  policy?: readonly PolicyEntry[];
  /** The server's `bestmove` (null on a terminal position). */
  bestMove: string | null | undefined;
  vary: boolean;
  random: () => number;
  temperature?: number;
}

export interface ChosenMove {
  uci: string;
  /** Where the move comes from. */
  source: 'sample' | 'top' | 'bestmove';
}

/**
 * The move to play: a policy sample (vary) or the top policy move, restricted to legal moves;
 * else the legal `bestmove`; null when neither gives a legal move.
 */
export function chooseMove(input: ChooseMoveInput): ChosenMove | null {
  const legal = legalUciMoves(input.fen);
  const candidates: PolicyEntry[] = [];
  for (const e of (input.policy ?? []).slice(0, SAMPLE_TOP)) {
    const uci = legalMove(input.fen, e.uci, legal);
    if (uci && !candidates.some((c) => c.uci === uci)) candidates.push({ uci, p: e.p });
  }
  if (candidates.length > 0) {
    if (input.vary) {
      const pick = samplePolicy(candidates, input.random, input.temperature);
      if (pick) return { uci: pick.uci, source: 'sample' };
    } else {
      const top = candidates.reduce((b, e) => (e.p > b.p ? e : b), candidates[0]!);
      return { uci: top.uci, source: 'top' };
    }
  }
  const best = legalMove(input.fen, input.bestMove, legal);
  return best ? { uci: best, source: 'bestmove' } : null;
}

/**
 * Think delay (ms): {@link MIN_THINK_MS}…{@link MAX_THINK_MS}, longer for a spread-out policy
 * (`entropy` 0…1, 0.5 when unknown) plus a little jitter, capped at {@link MAX_CLOCK_SHARE} of
 * `remainingMs` (with a clock).
 */
export function thinkDelayMs(
  entropy: number | undefined,
  remainingMs: number | undefined,
  random: () => number,
): number {
  const h = entropy === undefined ? 0.5 : Math.min(1, Math.max(0, entropy));
  const share = 0.75 * h + 0.25 * Math.min(1, Math.max(0, random()));
  let ms = MIN_THINK_MS + (MAX_THINK_MS - MIN_THINK_MS) * share;
  if (remainingMs !== undefined && Number.isFinite(remainingMs)) {
    ms = Math.min(ms, Math.max(0, remainingMs) * MAX_CLOCK_SHARE);
  }
  return Math.max(0, Math.round(ms));
}

export interface MaiaOpponentOptions {
  /** Server engine id, e.g. `maia-1500` (used in messages only; the client selects it). */
  engineId: string;
  /** A new client (one connection, one session) on the Maia engine; called again to reconnect. */
  createClient: () => MaiaClient | Promise<MaiaClient>;
  /** "Vary moves" (read per move); default on. */
  varyMoves?: () => boolean;
  temperature?: number;
  random?: () => number;
  /** The opponent's remaining clock time (ms), undefined without a clock. */
  remainingMs?: () => number | undefined;
  /** Waits `ms` (test seam; default `setTimeout`). The opponent can cut a wait short (`stop`). */
  wait?: (ms: number) => Promise<void>;
  busyBackoffMs?: readonly number[];
  /** Think delay override (tests); default {@link thinkDelayMs}. */
  thinkDelay?: (entropy: number | undefined, remainingMs: number | undefined) => number;
}

type Handle = AsyncIterable<EngineInfo> & { readonly bestMove: Promise<BestMove | null> };

const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** See the module comment. */
export class MaiaOpponent implements PlayEngine {
  private readonly o: MaiaOpponentOptions;
  private client: MaiaClient | null = null;
  private loading: Promise<MaiaClient> | null = null;
  private disposed = false;
  /** Bumped by every `analyze`, `stop` and `dispose`; stale work ends quietly. */
  private gen = 0;
  /** Resolvers of the running waits (`stop` ends them early). */
  private readonly wakers = new Set<() => void>();
  /** Statistics for tests and diagnostics. */
  readonly stats = { searches: 0, busyRetries: 0, reconnects: 0, clients: 0 };

  constructor(options: MaiaOpponentOptions) {
    this.o = options;
  }

  async load(): Promise<void> {
    await this.ensureClient();
  }

  /** Maia takes no UCI options (strength = the network); accepted and ignored. */
  setOptions(): Promise<void> {
    return Promise.resolve();
  }

  analyze(fen: string): Handle {
    const my = ++this.gen;
    let settle!: (b: BestMove | null) => void;
    const bestMove = new Promise<BestMove | null>((r) => (settle = r));
    const run = async function* (self: MaiaOpponent): AsyncGenerator<EngineInfo> {
      try {
        const result = await self.search(fen, my);
        if (!result || my !== self.gen) return;
        const remaining = self.o.remainingMs?.();
        const entropy = result.policy?.length ? policyEntropy(result.policy) : undefined;
        const delay = self.o.thinkDelay
          ? self.o.thinkDelay(entropy, remaining)
          : thinkDelayMs(entropy, remaining, self.o.random ?? Math.random);
        if (delay > 0) await self.wait(delay);
        if (my !== self.gen) return;
        yield {
          depth: result.info?.depth ?? 1,
          multipv: 1,
          score: result.info?.score ?? { cp: 0 },
          pv: [result.move],
          ...(result.policy ? { policy: [...result.policy] } : {}),
        };
        settle({ move: result.move });
      } finally {
        settle(null);
      }
    };
    const it = run(this);
    return { bestMove, [Symbol.asyncIterator]: () => it };
  }

  async stop(): Promise<void> {
    this.gen++;
    this.wakeAll();
    await this.client?.stop().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.gen++;
    this.wakeAll();
    const c = this.client;
    this.client = null;
    this.loading = null;
    if (c) await c.dispose().catch(() => undefined);
  }

  // --- internals -------------------------------------------------------------------------------

  private async search(
    fen: string,
    my: number,
  ): Promise<{ move: string; policy?: PolicyEntry[]; info?: EngineInfo } | null> {
    const backoff = this.o.busyBackoffMs ?? BUSY_BACKOFF_MS;
    let busy = 0;
    let reconnected = false;
    for (;;) {
      try {
        const client = await this.ensureClient();
        if (my !== this.gen) return null;
        this.stats.searches++;
        // No `nodes`: a Maia engine runs exactly its `maxNodes` (1) on the server.
        const handle = client.analyze(fen, {});
        let last: EngineInfo | undefined;
        let policy: PolicyEntry[] | undefined;
        for await (const info of handle) {
          last = info;
          if (info.policy?.length) policy = info.policy;
        }
        const best = (await handle.bestMove)?.move ?? null;
        if (my !== this.gen) return null;
        const chosen = chooseMove({
          fen,
          ...(policy ? { policy } : {}),
          bestMove: best ?? last?.pv[0],
          vary: this.o.varyMoves?.() ?? true,
          random: this.o.random ?? Math.random,
          ...(this.o.temperature !== undefined ? { temperature: this.o.temperature } : {}),
        });
        if (!chosen) {
          // Terminal position (Lc0 answers 0000 → null) or nothing legal: no move.
          if (legalUciMoves(fen).size === 0) return null;
          throw new MaiaError('Maia returned no legal move', 'invalid_move');
        }
        return { move: chosen.uci, ...(policy ? { policy } : {}), ...(last ? { info: last } : {}) };
      } catch (err) {
        if (my !== this.gen || this.disposed) return null;
        const code = codeOf(err);
        if (code === 'no_capacity') {
          if (busy >= backoff.length) throw new MaiaError(MAIA_BUSY_MESSAGE, 'no_capacity');
          const ms = backoff[busy++]!;
          this.stats.busyRetries++;
          await this.wait(ms);
          if (my !== this.gen) return null;
          continue;
        }
        if ((code === 'closed' || code === 'timeout') && !reconnected) {
          // The connection dropped (server restart, network): one new session per move.
          reconnected = true;
          this.stats.reconnects++;
          await this.dropClient();
          continue;
        }
        throw mapError(err);
      }
    }
  }

  private ensureClient(): Promise<MaiaClient> {
    if (this.disposed) return Promise.reject(new MaiaError('Engine has been disposed', 'closed'));
    if (this.client) return Promise.resolve(this.client);
    this.loading ??= (async () => {
      const c = await this.o.createClient();
      this.stats.clients++;
      if (this.disposed) {
        void c.dispose().catch(() => undefined);
        throw new MaiaError('Engine has been disposed', 'closed');
      }
      try {
        await c.load();
      } catch (err) {
        void c.dispose().catch(() => undefined);
        throw err;
      }
      if (this.disposed) {
        void c.dispose().catch(() => undefined);
        throw new MaiaError('Engine has been disposed', 'closed');
      }
      this.client = c;
      return c;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading.catch((err: unknown) => {
      // `load` errors keep their code for the retry logic; the message is mapped for the user.
      throw mapError(err);
    });
  }

  private async dropClient(): Promise<void> {
    const c = this.client;
    this.client = null;
    if (c) await c.dispose().catch(() => undefined);
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = () => {
        this.wakers.delete(done);
        resolve();
      };
      this.wakers.add(done);
      void (this.o.wait ?? defaultWait)(ms).then(done, done);
    });
  }

  private wakeAll(): void {
    for (const w of [...this.wakers]) w();
  }
}

/** User-facing message for a server error, keeping the code. */
function mapError(err: unknown): Error {
  if (err instanceof MaiaError) return err;
  const code = codeOf(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (code === 'unauthorized') return new MaiaError(authMessage(), code);
  if (code === 'no_capacity') return new MaiaError(MAIA_BUSY_MESSAGE, code);
  if (code === 'forbidden')
    return new MaiaError(`The server refuses the engine now (${msg})`, code);
  if (code === 'unknown_engine') return new MaiaError(`Maia is not available on the server`, code);
  if (code === 'closed' || code === 'timeout')
    return new MaiaError(`${SERVER_UNAVAILABLE_MESSAGE} (${msg})`, code);
  return err instanceof Error ? err : new Error(msg);
}
