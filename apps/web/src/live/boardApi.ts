/**
 * Typed client for the lichess Board API (https://lichess.org/api#tag/Board) and the challenge
 * endpoints a live game needs. Every request goes through {@link LichessFetch} (by default
 * `lichessFetch` from the auth module, which adds the `Authorization` header), so tests inject a
 * fake.
 *
 * Streams are NDJSON (`application/x-ndjson`): one JSON object per line, blank lines as
 * keep-alives (lichess sends one every few seconds). They are exposed as async iterables of the
 * parsed objects; the iteration ends when the server closes the stream and throws an
 * `AbortError` when the caller's signal aborts. Payloads are validated lightly by hand (no zod):
 * every object must carry a string `type` (`gameFull`, `gameState`, `gameStart`, …).
 */
import { lichessFetch } from '../lichess/auth';

export type LichessFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type BoardApiErrorKind = 'unauthorized' | 'rate_limited' | 'bad_request' | 'not_found' | 'network';

export class BoardApiError extends Error {
  readonly kind: BoardApiErrorKind;
  readonly status?: number;
  /** Seconds to wait (`rate_limited`). */
  readonly retryAfter?: number;
  constructor(kind: BoardApiErrorKind, message: string, extra: { status?: number; retryAfter?: number } = {}) {
    super(message);
    this.name = 'BoardApiError';
    this.kind = kind;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.retryAfter !== undefined) this.retryAfter = extra.retryAfter;
  }
}

export const UNAUTHORIZED_TEXT = 'Log in with lichess (with the board:play permission) to play live games';
/** Default wait after a 429 without a readable `Retry-After` (lichess asks for one minute). */
export const DEFAULT_RETRY_AFTER = 60;

// --- payload types (only the fields DaisyChess uses) ----------------------------------------------

export type Color = 'white' | 'black';

export interface LichessPlayer {
  /** Lowercase user id; absent for the lichess AI. */
  id?: string;
  name: string;
  rating?: number;
  /** The rating is provisional (few games). */
  provisional?: boolean;
  /** Rating change after a rated game, when lichess reports it. */
  ratingDiff?: number;
  title?: string;
  /** Stockfish level for the lichess AI. */
  aiLevel?: number;
}

export interface GameStateEvent {
  type: 'gameState';
  /** UCI moves from the initial position, space separated ('' before the first move). */
  moves: string;
  wtime: number;
  btime: number;
  winc: number;
  binc: number;
  /** created, started, aborted, mate, resign, stalemate, timeout, draw, outoftime, noStart, … */
  status: string;
  winner?: Color;
  wdraw?: boolean;
  bdraw?: boolean;
}

export interface GameFullEvent {
  type: 'gameFull';
  id: string;
  rated: boolean;
  speed: string;
  /** null for correspondence/unlimited games. */
  clock: { initial: number; increment: number } | null;
  white: LichessPlayer;
  black: LichessPlayer;
  /** 'startpos' or a FEN. */
  initialFen: string;
  variant: string;
  state: GameStateEvent;
}

export interface OpponentGoneEvent {
  type: 'opponentGone';
  gone: boolean;
  claimWinInSeconds?: number;
}

export interface ChatLineEvent {
  type: 'chatLine';
  username: string;
  text: string;
  room: string;
}

export type GameStreamEvent = GameFullEvent | GameStateEvent | OpponentGoneEvent | ChatLineEvent;

/** A game of the user (event stream `gameStart`/`gameFinish`, `/api/account/playing`). */
export interface GameInfo {
  gameId: string;
  color: Color;
  opponent: { name: string; rating?: number; aiLevel?: number };
  rated: boolean;
  speed: string;
  isMyTurn?: boolean;
  /** Seconds left on the user's clock (ongoing games). */
  secondsLeft?: number;
  /** lobby, friend, ai, pool, … */
  source?: string;
  fen?: string;
}

