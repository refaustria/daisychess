/**
 * Client for the lichess tablebase API (ADR-025 §2): `GET https://tablebase.lichess.ovh/standard`
 * with `fen=<FEN, spaces as _>`. Plain CORS `fetch` straight from the browser — no credentials, no
 * token, never through our nginx.
 *
 * Bounded use of a free service:
 * - one queue, concurrency 1, at least {@link MIN_SPACING_MS} between the starts of two requests;
 * - {@link REQUEST_TIMEOUT_MS} per request;
 * - `429` → no request until `Retry-After` (default {@link DEFAULT_RETRY_AFTER_S});
 * - 5xx, network errors and timeouts → the source is unavailable for {@link COOLDOWN_MS};
 * - identical FENs in flight share one request;
 * - every caller may pass an `AbortSignal` (the review overlay aborts on a game change): an
 *   aborted call rejects with an `AbortError`, and the request is cancelled (or dropped from the
 *   queue) once no caller waits for it any more.
 *
 * `probe` resolves `null` for anything that is not exact data: invalid answers, `unknown` and
 * `maybe-*` categories (`normalizeLichess`), 4xx, a cooling-down source. It never rejects except
 * with an `AbortError`.
 */
import { normalizeLichess, type TablebaseProbe, type TbPosition } from '@daisychess/endgames';

export const TABLEBASE_ORIGIN = 'https://tablebase.lichess.ovh';
export const MIN_SPACING_MS = 100;
export const REQUEST_TIMEOUT_MS = 10_000;
export const COOLDOWN_MS = 60_000;
export const DEFAULT_RETRY_AFTER_S = 60;

/** `https://tablebase.lichess.ovh/standard?fen=8/8/8/8/8/8/8/8_w_-_-_0_1` (spaces as `_`). */
export function tablebaseUrl(fen: string): string {
  const q = fen.trim().split(/\s+/).join('_');
  return `${TABLEBASE_ORIGIN}/standard?fen=${encodeURIComponent(q).replace(/%2F/g, '/')}`;
}

export type TbFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface LichessTablebaseOptions {
  fetch?: TbFetch;
  now?: () => number;
  /** Waits `ms` (tests replace it); must reject with an `AbortError` when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  spacingMs?: number;
  timeoutMs?: number;
  cooldownMs?: number;
}

export interface ProbeOptions {
  signal?: AbortSignal;
}

/** Why the source does not answer right now. */
export type LichessUnavailable = 'rate_limited' | 'unavailable';

export interface LichessTablebaseClient extends TablebaseProbe {
  probe(fen: string, opts?: ProbeOptions): Promise<TbPosition | null>;
  /** False while a 429 or a failure cooldown runs. */
  available(): boolean;
  /** Epoch ms until which no request is sent (0 when available). */
  blockedUntil(): number;
  /** Why the source is blocked, or null. */
  blockedReason(): LichessUnavailable | null;
  /** Requests started so far (tests, diagnostics). */
  requestCount(): number;
  /** Cancels every queued and running request (their callers get an `AbortError`). */
  abortAll(): void;
}

export function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('Aborted', 'AbortError');
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Seconds from a `Retry-After` header (delta seconds or an HTTP date); the default otherwise. */
export function parseRetryAfter(raw: string | null, now: number): number {
  if (raw) {
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n) && n >= 0) return Math.ceil(n);
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - now) / 1000));
  }
  return DEFAULT_RETRY_AFTER_S;
}

interface Job {
  fen: string;
  controller: AbortController;
  waiters: number;
  promise: Promise<TbPosition | null>;
  resolve: (v: TbPosition | null) => void;
  reject: (e: unknown) => void;
}

