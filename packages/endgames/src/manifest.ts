import { z } from 'zod';
import { MaterialKeySchema } from './lessons/schema.js';
import { normalizeMaterialKey } from './material.js';

/** Upper bound of the bundled core pack in bytes (ADR-025 §2; also asserted by check-dist). */
export const TABLES_MAX_BYTES = 1_000_000;

export const TableEntrySchema = z.object({
  /** Canonical Syzygy material key, e.g. `KRPvKR`. */
  name: MaterialKeySchema,
  kind: z.enum(['wdl', 'dtz']),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pack: z.enum(['core', 'rook']),
});

/** `packages/endgames/tables.manifest.json` (format 1). */
export const TablesManifestSchema = z
  .object({
    format: z.literal(1),
    source: z.string().min(1),
    tables: z.array(TableEntrySchema),
  })
  .refine((m) => new Set(m.tables.map((t) => `${t.name}.${t.kind}`)).size === m.tables.length, {
    message: 'duplicate table entry',
    path: ['tables'],
  })
  .refine((m) => m.tables.every((t) => normalizeMaterialKey(t.name) === t.name), {
    message: 'table name is not a canonical Syzygy key',
    path: ['tables'],
  });

export type TableEntry = z.infer<typeof TableEntrySchema>;
export type TablesManifest = z.infer<typeof TablesManifestSchema>;
export type TablePack = TableEntry['pack'];

/** File name of a table entry: `KRPvKR.rtbw` (WDL) or `KRPvKR.rtbz` (DTZ). */
export function tableFileName(entry: Pick<TableEntry, 'name' | 'kind'>): string {
  return `${entry.name}.${entry.kind === 'wdl' ? 'rtbw' : 'rtbz'}`;
}

/**
 * The manifest entries of one material (WDL first, then DTZ). `materialKey` may be in either
 * side order (`KPvKR` finds `KRvKP`).
 */
export function tablesFor(materialKey: string, manifest: TablesManifest): TableEntry[] {
  const name = normalizeMaterialKey(materialKey);
  return manifest.tables
    .filter((t) => t.name === name)
    .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'wdl' ? -1 : 1));
}

/** Total bytes of one pack. */
export function packBytes(manifest: TablesManifest, pack: TablePack): number {
  return manifest.tables.filter((t) => t.pack === pack).reduce((sum, t) => sum + t.bytes, 0);
}
