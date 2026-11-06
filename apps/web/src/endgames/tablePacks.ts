/**
 * Syzygy table files and packs (ADR-025 §2, addendum M32-2): the committed manifest, where the
 * files live, SHA-256 verification, and the opt-in pack download into IndexedDB.
 *
 * - The **core** pack ships with the app (`apps/web/public/endgames/v1/`, so it is in `dist` and
 *   `dist-mobile`) and is always read from the bundle ({@link bundledTablesBase}), also inside
 *   the apps, so the trainer works offline out of the box.
 * - The **rook** pack (KRPvKR WDL plus its capture/promotion closure, WDL only) is downloaded on
 *   request from {@link endgamesBase}: `/endgames/v1/` on the web, `VITE_ENDGAMES_URL` or
 *   {@link APP_ENDGAMES_URL} inside the apps (the same origin as the puzzle shards).
 *
 * Every file is verified against the manifest (size and SHA-256) before it is stored and again
 * when the Worker loads it; a mismatch is refused (fail-closed) and nothing is stored.
 */
import {
  packBytes,
  tableFileName,
  TablesManifestSchema,
  type TableEntry,
  type TablePack,
  type TablesManifest,
} from '@daisychess/endgames';
import manifestJson from '../../../../packages/endgames/tables.manifest.json';
import { isNativeApp } from '../platform';
import { deleteStoredTables, putStoredTable, storedTableNames } from './tbCache';
import { verifyTableBytes } from './tbWorker';

export { sha256Hex, sha256HexSync, verifyTableBytes } from './tbWorker';

/** The committed manifest (`packages/endgames/tables.manifest.json`), validated at load. */
export const TABLES_MANIFEST: TablesManifest = TablesManifestSchema.parse(manifestJson);

/** Packs the user downloads on request (the core pack is bundled). */
export const OPT_IN_PACKS: readonly TablePack[] = ['rook'];
export type OptInPack = 'rook';

/** Table files of the apps (ADR-025 §2; `VITE_ENDGAMES_URL` overrides it). */
export const APP_ENDGAMES_URL = 'https://play.daisychess.org/endgames/v1/';
export const FILE_TIMEOUT_MS = 120_000;

const withSlash = (u: string): string => (u.endsWith('/') ? u : `${u}/`);

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
const config: {
  fetch?: FetchFn;
  base?: string;
  bundledBase?: string;
  manifest?: TablesManifest;
} = {};

const manifest = (): TablesManifest => config.manifest ?? TABLES_MANIFEST;

/**
 * Tests: replace `fetch`, the base URLs and the manifest of the pack functions (status,
 * download, delete); `{}` restores the defaults.
 */
export function configureTablePacks(opts: {
  fetch?: FetchFn;
  base?: string;
  bundledBase?: string;
  manifest?: TablesManifest;
}): void {
  config.fetch = opts.fetch;
  config.base = opts.base;
  config.bundledBase = opts.bundledBase;
  config.manifest = opts.manifest;
}

/**
 * Base URL of downloadable table files (ends with `/`): `<origin>/endgames/v1/` on the web;
 * inside the apps (native shell or a non-http(s) origin) `VITE_ENDGAMES_URL` or
 * {@link APP_ENDGAMES_URL}.
 */
export function endgamesBase(): string {
  if (config.base) return withSlash(config.base);
  const loc = globalThis.location as Location | undefined;
  const httpOrigin = loc?.protocol === 'https:' || loc?.protocol === 'http:';
  if (!loc || !httpOrigin || isNativeApp()) {
    return withSlash(import.meta.env.VITE_ENDGAMES_URL || APP_ENDGAMES_URL);
  }
  return new URL('/endgames/v1/', loc.href).href;
}

/** Base URL of the bundled core files: `endgames/v1/` next to the app's `index.html`. */
export function bundledTablesBase(): string {
  if (config.bundledBase) return withSlash(config.bundledBase);
  const loc = globalThis.location as Location | undefined;
  const base = withSlash(import.meta.env.BASE_URL || '/');
  return new URL(`${base}endgames/v1/`, loc?.href ?? 'http://localhost/').href;
}

export function packEntries(pack: TablePack, m: TablesManifest = manifest()): TableEntry[] {
  return m.tables.filter((t) => t.pack === pack);
}

/** File name → manifest entry. */
export const MANIFEST_FILES: ReadonlyMap<string, TableEntry> = new Map(
  TABLES_MANIFEST.tables.map((t) => [tableFileName(t), t]),
);

/** Total download size of a pack in bytes (from the manifest). */
export function packSize(pack: TablePack): number {
  return packBytes(TABLES_MANIFEST, pack);
}

/** "20.9 MB" (decimal megabytes, one decimal; "801 kB" below one megabyte). */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------------------------
// Pack status, download, delete

export type PackState = 'absent' | 'partial' | 'ready';

export interface PackStatus {
  pack: TablePack;
  state: PackState;
  /** Download size of the whole pack (manifest). */
  totalBytes: number;
  /** Bytes of the files already stored. */
  storedBytes: number;
  files: number;
  storedFiles: number;
}

export interface DownloadProgress {
  /** Bytes of the pack stored or received so far. */
  loaded: number;
  total: number;
  /** File being downloaded. */
  file: string;
}

