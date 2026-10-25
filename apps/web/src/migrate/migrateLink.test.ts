import { deflateRawSync } from 'node:zlib';
import { ROOM_BOUNDS } from '@daisychess/engine-core';
import { describe, expect, it, vi } from 'vitest';
import {
  consumeMigrateLink,
  decodeMigratePayload,
  fromLegacyOrigin,
  importItems,
  isValidItem,
  MAX_ROOM_SEATS,
  MIGRATE_HASH_PREFIX,
  MIGRATED_NOTICE,
  migrationNotice,
  ruleFor,
  safeFollowUpHash,
  type KeyValueStorage,
} from './migrateLink';

const ROOM = 'AbCdEfGhIjKlMnOpQrStUv';
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const packJson = (o: unknown) => `1.${b64url(deflateRawSync(Buffer.from(JSON.stringify(o))))}`;
const plainJson = (o: unknown) => `0.${b64url(Buffer.from(JSON.stringify(o)))}`;

class MemStorage implements KeyValueStorage {
  map = new Map<string, string>();
  constructor(init: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(init)) this.map.set(k, v);
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const settings = JSON.stringify({ boardTheme: 'green', serverToken: 'dc1_ABCD_SECRET' });
const lichess = JSON.stringify({ token: 'lip_x', username: 'bojan' });

function deps(hash: string, opts: { referrer?: string; storage?: KeyValueStorage } = {}) {
  const replaceState = vi.fn();
  return {
    replaceState,
    d: {
      location: { hash, pathname: '/', search: '?x=1' },
      history: { replaceState, state: { s: 1 } },
      referrer: opts.referrer ?? 'https://c.referee.at/',
      storage: 'storage' in opts ? opts.storage : new MemStorage(),
    },
  };
}

describe('allow-list', () => {
  it('knows the migratable keys and nothing else', () => {
    for (const k of [
      'daisychess.settings',
      'daisychess.lichess',
      'daisychess.trainer',
      'daisychess.theme',
      `daisychess.room.${ROOM}`,
    ]) {
      expect(ruleFor(k)).not.toBeNull();
    }
    for (const k of [
      'daisychess.lichess.pkce',
      'daisychess.portal.pkce',
      'daisychess.room.short',
      'daisychess.room.',
      'chesslab.settings',
      'evil',
      '__proto__',
      'constructor',
    ]) {
      expect(ruleFor(k)).toBeNull();
    }
  });

  it('uses the protocol room id pattern', () => {
    expect(ROOM_BOUNDS.roomIdPattern.test(ROOM)).toBe(true);
    expect(ruleFor(`daisychess.room.${'a'.repeat(15)}`)).toBeNull();
    expect(ruleFor(`daisychess.room.${'a'.repeat(65)}`)).toBeNull();
  });

  it('checks values per key', () => {
    expect(isValidItem('daisychess.theme', 'dark')).toBe(true);
    expect(isValidItem('daisychess.theme', 'purple')).toBe(false);
    expect(isValidItem('daisychess.fullBuildConfirmed', '1')).toBe(true);
    expect(isValidItem('daisychess.fullBuildConfirmed', 'yes')).toBe(false);
    expect(isValidItem('daisychess.settings', settings)).toBe(true);
    expect(isValidItem('daisychess.settings', 'not json')).toBe(false);
    expect(isValidItem('daisychess.settings', '42')).toBe(false);
    expect(isValidItem('daisychess.settings', 'null')).toBe(false);
    expect(isValidItem('daisychess.nick', 'Bojan')).toBe(true);
    expect(isValidItem('daisychess.nick', 'a\nb')).toBe(false);
    expect(isValidItem('daisychess.nick', '')).toBe(false);
    expect(isValidItem('daisychess.settings', 5)).toBe(false);
  });

  it('enforces the size caps', () => {
    const big = JSON.stringify({ x: 'a'.repeat(9_000) });
    expect(isValidItem('daisychess.settings', big)).toBe(false);
    expect(isValidItem('daisychess.trainer', big)).toBe(true);
    expect(isValidItem('daisychess.trainer', JSON.stringify({ x: 'a'.repeat(270_000) }))).toBe(
      false,
    );
    expect(isValidItem('daisychess.nick', 'n'.repeat(65))).toBe(false);
  });
});

describe('decodeMigratePayload', () => {
  const obj = {
    v: 1,
    items: { 'daisychess.theme': 'dark' },
    dropped: ['daisychess.trainer', 'bogus'],
    hash: `#/room/${ROOM}`,
  };

  it('decodes compressed and plain payloads', () => {
    for (const raw of [packJson(obj), plainJson(obj)]) {
      expect(decodeMigratePayload(raw)).toEqual({
        items: { 'daisychess.theme': 'dark' },
        dropped: ['daisychess.trainer'],
        hash: `#/room/${ROOM}`,
      });
    }
  });

  it('rejects malformed payloads', () => {
    expect(decodeMigratePayload('')).toBeNull();
    expect(decodeMigratePayload('1')).toBeNull();
    expect(decodeMigratePayload('2.AAAA')).toBeNull();
    expect(decodeMigratePayload('1.!!!')).toBeNull();
    expect(decodeMigratePayload('1.AAAA')).toBeNull(); // not deflate
    expect(decodeMigratePayload(plainJson({ v: 2, items: {} }))).toBeNull();
    expect(decodeMigratePayload(plainJson({ v: 1, items: [] }))).toBeNull();
    expect(decodeMigratePayload(plainJson([1]))).toBeNull();
    expect(decodeMigratePayload(`0.${b64url(Buffer.from([0xc3, 0x28]))}`)).toBeNull(); // bad UTF-8
    expect(decodeMigratePayload(`0.${'A'.repeat(40_000)}`)).toBeNull(); // too long
  });

  it('refuses a decompression bomb', () => {
    const bomb = `1.${b64url(deflateRawSync(Buffer.from(`{"v":1,"items":{"a":"${'a'.repeat(2_000_000)}"}}`)))}`;
    expect(bomb.length).toBeLessThan(32_768);
    expect(decodeMigratePayload(bomb)).toBeNull();
  });

  it('keeps only string values and safe follow-up routes', () => {
    const p = decodeMigratePayload(
      plainJson({ v: 1, items: { a: 'x', b: 3 }, hash: 'javascript:alert(1)' }),
    );
    expect(p).toEqual({ items: { a: 'x' }, dropped: [], hash: '' });
    expect(safeFollowUpHash('#setup-token=dc1_AB%2BCD')).toBe('#setup-token=dc1_AB%2BCD');
    expect(safeFollowUpHash('#/room/abc')).toBe('#/room/abc');
    expect(safeFollowUpHash('#migrate=1.AAAA')).toBe('');
    expect(safeFollowUpHash('#/room/<script>')).toBe('');
  });
});

describe('importItems', () => {
  it('imports valid items, keeps existing ones, rejects the rest', () => {
    const storage = new MemStorage({ 'daisychess.theme': 'light' });
    const res = importItems(storage, {
      items: {
        'daisychess.settings': settings,
        'daisychess.theme': 'dark',
        'daisychess.lichess': lichess,
        'daisychess.lichess.pkce': '{}',
        'daisychess.analysis': 'broken',
        other: 'x',
      },
      dropped: [],
      hash: '',
    });
    expect(res.imported.sort()).toEqual(['daisychess.lichess', 'daisychess.settings']);
    expect(res.kept).toEqual(['daisychess.theme']);
    expect(res.rejected.sort()).toEqual([
      'daisychess.analysis',
      'daisychess.lichess.pkce',
      'other',
    ]);
    expect(storage.getItem('daisychess.theme')).toBe('light'); // never overwritten
    expect(storage.getItem('daisychess.settings')).toBe(settings);
    expect(storage.getItem('other')).toBeNull();
  });

  it('caps the number of room seats', () => {
    const items: Record<string, string> = {};
    for (let i = 0; i < MAX_ROOM_SEATS + 5; i++)
      items[`daisychess.room.${String(i).padStart(16, 'r')}`] = '{"playerToken":"t"}';
    const res = importItems(new MemStorage(), { items, dropped: [], hash: '' });
    expect(res.imported).toHaveLength(MAX_ROOM_SEATS);
    expect(res.rejected).toHaveLength(5);
  });

  it('survives a full storage', () => {
    const storage: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    };
    const res = importItems(storage, {
      items: { 'daisychess.theme': 'dark' },
      dropped: [],
      hash: '',
    });
    expect(res).toMatchObject({ imported: [], rejected: ['daisychess.theme'] });
  });
});

