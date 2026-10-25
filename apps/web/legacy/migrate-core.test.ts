// @vitest-environment jsdom
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { decodeMigratePayload, MIGRATE_HASH_PREFIX } from '../src/migrate/migrateLink';
import {
  buildMigrateUrl,
  collectItems,
  dropOrder,
  encodePayload,
  followUpHash,
  MAX_FRAGMENT_LENGTH,
  run,
  TARGET_ORIGIN,
  type CompressionStreamCtor,
  type LegacyStorage,
} from './migrate-core.js';

const CS = globalThis.CompressionStream as unknown as CompressionStreamCtor;
const ROOM = 'AbCdEfGhIjKlMnOpQrStUv';

function storageOf(init: Record<string, string>): LegacyStorage {
  const keys = Object.keys(init);
  return { length: keys.length, key: (i) => keys[i] ?? null, getItem: (k) => init[k] ?? null };
}

/** Incompressible text of length `n`, so payload sizes are predictable. */
const noise = (n: number): string => randomBytes(n).toString('base64').slice(0, n);

const decodeUrl = (url: string) => {
  const hash = new URL(url).hash;
  expect(hash.startsWith(MIGRATE_HASH_PREFIX)).toBe(true);
  return decodeMigratePayload(hash.slice(MIGRATE_HASH_PREFIX.length));
};

describe('legacy page: collectItems', () => {
  it('takes daisychess.* except round-trip keys', () => {
    expect(
      collectItems(
        storageOf({
          'daisychess.theme': 'dark',
          'daisychess.lichess.pkce': '{}',
          'chesslab.x': '1',
          other: '2',
        }),
      ),
    ).toEqual({ 'daisychess.theme': 'dark' });
  });

  it('survives blocked storage', () => {
    const blocked: LegacyStorage = {
      get length(): number {
        throw new DOMException('blocked', 'SecurityError');
      },
      key: () => null,
      getItem: () => null,
    };
    expect(collectItems(blocked)).toEqual({});
    expect(collectItems(undefined)).toEqual({});
  });
});

describe('legacy page: dropOrder', () => {
  it('drops other keys largest first, then the trainer schedule, then rooms; never essentials', () => {
    const order = dropOrder({
      'daisychess.settings': 'x'.repeat(5_000),
      'daisychess.lichess': '{}',
      'daisychess.trainer': 'x'.repeat(90_000),
      'daisychess.analysis': 'x'.repeat(300),
      'daisychess.play': 'x'.repeat(3_000),
      [`daisychess.room.${ROOM}`]: '{}',
    });
    expect(order).toEqual([
      'daisychess.play',
      'daisychess.analysis',
      'daisychess.trainer',
      `daisychess.room.${ROOM}`,
    ]);
  });
});

describe('legacy page: followUpHash', () => {
  it('keeps room and setup routes only', () => {
    expect(followUpHash(`#/room/${ROOM}`)).toBe(`#/room/${ROOM}`);
    expect(followUpHash('#setup-token=dc1_A%2BB')).toBe('#setup-token=dc1_A%2BB');
    expect(followUpHash('#<img>')).toBe('');
    expect(followUpHash('')).toBe('');
  });
});

describe('legacy page: encodePayload', () => {
  it('compresses when it helps, falls back to plain JSON without deflate-raw', async () => {
    const obj = { v: 1, items: { 'daisychess.settings': JSON.stringify({ a: 'b'.repeat(500) }) } };
    expect(await encodePayload(obj, CS)).toMatch(/^1\./);
    expect(await encodePayload(obj, undefined)).toMatch(/^0\./);
    const Broken = class {
      constructor() {
        throw new TypeError('unsupported format');
      }
    } as unknown as CompressionStreamCtor;
    expect(await encodePayload(obj, Broken)).toMatch(/^0\./);
    expect(decodeMigratePayload((await encodePayload(obj, undefined)).toString())?.items).toEqual(
      obj.items,
    );
  });
});

