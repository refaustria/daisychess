import type { BoardApi, GameStreamEvent, LichessEvent, SeekHandle } from './boardApi';

/** An async iterable fed by the test: `push` items, `end()` closes, `fail(e)` throws in the reader. */
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private rejecters: ((e: unknown) => void)[] = [];
  private closed = false;
  private error: unknown = null;

  constructor(signal?: AbortSignal) {
    signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      this.fail(e);
    });
  }

  push(v: T): void {
    const w = this.waiters.shift();
    this.rejecters.shift();
    if (w) w({ value: v, done: false });
    else this.queue.push(v);
  }

  end(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
    this.rejecters.splice(0);
  }

  fail(e: unknown): void {
    this.error = e;
    for (const r of this.rejecters.splice(0)) r(e);
    this.waiters.splice(0);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiters.push(resolve);
          this.rejecters.push(reject);
        });
      },
      return: () => {
        this.closed = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export interface FakeBoardApi extends BoardApi {
  /** Game streams opened so far (newest last). */
  gameStreams: Pushable<GameStreamEvent>[];
  eventStreams: Pushable<LichessEvent>[];
  seeks: { params: unknown; resolve(): void; reject(e: unknown): void; cancelled: boolean }[];
  calls: string[];
  /** Rejection for the next `move` call. */
  failNextMove?: unknown;
}

/** In-memory Board API for unit tests; every call is logged in `calls`. */
export function fakeBoardApi(overrides: Partial<BoardApi> = {}): FakeBoardApi {
  const api: FakeBoardApi = {
    gameStreams: [],
    eventStreams: [],
    seeks: [],
    calls: [],
    streamEvents(signal) {
      api.calls.push('streamEvents');
      const p = new Pushable<LichessEvent>(signal);
      api.eventStreams.push(p);
      return p;
    },
    streamGame(id, signal) {
      api.calls.push(`streamGame ${id}`);
      const p = new Pushable<GameStreamEvent>(signal);
      api.gameStreams.push(p);
      return p;
    },
    seek(params): SeekHandle {
      api.calls.push('seek');
      let resolve!: () => void;
      let reject!: (e: unknown) => void;
      const done = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      const entry = { params, resolve, reject, cancelled: false };
      api.seeks.push(entry);
      return {
        done,
        cancel: () => {
          entry.cancelled = true;
          resolve();
        },
      };
    },
    async challengeUser(username) {
      api.calls.push(`challengeUser ${username}`);
      return {
        id: 'chal1234',
        status: 'created',
        challenger: { id: 'me', name: 'Me' },
        destUser: { id: username.toLowerCase(), name: username },
        rated: false,
        speed: 'blitz',
        variant: 'standard',
        color: 'random',
      };
    },
    async challengeAi(level) {
      api.calls.push(`challengeAi ${level}`);
      return 'aigame12';
    },
    async cancelChallenge(id) {
      api.calls.push(`cancelChallenge ${id}`);
    },
    async acceptChallenge(id) {
      api.calls.push(`accept ${id}`);
    },
    async declineChallenge(id) {
      api.calls.push(`decline ${id}`);
    },
    async move(gameId, uci) {
      api.calls.push(`move ${gameId} ${uci}`);
      if (api.failNextMove !== undefined) {
        const e = api.failNextMove;
        api.failNextMove = undefined;
        throw e;
      }
    },
    async abort(id) {
      api.calls.push(`abort ${id}`);
    },
    async resign(id) {
      api.calls.push(`resign ${id}`);
    },
    async draw(id, yes) {
      api.calls.push(`draw ${id} ${yes ? 'yes' : 'no'}`);
    },
    async claimVictory(id) {
      api.calls.push(`claimVictory ${id}`);
    },
    async ongoingGames() {
      api.calls.push('ongoingGames');
      return [];
    },
    ...overrides,
  };
  return api;
}

/** Lets pending promise callbacks run. */
export const flush = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

export const gameFull = (
  over: { id?: string; moves?: string; white?: Record<string, unknown>; black?: Record<string, unknown>; status?: string } = {},
): GameStreamEvent => ({
  type: 'gameFull',
  id: over.id ?? 'game1234',
  rated: true,
  speed: 'rapid',
  clock: { initial: 600_000, increment: 0 },
  white: { id: 'me', name: 'Me', rating: 1500, ...(over.white ?? {}) } as { name: string },
  black: { id: 'opp', name: 'Opp', rating: 1600, ...(over.black ?? {}) } as { name: string },
  initialFen: 'startpos',
  variant: 'standard',
  state: gameState(over.moves ?? '', { status: over.status ?? 'started' }),
});

export const gameState = (
  moves: string,
  over: Partial<{ wtime: number; btime: number; status: string; winner: 'white' | 'black'; wdraw: boolean; bdraw: boolean }> = {},
) =>
  ({
    type: 'gameState',
    moves,
    wtime: over.wtime ?? 600_000,
    btime: over.btime ?? 600_000,
    winc: 0,
    binc: 0,
    status: over.status ?? 'started',
    ...(over.winner ? { winner: over.winner } : {}),
    ...(over.wdraw ? { wdraw: true } : {}),
    ...(over.bdraw ? { bdraw: true } : {}),
  }) as const;