export interface ChallengeInfo {
  id: string;
  /** created, offline, canceled, declined, accepted */
  status: string;
  challenger: { id: string; name: string; rating?: number; title?: string };
  destUser?: { id: string; name: string; rating?: number; title?: string };
  rated: boolean;
  speed: string;
  /** Real-time clock in seconds; absent for correspondence/unlimited. */
  clock?: { limit: number; increment: number };
  variant: string;
  /** Colour the challenger chose: white, black or random. */
  color: string;
  declineReason?: string;
}

export type LichessEvent =
  | { type: 'gameStart'; game: GameInfo }
  | { type: 'gameFinish'; game: GameInfo }
  | { type: 'challenge'; challenge: ChallengeInfo }
  | { type: 'challengeCanceled'; challenge: ChallengeInfo }
  | { type: 'challengeDeclined'; challenge: ChallengeInfo };

// --- light validation ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const color = (v: unknown): Color | undefined => (v === 'white' || v === 'black' ? v : undefined);
const variantKey = (v: unknown): string => (isObj(v) ? (str(v.key) ?? 'standard') : (str(v) ?? 'standard'));

function parsePlayer(v: unknown): LichessPlayer {
  const o = isObj(v) ? v : {};
  const aiLevel = num(o.aiLevel);
  const p: LichessPlayer = {
    name: str(o.name) ?? str(o.username) ?? (aiLevel !== undefined ? `lichess AI level ${aiLevel}` : 'Anonymous'),
  };
  const id = str(o.id);
  if (id) p.id = id;
  const rating = num(o.rating);
  if (rating !== undefined) p.rating = rating;
  if (o.provisional === true) p.provisional = true;
  const ratingDiff = num(o.ratingDiff);
  if (ratingDiff !== undefined) p.ratingDiff = ratingDiff;
  const title = str(o.title);
  if (title) p.title = title;
  if (aiLevel !== undefined) p.aiLevel = aiLevel;
  return p;
}

export function parseGameState(o: Obj): GameStateEvent {
  const s: GameStateEvent = {
    type: 'gameState',
    moves: str(o.moves) ?? '',
    wtime: num(o.wtime) ?? 0,
    btime: num(o.btime) ?? 0,
    winc: num(o.winc) ?? 0,
    binc: num(o.binc) ?? 0,
    status: str(o.status) ?? 'started',
  };
  const winner = color(o.winner);
  if (winner) s.winner = winner;
  if (o.wdraw === true) s.wdraw = true;
  if (o.bdraw === true) s.bdraw = true;
  return s;
}

/** Normalises one game stream line; null for unknown or malformed objects (ignored). */
export function parseGameStreamEvent(v: unknown): GameStreamEvent | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'gameFull': {
      const id = str(v.id);
      if (!id || !isObj(v.state)) return null;
      const clock = isObj(v.clock) ? { initial: num(v.clock.initial) ?? 0, increment: num(v.clock.increment) ?? 0 } : null;
      return {
        type: 'gameFull',
        id,
        rated: v.rated === true,
        speed: str(v.speed) ?? 'unknown',
        clock,
        white: parsePlayer(v.white),
        black: parsePlayer(v.black),
        initialFen: str(v.initialFen) ?? 'startpos',
        variant: variantKey(v.variant),
        state: parseGameState(v.state),
      };
    }
    case 'gameState':
      return parseGameState(v);
    case 'opponentGone': {
      const e: OpponentGoneEvent = { type: 'opponentGone', gone: v.gone === true };
      const secs = num(v.claimWinInSeconds);
      if (secs !== undefined) e.claimWinInSeconds = secs;
      return e;
    }
    case 'chatLine':
      return { type: 'chatLine', username: str(v.username) ?? '', text: str(v.text) ?? '', room: str(v.room) ?? '' };
    default:
      return null;
  }
}

