import { describe, expect, it, vi } from 'vitest';
import { LichessError, createLichessFetcher } from './lichess.js';

const BASE = 'http://127.0.0.1:8581/lichess/';
const TOKEN = 'lio_secretsecretsecret';

function fetcher(impl: (url: string, init: RequestInit) => Promise<Response>, timeoutMs = 5_000) {
  const fake = vi.fn(impl);
  return {
    fake,
    get: createLichessFetcher({ baseUrl: BASE, timeoutMs, fetch: fake as unknown as typeof fetch }),
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function failure(p: Promise<unknown>): Promise<LichessError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(LichessError);
    expect((err as Error).message).not.toContain(TOKEN);
    return err as LichessError;
  }
  throw new Error('expected a rejection');
}

describe('lichess account fetcher (through the loopback egress proxy)', () => {
  it('GETs <base>api/account with the bearer token and keeps only id and username', async () => {
    const { fake, get } = fetcher(async () =>
      json({ id: 'Bojan', username: 'Bojan', perfs: {}, email: 'never@kept' }),
    );
    expect(await get(TOKEN)).toEqual({ id: 'bojan', username: 'Bojan' });
    const [url, init] = fake.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8581/lichess/api/account');
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('401/403 and closed accounts are rejected; other answers are unavailable', async () => {
    expect((await failure(fetcher(async () => json({}, 401)).get(TOKEN))).kind).toBe('rejected');
    expect((await failure(fetcher(async () => json({}, 403)).get(TOKEN))).kind).toBe('rejected');
    expect(
      (
        await failure(
          fetcher(async () => json({ id: 'x', username: 'x', disabled: true })).get(TOKEN),
        )
      ).kind,
    ).toBe('rejected');
    expect((await failure(fetcher(async () => json({}, 500)).get(TOKEN))).kind).toBe('unavailable');
    expect((await failure(fetcher(async () => json({ id: 'a b' })).get(TOKEN))).kind).toBe(
      'unavailable',
    );
    expect(
      (await failure(fetcher(async () => new Response('<html>', { status: 200 })).get(TOKEN))).kind,
    ).toBe('unavailable');
    expect(
      (
        await failure(
          fetcher(async () => new Response('x'.repeat(300_000), { status: 200 })).get(TOKEN),
        )
      ).kind,
    ).toBe('unavailable');
    expect(
      (await failure(fetcher(async () => Promise.reject(new TypeError('ECONNREFUSED'))).get(TOKEN)))
        .kind,
    ).toBe('unavailable');
  });

  it('times out after timeoutMs', async () => {
    const { get } = fetcher(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
      50,
    );
    const started = Date.now();
    const err = await failure(get(TOKEN));
    expect(err.kind).toBe('unavailable');
    expect(err.message).toMatch(/in time/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