describe('legacy page: buildMigrateUrl', () => {
  const base = {
    'daisychess.settings': JSON.stringify({ boardTheme: 'green', serverToken: 'dc1_ABCD_SECRET' }),
    'daisychess.lichess': JSON.stringify({ token: 'lip_x', username: 'bojan' }),
    'daisychess.theme': 'dark',
    'daisychess.lichess.pkce': '{"verifier":"v"}',
  };

  it('round-trips into the app importer (compressed), with the follow-up route', async () => {
    const { url, dropped } = await buildMigrateUrl({
      storage: storageOf(base),
      hash: `#/room/${ROOM}`,
      CompressionStream: CS,
    });
    expect(url.startsWith(`${TARGET_ORIGIN}/#migrate=1.`)).toBe(true);
    expect(dropped).toEqual([]);
    const p = decodeUrl(url);
    expect(p?.items).toEqual({
      'daisychess.settings': base['daisychess.settings'],
      'daisychess.lichess': base['daisychess.lichess'],
      'daisychess.theme': 'dark',
    });
    expect(p?.hash).toBe(`#/room/${ROOM}`);
  });

  it('round-trips without CompressionStream', async () => {
    const { url } = await buildMigrateUrl({
      storage: storageOf(base),
      hash: '',
      CompressionStream: undefined,
    });
    expect(url.startsWith(`${TARGET_ORIGIN}/#migrate=0.`)).toBe(true);
    expect(decodeUrl(url)?.items['daisychess.theme']).toBe('dark');
  });

  it('redirects without a payload when there is nothing to move', async () => {
    expect(
      await buildMigrateUrl({
        storage: storageOf({}),
        hash: '#setup-token=dc1_A_B',
        CompressionStream: CS,
      }),
    ).toEqual({
      url: `${TARGET_ORIGIN}/#setup-token=dc1_A_B`,
      dropped: [],
      moved: [],
    });
  });

  it('stays under the URL limit: drops the largest non-essential keys, the trainer schedule last', async () => {
    const storage = storageOf({
      ...base,
      'daisychess.analysis': JSON.stringify({ n: noise(9_000) }),
      'daisychess.play': JSON.stringify({ n: noise(200) }),
      'daisychess.trainer': JSON.stringify({ n: noise(17_000) }),
    });
    const { url, dropped, moved } = await buildMigrateUrl({
      storage,
      hash: '',
      CompressionStream: CS,
    });
    expect(new URL(url).hash.length).toBeLessThanOrEqual(MAX_FRAGMENT_LENGTH);
    expect(dropped[0]).toBe('daisychess.analysis');
    expect(dropped).toContain('daisychess.trainer');
    expect(dropped.indexOf('daisychess.trainer')).toBe(dropped.length - 1);
    expect(moved).toContain('daisychess.settings');
    expect(moved).toContain('daisychess.lichess');
    const p = decodeUrl(url);
    expect(p?.dropped).toEqual(dropped);
    expect(Object.keys(p?.items ?? {})).toEqual(moved);
  });

  it('keeps the trainer schedule when dropping the others is enough', async () => {
    const storage = storageOf({
      ...base,
      'daisychess.analysis': JSON.stringify({ n: noise(14_000) }),
      'daisychess.trainer': JSON.stringify({ n: noise(3_000) }),
    });
    const { dropped, moved } = await buildMigrateUrl({ storage, hash: '', CompressionStream: CS });
    expect(dropped).toEqual(['daisychess.analysis']);
    expect(moved).toContain('daisychess.trainer');
  });

  it('gives up on the payload when even the essentials do not fit', async () => {
    const { url, moved } = await buildMigrateUrl({
      storage: storageOf(base),
      hash: '',
      CompressionStream: CS,
      maxFragment: 40,
    });
    expect(url).toBe(`${TARGET_ORIGIN}/`);
    expect(moved).toEqual([]);
  });
});

describe('legacy page: run', () => {
  it('replaces the location with the migrate URL', async () => {
    const replace = vi.fn();
    const target = await run({
      localStorage: storageOf({ 'daisychess.theme': 'dark' }),
      location: { hash: '', replace },
      CompressionStream: CS,
    });
    expect(replace).toHaveBeenCalledWith(target);
    expect(decodeUrl(target)?.items).toEqual({ 'daisychess.theme': 'dark' });
  });

  it('still redirects when storage access throws', async () => {
    const replace = vi.fn();
    const win = {
      get localStorage(): LegacyStorage {
        throw new DOMException('blocked', 'SecurityError');
      },
      location: { hash: '', replace },
    };
    await run(win);
    expect(replace).toHaveBeenCalledWith(`${TARGET_ORIGIN}/`);
  });

  it('works as a jsdom page script (index.html loads moved.js as a module, no inline script)', () => {
    const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8');
    document.documentElement.innerHTML = html;
    const scripts = [...document.querySelectorAll('script')];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.getAttribute('src')).toBe('/moved.js');
    expect(scripts[0]?.getAttribute('type')).toBe('module');
    expect(scripts[0]?.textContent).toBe('');
    expect(document.querySelector('a')?.getAttribute('href')).toBe(`${TARGET_ORIGIN}/`);
    expect(html).not.toMatch(/style=/);
  });
});