export function parseGameInfo(v: unknown): GameInfo | null {
  if (!isObj(v)) return null;
  const gameId = str(v.gameId) ?? str(v.id);
  const c = color(v.color);
  if (!gameId || !c) return null;
  const opp = isObj(v.opponent) ? v.opponent : {};
  const aiLevel = num(opp.ai);
  const g: GameInfo = {
    gameId,
    color: c,
    opponent: {
      name: str(opp.username) ?? (aiLevel !== undefined ? `lichess AI level ${aiLevel}` : 'Anonymous'),
    },
    rated: v.rated === true,
    speed: str(v.speed) ?? 'unknown',
  };
  const rating = num(opp.rating);
  if (rating !== undefined) g.opponent.rating = rating;
  if (aiLevel !== undefined) g.opponent.aiLevel = aiLevel;
  if (typeof v.isMyTurn === 'boolean') g.isMyTurn = v.isMyTurn;
  const secondsLeft = num(v.secondsLeft);
  if (secondsLeft !== undefined) g.secondsLeft = secondsLeft;
  const source = str(v.source);
  if (source) g.source = source;
  const fen = str(v.fen);
  if (fen) g.fen = fen;
  return g;
}

function parseUser(v: unknown): ChallengeInfo['challenger'] | undefined {
  if (!isObj(v)) return undefined;
  const id = str(v.id);
  if (!id) return undefined;
  const u: ChallengeInfo['challenger'] = { id, name: str(v.name) ?? id };
  const rating = num(v.rating);
  if (rating !== undefined) u.rating = rating;
  const title = str(v.title);
  if (title) u.title = title;
  return u;
}

export function parseChallenge(v: unknown): ChallengeInfo | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const challenger = parseUser(v.challenger);
  if (!id || !challenger) return null;
  const c: ChallengeInfo = {
    id,
    status: str(v.status) ?? 'created',
    challenger,
    rated: v.rated === true,
    speed: str(v.speed) ?? 'unknown',
    variant: variantKey(v.variant),
    color: str(v.color) ?? 'random',
  };
  const dest = parseUser(v.destUser);
  if (dest) c.destUser = dest;
  const tc = isObj(v.timeControl) ? v.timeControl : undefined;
  if (tc && tc.type === 'clock') c.clock = { limit: num(tc.limit) ?? 0, increment: num(tc.increment) ?? 0 };
  const reason = str(v.declineReason);
  if (reason) c.declineReason = reason;
  return c;
}

/** Normalises one event stream line; null for unknown or malformed objects (ignored). */
export function parseLichessEvent(v: unknown): LichessEvent | null {
  if (!isObj(v)) return null;
  switch (v.type) {
    case 'gameStart':
    case 'gameFinish': {
      const game = parseGameInfo(v.game);
      return game ? { type: v.type, game } : null;
    }
    case 'challenge':
    case 'challengeCanceled':
    case 'challengeDeclined': {
      const challenge = parseChallenge(v.challenge);
      return challenge ? { type: v.type, challenge } : null;
    }
    default:
      return null;
  }
}

// --- NDJSON -------------------------------------------------------------------------------------

/**
 * Splits a byte stream into parsed JSON lines. Blank lines (keep-alives) are skipped, lines split
 * across chunks are joined, multi-byte UTF-8 characters split across chunks are decoded correctly,
 * and malformed lines are skipped. A final line without a newline is parsed at the end.
 */
export async function* readNdjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  const parse = (line: string): { ok: true; value: unknown } | { ok: false } => {
    const t = line.trim();
    if (!t) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(t) as unknown };
    } catch {
      return { ok: false };
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) throw abortError();
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const r = parse(line);
        if (r.ok) yield r.value;
        nl = buf.indexOf('\n');
      }
    }
    buf += decoder.decode();
    const r = parse(buf);
    if (r.ok) yield r.value;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

// --- requests -----------------------------------------------------------------------------------

function parseRetryAfter(res: Response): number {
  const raw = res.headers.get('Retry-After');
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  }
  return DEFAULT_RETRY_AFTER;
}