export function createLichessTablebase(opts: LichessTablebaseOptions = {}): LichessTablebaseClient {
  const doFetch: TbFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const spacing = opts.spacingMs ?? MIN_SPACING_MS;
  const timeout = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const cooldown = opts.cooldownMs ?? COOLDOWN_MS;

  const queue: Job[] = [];
  const inFlight = new Map<string, Job>();
  let running = false;
  let lastStart = -Infinity;
  let blocked = 0;
  let reason: LichessUnavailable | null = null;
  let requests = 0;

  const isBlocked = () => now() < blocked;

  const block = (ms: number, why: LichessUnavailable) => {
    blocked = Math.max(blocked, now() + ms);
    reason = why;
  };

  /** Resolves every queued job with null (the source went unavailable while they waited). */
  const flushBlocked = () => {
    for (const job of queue.splice(0)) {
      inFlight.delete(job.fen);
      job.resolve(null);
    }
  };

  async function request(job: Job): Promise<TbPosition | null> {
    const wait = lastStart + spacing - now();
    if (wait > 0) await sleep(wait, job.controller.signal);
    if (job.controller.signal.aborted) throw abortError();
    if (isBlocked()) return null;
    lastStart = now();
    requests++;
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), timeout);
    const onAbort = () => timer.abort();
    job.controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await doFetch(tablebaseUrl(job.fen), {
          method: 'GET',
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          signal: timer.signal,
        });
      } catch {
        if (job.controller.signal.aborted) throw abortError();
        // Network error or our timeout.
        block(cooldown, 'unavailable');
        return null;
      }
      if (res.status === 429) {
        block(parseRetryAfter(res.headers.get('Retry-After'), now()) * 1000, 'rate_limited');
        return null;
      }
      if (res.status >= 500) {
        block(cooldown, 'unavailable');
        return null;
      }
      if (!res.ok) return null; // 400 invalid FEN, 404: no data for this position
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (job.controller.signal.aborted) throw abortError();
        if (timer.signal.aborted) block(cooldown, 'unavailable');
        return null;
      }
      return normalizeLichess(body, job.fen);
    } finally {
      clearTimeout(t);
      job.controller.signal.removeEventListener('abort', onAbort);
    }
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        if (isBlocked()) {
          flushBlocked();
          break;
        }
        const job = queue.shift()!;
        try {
          job.resolve(await request(job));
        } catch (e) {
          job.reject(isAbortError(e) ? e : abortError());
        } finally {
          inFlight.delete(job.fen);
        }
      }
    } finally {
      running = false;
    }
  }

  function release(job: Job): void {
    job.waiters--;
    if (job.waiters > 0) return;
    job.controller.abort();
    const i = queue.indexOf(job);
    if (i >= 0) {
      queue.splice(i, 1);
      inFlight.delete(job.fen);
      job.reject(abortError());
    }
  }

  function probe(fen: string, o: ProbeOptions = {}): Promise<TbPosition | null> {
    const signal = o.signal;
    if (signal?.aborted) return Promise.reject(abortError());
    if (isBlocked()) return Promise.resolve(null);
    const key = fen.trim();
    let job = inFlight.get(key);
    if (!job) {
      let resolve!: (v: TbPosition | null) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<TbPosition | null>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Nobody may be left waiting when the last caller aborts: swallow the shared rejection.
      promise.catch(() => undefined);
      job = { fen: key, controller: new AbortController(), waiters: 0, promise, resolve, reject };
      inFlight.set(key, job);
      queue.push(job);
      void pump();
    }
    const j = job;
    j.waiters++;
    if (!signal) return j.promise;
    return new Promise<TbPosition | null>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        release(j);
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      j.promise.then(
        (v) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  return {
    probe,
    available: () => !isBlocked(),
    blockedUntil: () => (isBlocked() ? blocked : 0),
    blockedReason: () => (isBlocked() ? reason : null),
    requestCount: () => requests,
    abortAll: () => {
      for (const job of [...inFlight.values()]) {
        job.controller.abort();
        const i = queue.indexOf(job);
        if (i >= 0) queue.splice(i, 1);
        inFlight.delete(job.fen);
        job.reject(abortError());
      }
    },
  };
}