export type PackErrorKind = 'network' | 'integrity' | 'storage' | 'aborted';

export class PackDownloadError extends Error {
  constructor(
    readonly kind: PackErrorKind,
    readonly file: string,
    message: string,
  ) {
    super(message);
    this.name = 'PackDownloadError';
  }
}

/** Stored file names of the manifest (a stale name outside the manifest is ignored). */
export async function storedManifestFiles(): Promise<Set<string>> {
  const names = await storedTableNames();
  const known = new Set(manifest().tables.map(tableFileName));
  return new Set(names.filter((n) => known.has(n)));
}

export async function packStatus(pack: TablePack): Promise<PackStatus> {
  const entries = packEntries(pack);
  const total = entries.reduce((s, e) => s + e.bytes, 0);
  if (pack === 'core') {
    return {
      pack,
      state: 'ready',
      totalBytes: total,
      storedBytes: total,
      files: entries.length,
      storedFiles: entries.length,
    };
  }
  const stored = await storedManifestFiles();
  const have = entries.filter((e) => stored.has(tableFileName(e)));
  const storedBytes = have.reduce((s, e) => s + e.bytes, 0);
  return {
    pack,
    state: have.length === 0 ? 'absent' : have.length === entries.length ? 'ready' : 'partial',
    totalBytes: total,
    storedBytes,
    files: entries.length,
    storedFiles: have.length,
  };
}

const abortErr = (file: string) => new PackDownloadError('aborted', file, 'Download cancelled');

/** Reads a response body into exactly `size` bytes, reporting progress; null when the size differs. */
async function readBody(
  res: Response,
  size: number,
  onChunk: (n: number) => void,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onChunk(buf.byteLength);
    return buf.byteLength === size ? buf : null;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (;;) {
    if (signal.aborted) {
      void reader.cancel().catch(() => undefined);
      throw new DOMException('Aborted', 'AbortError');
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.byteLength > size) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    out.set(value, at);
    at += value.byteLength;
    onChunk(value.byteLength);
  }
  return at === size ? out : null;
}

let downloading: Promise<PackStatus> | null = null;

/**
 * Downloads the missing files of `pack` from {@link endgamesBase}, verifies each against the
 * manifest (size and SHA-256, fail-closed) and stores it in IndexedDB `tables`; files already
 * stored are kept (resume). One download at a time (a second call joins the running one).
 * Rejects with {@link PackDownloadError}; files verified before the failure stay stored.
 */
export function downloadPack(
  pack: OptInPack,
  opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal } = {},
): Promise<PackStatus> {
  downloading ??= runDownload(pack, opts).finally(() => {
    downloading = null;
  });
  return downloading;
}

async function runDownload(
  pack: OptInPack,
  opts: { onProgress?: (p: DownloadProgress) => void; signal?: AbortSignal },
): Promise<PackStatus> {
  const doFetch: FetchFn = config.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const entries = packEntries(pack);
  const total = entries.reduce((s, e) => s + e.bytes, 0);
  const stored = await storedManifestFiles();
  let loaded = entries.filter((e) => stored.has(tableFileName(e))).reduce((s, e) => s + e.bytes, 0);
  const signal = opts.signal ?? new AbortController().signal;
  const base = endgamesBase();

  for (const entry of entries) {
    const file = tableFileName(entry);
    if (stored.has(file)) continue;
    if (signal.aborted) throw abortErr(file);
    opts.onProgress?.({ loaded, total, file });
    const timer = new AbortController();
    const t = setTimeout(() => timer.abort(), FILE_TIMEOUT_MS);
    const onAbort = () => timer.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let bytes: Uint8Array | null;
    const before = loaded;
    try {
      const res = await doFetch(`${base}${file}`, { credentials: 'omit', signal: timer.signal });
      if (!res.ok) {
        throw new PackDownloadError(
          'network',
          file,
          `Could not download ${file} (HTTP ${res.status})`,
        );
      }
      bytes = await readBody(
        res,
        entry.bytes,
        (n) => {
          loaded += n;
          opts.onProgress?.({ loaded: Math.min(loaded, before + entry.bytes), total, file });
        },
        timer.signal,
      );
    } catch (e) {
      if (e instanceof PackDownloadError) throw e;
      if (signal.aborted) throw abortErr(file);
      throw new PackDownloadError('network', file, `Could not download ${file}`);
    } finally {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
    }
    loaded = before;
    if (!bytes || !(await verifyTableBytes({ size: entry.bytes, sha256: entry.sha256 }, bytes))) {
      throw new PackDownloadError(
        'integrity',
        file,
        `${file} does not match the expected checksum; nothing was stored`,
      );
    }
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const ok = await putStoredTable({
      name: file,
      pack,
      sha256: entry.sha256,
      size: entry.bytes,
      bytes: buffer,
      fetchedAt: Date.now(),
    });
    if (!ok)
      throw new PackDownloadError('storage', file, 'Not enough storage space for the tables');
    loaded += entry.bytes;
    opts.onProgress?.({ loaded, total, file });
  }
  return packStatus(pack);
}

/** Removes every stored file of `pack`. */
export async function deletePack(pack: OptInPack): Promise<void> {
  await deleteStoredTables(packEntries(pack).map(tableFileName));
}