async function lichessErrorText(res: Response): Promise<string | undefined> {
  try {
    const j = (await res.json()) as unknown;
    if (isObj(j)) {
      if (typeof j.error === 'string') return j.error.slice(0, 200);
      // Form errors: { "error": { "clock.limit": ["…"] } } or a top-level map.
      const src = isObj(j.error) ? j.error : j;
      const first = Object.values(src).find((v) => Array.isArray(v) && typeof v[0] === 'string') as string[] | undefined;
      if (first) return first[0]!.slice(0, 200);
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Maps a non-OK response to a {@link BoardApiError}. */
export async function errorFromResponse(res: Response): Promise<BoardApiError> {
  if (res.status === 401 || res.status === 403) {
    return new BoardApiError('unauthorized', UNAUTHORIZED_TEXT, { status: res.status });
  }
  if (res.status === 429) {
    const retryAfter = parseRetryAfter(res);
    return new BoardApiError('rate_limited', `lichess asks to slow down; try again in ${retryAfter} s`, {
      status: 429,
      retryAfter,
    });
  }
  const text = await lichessErrorText(res);
  if (res.status === 404) return new BoardApiError('not_found', text ?? 'Not found on lichess', { status: 404 });
  return new BoardApiError('bad_request', text ?? `lichess refused the request (HTTP ${res.status})`, {
    status: res.status,
  });
}

export interface SeekParams {
  rated: boolean;
  /** Minutes. */
  time: number;
  /** Seconds. */
  increment: number;
  color: 'white' | 'black' | 'random';
  ratingRange?: string;
}

export interface ClockParams {
  /** Seconds. */
  limit: number;
  /** Seconds. */
  increment: number;
}

export interface ChallengeParams {
  rated: boolean;
  clock: ClockParams;
  color: 'white' | 'black' | 'random';
}

export interface SeekHandle {
  /** Resolves when lichess closes the seek (paired or expired); rejects on errors (not on cancel). */
  readonly done: Promise<void>;
  cancel(): void;
}

export interface BoardApi {
  streamEvents(signal: AbortSignal): AsyncIterable<LichessEvent>;
  streamGame(gameId: string, signal: AbortSignal): AsyncIterable<GameStreamEvent>;
  seek(params: SeekParams, signal?: AbortSignal): SeekHandle;
  challengeUser(username: string, params: ChallengeParams): Promise<ChallengeInfo>;
  /** Returns the id of the created game. */
  challengeAi(level: number, clock: ClockParams, color?: 'white' | 'black' | 'random'): Promise<string>;
  cancelChallenge(id: string): Promise<void>;
  acceptChallenge(id: string): Promise<void>;
  declineChallenge(id: string, reason?: string): Promise<void>;
  move(gameId: string, uci: string, opts?: { offeringDraw?: boolean }): Promise<void>;
  abort(gameId: string): Promise<void>;
  resign(gameId: string): Promise<void>;
  draw(gameId: string, accept: boolean): Promise<void>;
  claimVictory(gameId: string): Promise<void>;
  ongoingGames(): Promise<GameInfo[]>;
}

const UCI = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const ID = /^[A-Za-z0-9]{4,16}$/;
const USERNAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/;

function checkId(id: string): string {
  if (!ID.test(id)) throw new BoardApiError('bad_request', 'Invalid game or challenge id');
  return id;
}

const form = (fields: Record<string, string | number | boolean>): URLSearchParams =>
  new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v)]));