describe('migrationNotice', () => {
  it('names what was dropped, nothing when nothing moved', () => {
    expect(
      migrationNotice({ imported: ['daisychess.theme'], kept: [], rejected: [], dropped: [] }),
    ).toBe(MIGRATED_NOTICE);
    expect(
      migrationNotice({
        imported: ['daisychess.theme'],
        kept: [],
        rejected: [],
        dropped: ['daisychess.trainer', 'daisychess.analysis'],
      }),
    ).toBe(`${MIGRATED_NOTICE} (not moved: trainer schedule, analysis settings)`);
    expect(
      migrationNotice({ imported: [], kept: ['daisychess.theme'], rejected: [], dropped: [] }),
    ).toBeNull();
  });
});

describe('fromLegacyOrigin', () => {
  it('accepts only the legacy origin', () => {
    expect(fromLegacyOrigin('https://c.referee.at/')).toBe(true);
    expect(fromLegacyOrigin('https://c.referee.at')).toBe(true);
    expect(fromLegacyOrigin('http://c.referee.at/')).toBe(false);
    expect(fromLegacyOrigin('https://c.referee.at.evil.example/')).toBe(false);
    expect(fromLegacyOrigin('https://evil.example/?https://c.referee.at')).toBe(false);
    expect(fromLegacyOrigin('')).toBe(false);
  });
});

