import { describe, expect, it } from 'vitest';
import {
  TABLES_MAX_BYTES,
  TableEntrySchema,
  TablesManifestSchema,
  packBytes,
  tableFileName,
  tablesFor,
  type TablesManifest,
} from './manifest.js';

const sha = (c: string) => c.repeat(64);

const manifest: TablesManifest = {
  format: 1,
  source: 'https://tablebase.lichess.ovh/tables/standard/',
  tables: [
    { name: 'KQvK', kind: 'wdl', bytes: 272, sha256: sha('a'), pack: 'core' },
    { name: 'KRvKP', kind: 'dtz', bytes: 193_000, sha256: sha('b'), pack: 'core' },
    { name: 'KRvKP', kind: 'wdl', bytes: 179_000, sha256: sha('c'), pack: 'core' },
    { name: 'KRPvKR', kind: 'wdl', bytes: 16_400_000, sha256: sha('d'), pack: 'rook' },
  ],
};

describe('TablesManifestSchema', () => {
  it('accepts a format-1 manifest', () => {
    expect(TablesManifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('rejects duplicates, non-canonical names, bad digests and other formats', () => {
    const t = manifest.tables;
    expect(TablesManifestSchema.safeParse({ ...manifest, tables: [...t, t[0]] }).success).toBe(
      false,
    );
    expect(
      TablesManifestSchema.safeParse({ ...manifest, tables: [{ ...t[0]!, name: 'KvKQ' }] }).success,
    ).toBe(false);
    expect(TablesManifestSchema.safeParse({ ...manifest, format: 2 }).success).toBe(false);
    expect(TableEntrySchema.safeParse({ ...t[0]!, sha256: 'ABC' }).success).toBe(false);
    expect(TableEntrySchema.safeParse({ ...t[0]!, kind: 'dtm' }).success).toBe(false);
    expect(TableEntrySchema.safeParse({ ...t[0]!, pack: 'queen' }).success).toBe(false);
    expect(TableEntrySchema.safeParse({ ...t[0]!, bytes: 0 }).success).toBe(false);
  });
});

describe('tablesFor / tableFileName / packBytes', () => {
  it('finds the entries of one material in either side order, WDL first', () => {
    expect(tablesFor('KPvKR', manifest).map(tableFileName)).toEqual(['KRvKP.rtbw', 'KRvKP.rtbz']);
    expect(tablesFor('KRvKP', manifest)).toHaveLength(2);
    expect(tablesFor('KRPvKR', manifest).map((e) => e.kind)).toEqual(['wdl']);
    expect(tablesFor('KBNvK', manifest)).toEqual([]);
  });

  it('names files .rtbw / .rtbz', () => {
    expect(tableFileName({ name: 'KQvK', kind: 'wdl' })).toBe('KQvK.rtbw');
    expect(tableFileName({ name: 'KQvK', kind: 'dtz' })).toBe('KQvK.rtbz');
  });

  it('sums a pack; the core budget is 1,000,000 bytes', () => {
    expect(TABLES_MAX_BYTES).toBe(1_000_000);
    expect(packBytes(manifest, 'core')).toBe(372_272);
    expect(packBytes(manifest, 'rook')).toBe(16_400_000);
    expect(packBytes(manifest, 'core')).toBeLessThanOrEqual(TABLES_MAX_BYTES);
  });
});