export function createBoardApi(fetchImpl: LichessFetch = lichessFetch): BoardApi {
  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(path, init);
    } catch (e) {
      if (isAbortError(e)) throw e;
      throw new BoardApiError('network', 'Could not reach lichess – check your connection');
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }

  const post = (path: string, body?: URLSearchParams, signal?: AbortSignal): Promise<Response> =>
    send(path, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } : { Accept: 'application/json' },
      ...(body ? { body: body.toString() } : {}),
      ...(signal ? { signal } : {}),
    });

  const postOk = async (path: string, body?: URLSearchParams): Promise<void> => {
    const res = await post(path, body);
    await res.body?.cancel().catch(() => undefined);
  };

  async function* stream<T>(path: () => string, signal: AbortSignal, parse: (v: unknown) => T | null): AsyncGenerator<T> {
    const res = await send(path(), { headers: { Accept: 'application/x-ndjson' }, signal });
    if (!res.body) return;
    try {
      for await (const v of readNdjson(res.body, signal)) {
        const e = parse(v);
        if (e) yield e;
      }
    } catch (e) {
      if (isAbortError(e) || signal.aborted) throw abortError();
      throw new BoardApiError('network', 'The connection to lichess was interrupted');
    }
  }

  return {
    streamEvents: (signal) => stream(() => '/api/stream/event', signal, parseLichessEvent),
    streamGame: (gameId, signal) => stream(() => `/api/board/game/stream/${checkId(gameId)}`, signal, parseGameStreamEvent),

    seek(params, outer) {
      const ctl = new AbortController();
      const onOuter = () => ctl.abort();
      outer?.addEventListener('abort', onOuter, { once: true });
      const fields: Record<string, string | number | boolean> = {
        rated: params.rated,
        time: params.time,
        increment: params.increment,
        variant: 'standard',
        color: params.color,
      };
      if (params.ratingRange) fields.ratingRange = params.ratingRange;
      const done = (async () => {
        try {
          const res = await post('/api/board/seek', form(fields), ctl.signal);
          // The response stays open while the seek is pending; drain it until lichess closes it.
          if (res.body) for await (const _ of readNdjson(res.body, ctl.signal)) void _;
        } catch (e) {
          if (ctl.signal.aborted || isAbortError(e)) return;
          throw e instanceof BoardApiError ? e : new BoardApiError('network', 'The connection to lichess was interrupted');
        } finally {
          outer?.removeEventListener('abort', onOuter);
        }
      })();
      return { done, cancel: () => ctl.abort() };
    },

    async challengeUser(username, p) {
      const name = username.trim();
      if (!USERNAME.test(name)) throw new BoardApiError('bad_request', 'Enter a valid lichess username');
      const res = await post(
        `/api/challenge/${encodeURIComponent(name)}`,
        form({
          rated: p.rated,
          'clock.limit': p.clock.limit,
          'clock.increment': p.clock.increment,
          color: p.color,
          variant: 'standard',
        }),
      );
      const j = (await res.json().catch(() => null)) as unknown;
      const c = parseChallenge(isObj(j) && isObj(j.challenge) ? j.challenge : j);
      if (!c) throw new BoardApiError('bad_request', 'Unexpected response from lichess');
      return c;
    },

    async challengeAi(level, clock, colorChoice = 'random') {
      const lvl = Math.min(8, Math.max(1, Math.round(level)));
      const res = await post(
        '/api/challenge/ai',
        form({
          level: lvl,
          'clock.limit': clock.limit,
          'clock.increment': clock.increment,
          color: colorChoice,
          variant: 'standard',
        }),
      );
      const j = (await res.json().catch(() => null)) as unknown;
      const id = isObj(j) ? str(j.id) : undefined;
      if (!id) throw new BoardApiError('bad_request', 'Unexpected response from lichess');
      return id;
    },

    cancelChallenge: async (id) => postOk(`/api/challenge/${checkId(id)}/cancel`),
    acceptChallenge: async (id) => postOk(`/api/challenge/${checkId(id)}/accept`),
    declineChallenge: async (id, reason) =>
      postOk(`/api/challenge/${checkId(id)}/decline`, reason ? form({ reason }) : undefined),

    async move(gameId, uci, opts = {}) {
      if (!UCI.test(uci)) throw new BoardApiError('bad_request', `Invalid move ${uci}`);
      const q = opts.offeringDraw ? '?offeringDraw=true' : '';
      return postOk(`/api/board/game/${checkId(gameId)}/move/${uci}${q}`);
    },
    abort: async (gameId) => postOk(`/api/board/game/${checkId(gameId)}/abort`),
    resign: async (gameId) => postOk(`/api/board/game/${checkId(gameId)}/resign`),
    draw: async (gameId, accept) => postOk(`/api/board/game/${checkId(gameId)}/draw/${accept ? 'yes' : 'no'}`),
    claimVictory: async (gameId) => postOk(`/api/board/game/${checkId(gameId)}/claim-victory`),

    async ongoingGames() {
      const res = await send('/api/account/playing?nb=20', { headers: { Accept: 'application/json' } });
      const j = (await res.json().catch(() => null)) as unknown;
      const list = isObj(j) && Array.isArray(j.nowPlaying) ? j.nowPlaying : [];
      return list.map(parseGameInfo).filter((g): g is GameInfo => g !== null);
    },
  };
}
