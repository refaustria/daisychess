import { describe, expect, it } from 'vitest';
import { normalizeMaterialKey } from '../material.js';
import {
  DRAWN_WITHOUT_TABLE,
  isTableName,
  normalizeTableName,
  recalcKey,
  requiredTables,
  tableClosure,
} from './names.js';

describe('normalizeTableName', () => {
  it('puts the stronger side first like python-chess', () => {
    expect(normalizeTableName('KPvKR')).toBe('KRvKP');
    expect(normalizeTableName('KvKQ')).toBe('KQvK');
    expect(normalizeTableName('KRvKRP')).toBe('KRPvKR');
    expect(normalizeTableName('KPRvKR')).toBe('KRPvKR');
    expect(normalizeTableName('KNvKB')).toBe('KBvKN');
    expect(normalizeTableName('KRvKR')).toBe('KRvKR');
  });

  it('mirrors on request', () => {
    expect(normalizeTableName('KRPvKR', true)).toBe('KRvKRP');
    expect(normalizeTableName('KRvKR', true)).toBe('KRvKR');
  });

  it('agrees with normalizeMaterialKey of the material module', () => {
    for (const k of ['KPvKR', 'KvKQ', 'KRvKRP', 'KBNvKQ', 'KPPvKRP', 'KQRvKQ']) {
      expect(normalizeTableName(k)).toBe(normalizeMaterialKey(k));
    }
  });
});

describe('isTableName', () => {
  it('accepts canonical one-king names with up to 7 pieces only', () => {
    expect(isTableName('KQvK')).toBe(true);
    expect(isTableName('KRPvKR')).toBe(true);
    expect(isTableName('KvK')).toBe(false);
    expect(isTableName('KvKQ')).toBe(false); // not canonical
    expect(isTableName('KQQQQvKQQ')).toBe(false); // 9 pieces
    expect(isTableName('KKvK')).toBe(false);
    expect(isTableName('QvK')).toBe(false);
    expect(isTableName('KQvK.rtbw')).toBe(false);
  });
});

describe('recalcKey', () => {
  it('builds the key from table piece codes (colour bit 8)', () => {
    // White K, Q; Black K
    expect(recalcKey([6, 5, 14])).toBe('KQvK');
    expect(recalcKey([6, 5, 14], true)).toBe('KvKQ');
    expect(recalcKey([14, 12, 6, 4, 1])).toBe('KRPvKR');
  });
});

describe('tableClosure / requiredTables', () => {
  it('lists everything reachable by captures and promotions from KRPvKR', () => {
    expect(new Set(tableClosure('KRPvKR'))).toEqual(
      new Set([
        'KRPvKR',
        'KQRvKR',
        'KRRvKR',
        'KRBvKR',
        'KRNvKR',
        'KRvKR',
        'KRPvK',
        'KRvKP',
        'KQRvK',
        'KQvKR',
        'KRRvK',
        'KRBvK',
        'KRvKB',
        'KRNvK',
        'KRvKN',
        'KRvK',
        'KQvK',
        'KPvK',
        'KBvK',
        'KNvK',
      ]),
    );
    expect(tableClosure('KRvKP')[0]).toBe('KRvKP');
    expect(tableClosure('KPvKR')[0]).toBe('KRvKP');
  });

  it('covers the promotions of the defending side (KQvKP)', () => {
    expect(new Set(requiredTables('KQvKP'))).toEqual(
      new Set(['KQvKP', 'KQvKQ', 'KQvKR', 'KQvKB', 'KQvKN', 'KQvK', 'KPvK', 'KRvK']),
    );
  });

  it('leaves out the materials drawn without a table', () => {
    expect(requiredTables('KBNvK')).toEqual(['KBNvK']);
    expect(tableClosure('KBNvK')).toEqual(['KBNvK', 'KNvK', 'KBvK']);
    expect([...DRAWN_WITHOUT_TABLE].sort()).toEqual(['KBvK', 'KNvK']);
    expect(requiredTables('KQvK')).toEqual(['KQvK']);
  });
});