describe('consumeMigrateLink', () => {
  const payload = { v: 1, items: { 'daisychess.settings': settings, 'daisychess.theme': 'dark' } };

  it('ignores other fragments', () => {
    const { d, replaceState } = deps('#/room/x');
    expect(consumeMigrateLink(d)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('imports, strips the fragment and returns the notice', () => {
    const storage = new MemStorage();
    const { d, replaceState } = deps(MIGRATE_HASH_PREFIX + packJson(payload), { storage });
    const out = consumeMigrateLink(d);
    expect(out).toMatchObject({ status: 'imported', notice: MIGRATED_NOTICE });
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/?x=1');
    expect(storage.getItem('daisychess.settings')).toBe(settings);
  });

  it('carries a follow-up route over', () => {
    const { d, replaceState } = deps(
      MIGRATE_HASH_PREFIX + packJson({ ...payload, hash: '#setup-token=dc1_A_B' }),
    );
    consumeMigrateLink(d);
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/?x=1#setup-token=dc1_A_B');
  });

  it('does not import from a foreign referrer (crafted link), but strips the fragment', () => {
    const storage = new MemStorage();
    for (const referrer of ['', 'https://evil.example/']) {
      const { d, replaceState } = deps(
        MIGRATE_HASH_PREFIX + packJson({ ...payload, hash: '#/room/x' }),
        { storage, referrer },
      );
      expect(consumeMigrateLink(d)).toMatchObject({ status: 'foreign-referrer', notice: null });
      expect(replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/?x=1');
    }
    expect(storage.map.size).toBe(0);
  });

  it('strips an invalid payload silently', () => {
    const { d, replaceState } = deps(`${MIGRATE_HASH_PREFIX}garbage`);
    expect(consumeMigrateLink(d)).toMatchObject({ status: 'invalid', notice: null });
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/?x=1');
  });

  it('reports nothing new when every key exists already', () => {
    const storage = new MemStorage({ 'daisychess.settings': '{}', 'daisychess.theme': 'light' });
    const { d } = deps(MIGRATE_HASH_PREFIX + plainJson(payload), { storage });
    expect(consumeMigrateLink(d)).toMatchObject({ status: 'nothing-new', notice: null });
    expect(storage.getItem('daisychess.settings')).toBe('{}');
  });

  it('copes without storage and without history', () => {
    const { d } = deps(MIGRATE_HASH_PREFIX + plainJson(payload), { storage: undefined });
    d.history.replaceState.mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(consumeMigrateLink(d)).toMatchObject({ status: 'no-storage' });
  });
});
