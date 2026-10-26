import { describe, expect, it, vi } from 'vitest';
import {
  BoardApiError,
  createBoardApi,
  parseGameStreamEvent,
  parseLichessEvent,
  readNdjson,
  type LichessFetch,
} from './boardApi';

const enc = new TextEncoder();

function bodyOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch);
      c.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Headers;
}

function fakeFetch(respond: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: LichessFetch = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({
      url: input,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
      headers: new Headers(init?.headers),
    });
    return respond(input);
  });
  return { fetch, calls };
}

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('readNdjson', () => {
  it('skips keep-alive blank lines and joins lines split across chunks', async () => {
    const out = await collect(
      readNdjson(bodyOf(['\n', '{"type":"ga', 'meState","moves":"e2e4"}\n\n', '\n{"a":1}\n{"b":', '2}'])),
    );
    expect(out).toEqual([{ type: 'gameState', moves: 'e2e4' }, { a: 1 }, { b: 2 }]);
  });

  it('decodes a multi-byte character split between chunks and skips malformed lines', async () => {
    const bytes = enc.encode('{"text":"Zürich ♞"}\n');
    const cut = bytes.indexOf(0xc3) + 1; // in the middle of "ü"
    const out = await collect(readNdjson(bodyOf(['not json\n', bytes.slice(0, cut), bytes.slice(cut)])));
    expect(out).toEqual([{ text: 'Zürich ♞' }]);
  });

  it('stops with an AbortError when the signal aborts', async () => {
    const ctl = new AbortController();
    let push!: (s: string) => void;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        push = (s) => c.enqueue(enc.encode(s));
      },
    });
    const it = readNdjson(body, ctl.signal)[Symbol.asyncIterator]();
    push('{"x":1}\n');
    expect((await it.next()).value).toEqual({ x: 1 });
    const next = it.next();
    ctl.abort();
    await expect(next).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('payload parsing', () => {
  it('normalises gameFull (AI opponent, clock, initial state)', () => {
    const e = parseGameStreamEvent({
      type: 'gameFull',
      id: 'abcd1234',
      rated: false,
      speed: 'blitz',
      variant: { key: 'standard' },
      clock: { initial: 300000, increment: 3000 },
      white: { id: 'me', name: 'Me', rating: 1500, title: 'FM' },
      black: { aiLevel: 3 },
      initialFen: 'startpos',
      state: { type: 'gameState', moves: 'e2e4', wtime: 300000, btime: 300000, winc: 3000, binc: 3000, status: 'started' },
    });
    expect(e).toMatchObject({
      type: 'gameFull',
      clock: { initial: 300000, increment: 3000 },
      white: { id: 'me', title: 'FM' },
      black: { name: 'lichess AI level 3', aiLevel: 3 },
      state: { moves: 'e2e4', status: 'started' },
    });
  });

  it('gameFull players keep rating, provisional flag and ratingDiff', () => {
    const e = parseGameStreamEvent({
      type: 'gameFull',
      id: 'abcd1234',
      white: { id: 'me', name: 'Me', rating: 1500, provisional: true, ratingDiff: -6 },
      black: { id: 'bob', name: 'Bob', rating: 1700, title: 'GM' },
      state: { type: 'gameState', moves: '', status: 'started' },
    });
    expect(e).toMatchObject({
      white: { rating: 1500, provisional: true, ratingDiff: -6 },
      black: { rating: 1700, title: 'GM' },
    });
    expect((e as { black: object }).black).not.toHaveProperty('provisional');
  });

  it('ignores unknown or malformed objects', () => {
    expect(parseGameStreamEvent({ type: 'gameFull' })).toBeNull();
    expect(parseGameStreamEvent({ type: 'whatever' })).toBeNull();
    expect(parseLichessEvent({ type: 'gameStart', game: { id: 'x' } })).toBeNull();
    expect(parseLichessEvent(null)).toBeNull();
  });

  it('parses gameStart and challenges', () => {
    expect(
      parseLichessEvent({
        type: 'gameStart',
        game: { gameId: 'g1234567', color: 'black', opponent: { username: 'Bob', rating: 1700 }, rated: true, speed: 'rapid', isMyTurn: false },
      }),
    ).toEqual({
      type: 'gameStart',
      game: { gameId: 'g1234567', color: 'black', opponent: { name: 'Bob', rating: 1700 }, rated: true, speed: 'rapid', isMyTurn: false },
    });
    expect(
      parseLichessEvent({
        type: 'challenge',
        challenge: {
          id: 'c1234567',
          status: 'created',
          challenger: { id: 'bob', name: 'Bob', rating: 1700 },
          destUser: { id: 'me', name: 'Me' },
          rated: false,
          speed: 'blitz',
          variant: { key: 'standard' },
          color: 'random',
          timeControl: { type: 'clock', limit: 300, increment: 3 },
        },
      }),
    ).toMatchObject({ type: 'challenge', challenge: { id: 'c1234567', clock: { limit: 300, increment: 3 } } });
  });
});

describe('createBoardApi', () => {
  it('streams game events from the NDJSON body', async () => {
    const { fetch, calls } = fakeFetch(
      () =>
        new Response(
          bodyOf([
            '{"type":"gameFull","id":"abcd1234","white":{"id":"me","name":"Me"},"black":{"id":"o","name":"O"},"state":{"type":"gameState","moves":"","wtime":1,"btime":1,"status":"started"}}\n',
            '\n',
            '{"type":"gameState","moves":"e2e4","wtime":1,"btime":1,"status":"started"}\n',
            '{"type":"chatLine","username":"o","text":"hi","room":"player"}\n',
          ]),
          { status: 200 },
        ),
    );
    const api = createBoardApi(fetch);
    const events = await collect(api.streamGame('abcd1234', new AbortController().signal));
    expect(events.map((e) => e.type)).toEqual(['gameFull', 'gameState', 'chatLine']);
    expect(calls[0]!.url).toBe('/api/board/game/stream/abcd1234');
    expect(calls[0]!.headers.get('Accept')).toBe('application/x-ndjson');
  });

  it('builds the action requests', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.startsWith('/api/challenge/ai')
        ? ok({ id: 'aigame12' })
        : url.startsWith('/api/challenge/Bob')
          ? ok({ id: 'chal1234', challenger: { id: 'me', name: 'Me' }, destUser: { id: 'bob', name: 'Bob' } })
          : url.startsWith('/api/account/playing')
            ? ok({ nowPlaying: [{ gameId: 'g1234567', color: 'white', opponent: { username: 'X' }, speed: 'rapid' }, { bad: 1 }] })
            : ok(),
    );
    const api = createBoardApi(fetch);
    await api.move('abcd1234', 'e2e4');
    await api.move('abcd1234', 'e7e8q', { offeringDraw: true });
    await api.abort('abcd1234');
    await api.resign('abcd1234');
    await api.draw('abcd1234', true);
    await api.draw('abcd1234', false);
    await api.claimVictory('abcd1234');
    await api.acceptChallenge('chal1234');
    await api.declineChallenge('chal1234');
    await api.cancelChallenge('chal1234');
    expect(await api.challengeAi(9, { limit: 300, increment: 3 }, 'white')).toBe('aigame12');
    expect((await api.challengeUser('Bob', { rated: true, clock: { limit: 180, increment: 2 }, color: 'black' })).id).toBe(
      'chal1234',
    );
    expect(await api.ongoingGames()).toHaveLength(1);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/board/game/abcd1234/move/e2e4',
      'POST /api/board/game/abcd1234/move/e7e8q?offeringDraw=true',
      'POST /api/board/game/abcd1234/abort',
      'POST /api/board/game/abcd1234/resign',
      'POST /api/board/game/abcd1234/draw/yes',
      'POST /api/board/game/abcd1234/draw/no',
      'POST /api/board/game/abcd1234/claim-victory',
      'POST /api/challenge/chal1234/accept',
      'POST /api/challenge/chal1234/decline',
      'POST /api/challenge/chal1234/cancel',
      'POST /api/challenge/ai',
      'POST /api/challenge/Bob',
      'GET /api/account/playing?nb=20',
    ]);
    // Level clamped to 1–8; form-encoded clock fields.
    expect(new URLSearchParams(calls[10]!.body)).toEqual(
      new URLSearchParams('level=8&clock.limit=300&clock.increment=3&color=white&variant=standard'),
    );
    expect(Object.fromEntries(new URLSearchParams(calls[11]!.body))).toMatchObject({
      rated: 'true',
      'clock.limit': '180',
      'clock.increment': '2',
      color: 'black',
    });
  });

  it('rejects invalid ids, moves and usernames without a request', async () => {
    const { fetch, calls } = fakeFetch(() => ok());
    const api = createBoardApi(fetch);
    await expect(api.move('abcd1234', 'e2e9')).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(api.resign('../../x')).rejects.toMatchObject({ kind: 'bad_request' });
    await expect(api.challengeUser('a/b', { rated: false, clock: { limit: 60, increment: 0 }, color: 'random' })).rejects.toMatchObject({
      kind: 'bad_request',
    });
    expect(calls).toHaveLength(0);
  });

  it('keeps the seek request open and cancels it by aborting', async () => {
    let signal: AbortSignal | undefined;
    let body = '';
    const fetch: LichessFetch = async (_input, init) => {
      signal = init?.signal ?? undefined;
      body = String(init?.body);
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
    };
    const api = createBoardApi(fetch);
    const h = api.seek({ rated: true, time: 10, increment: 5, color: 'random' });
    await Promise.resolve();
    await Promise.resolve();
    expect(Object.fromEntries(new URLSearchParams(body))).toEqual({
      rated: 'true',
      time: '10',
      increment: '5',
      variant: 'standard',
      color: 'random',
    });
    expect(signal?.aborted).toBe(false);
    h.cancel();
    await expect(h.done).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });

  it('maps HTTP errors to typed errors', async () => {
    const respond = vi.fn<(url: string) => Response>();
    const api = createBoardApi(fakeFetch(respond).fetch);
    respond.mockReturnValueOnce(new Response('', { status: 401 }));
    await expect(api.resign('abcd1234')).rejects.toMatchObject({ kind: 'unauthorized', message: expect.stringContaining('board:play') });
    respond.mockReturnValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '30' } }));
    await expect(api.resign('abcd1234')).rejects.toMatchObject({ kind: 'rate_limited', retryAfter: 30 });
    respond.mockReturnValueOnce(new Response(JSON.stringify({ error: 'Not your turn, or game already over' }), { status: 400 }));
    await expect(api.move('abcd1234', 'e2e4')).rejects.toMatchObject({
      kind: 'bad_request',
      message: 'Not your turn, or game already over',
    });
    respond.mockReturnValueOnce(new Response(JSON.stringify({ error: { 'clock.limit': ['Too short'] } }), { status: 400 }));
    await expect(api.challengeAi(1, { limit: 1, increment: 0 })).rejects.toMatchObject({ message: 'Too short' });
    respond.mockImplementationOnce(() => {
      throw new TypeError('Failed to fetch');
    });
    const e = await api.abort('abcd1234').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BoardApiError);
    expect(e).toMatchObject({ kind: 'network' });
  });
});
