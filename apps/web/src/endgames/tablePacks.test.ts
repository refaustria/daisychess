// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import type { TablesManifest } from '@daisychess/endgames';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_ENDGAMES_URL,
  bundledTablesBase,
  configureTablePacks,
  deletePack,
  downloadPack,
  endgamesBase,
  formatBytes,
  MANIFEST_FILES,
  OPT_IN_PACKS,
  packEntries,
  packSize,
  packStatus,
  PackDownloadError,
  TABLES_MANIFEST,
  type DownloadProgress,
} from './tablePacks';
import { configureTbCache, getStoredTable, putStoredTable, storedTableNames } from './tbCache';

const native = vi.hoisted(() => ({ value: false }));
vi.mock('../platform', () => ({ isNativeApp: () => native.value }));

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytesOf = (n: number, fill: number) => new Uint8Array(n).fill(fill);

/** A test manifest whose rook files are synthetic bytes with their real digests. */
const FILES = {
  'KRPvKR.rtbw': bytesOf(5000, 1),
  'KRvKR.rtbw': bytesOf(300, 2),
  'KRvKP.rtbw': bytesOf(70, 3),
};
const MANIFEST: TablesManifest = {
  format: 1,
  source: 'test',
  tables: [
    { name: 'KQvK', kind: 'wdl', bytes: 10, sha256: 'a'.repeat(64), pack: 'core' },
    ...Object.entries(FILES).map(([f, b]) => ({
      name: f.split('.')[0]!,
      kind: 'wdl' as const,
      bytes: b.length,
      sha256: sha(b),
      pack: 'rook' as const,
    })),
  ],
};

/** Serves FILES in 1000-byte chunks; records the requested names. */
function server(override: Record<string, Response | (() => Response)> = {}) {
  const requested: string[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const name = url.split('/').pop()!;
    requested.push(name);
    expect(url).toBe(`https://cdn.test/endgames/v1/${name}`);
    expect(init?.credentials).toBe('omit');
    const o = override[name];
    if (o) return typeof o === 'function' ? o() : o;
    const b = FILES[name as keyof typeof FILES];
    if (!b) return new Response('', { status: 404 });
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (at >= b.length) return ctl.close();
        ctl.enqueue(b.slice(at, at + 1000));
        at += 1000;
      },
    });
    return new Response(stream);
  });
  return { fetch, requested };
}

beforeEach(() => {
  native.value = false;
  configureTbCache(null);
});
afterEach(() => {
  configureTablePacks({});
  configureTbCache(undefined);
});

describe('manifest and sizes', () => {
  it('the committed manifest: core bundled, rook opt-in with its real size', () => {
    expect(OPT_IN_PACKS).toEqual(['rook']);
    expect(packSize('rook')).toBe(20_861_856);
    expect(formatBytes(packSize('rook'))).toBe('20.9 MB');
    expect(packSize('core')).toBe(801_264);
    expect(formatBytes(packSize('core'))).toBe('801 kB');
    expect(MANIFEST_FILES.get('KRPvKR.rtbw')?.pack).toBe('rook');
    expect(MANIFEST_FILES.get('KQvK.rtbz')?.pack).toBe('core');
    expect(MANIFEST_FILES.size).toBe(TABLES_MANIFEST.tables.length);
    expect(formatBytes(0)).toBe('1 kB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
  });

  it('core is always ready', async () => {
    expect(await packStatus('core')).toMatchObject({ state: 'ready', totalBytes: 801_264 });
  });
});

describe('endgamesBase / bundledTablesBase', () => {
  it('is the same origin on the web', () => {
    expect(endgamesBase()).toBe(`${location.origin}/endgames/v1/`);
    expect(bundledTablesBase()).toBe(`${location.origin}/endgames/v1/`);
  });

  it('downloads from play.daisychess.org inside the app; the core still comes from the bundle', () => {
    native.value = true;
    expect(endgamesBase()).toBe(APP_ENDGAMES_URL);
    expect(APP_ENDGAMES_URL).toBe('https://play.daisychess.org/endgames/v1/');
    expect(bundledTablesBase()).toBe(`${location.origin}/endgames/v1/`);
  });

  it('honours an explicit base and adds the trailing slash', () => {
    configureTablePacks({ base: 'https://x.test/e', bundledBase: 'https://y.test/b' });
    expect(endgamesBase()).toBe('https://x.test/e/');
    expect(bundledTablesBase()).toBe('https://y.test/b/');
  });
});

describe('downloadPack', () => {
  beforeEach(() =>
    configureTablePacks({ manifest: MANIFEST, base: 'https://cdn.test/endgames/v1/' }),
  );

  it('downloads, verifies and stores every file with progress; status ready', async () => {
    const s = server();
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: s.fetch,
    });
    expect(await packStatus('rook')).toMatchObject({ state: 'absent', storedFiles: 0, files: 3 });
    const progress: DownloadProgress[] = [];
    const status = await downloadPack('rook', { onProgress: (p) => progress.push(p) });
    expect(status).toMatchObject({
      state: 'ready',
      storedBytes: 5370,
      totalBytes: 5370,
      storedFiles: 3,
    });
    expect(s.requested).toEqual(['KRPvKR.rtbw', 'KRvKR.rtbw', 'KRvKP.rtbw']);
    expect(progress.every((p) => p.total === 5370)).toBe(true);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!.loaded).toBeGreaterThanOrEqual(progress[i - 1]!.loaded);
    }
    expect(progress.at(-1)!.loaded).toBe(5370);
    expect(progress.length).toBeGreaterThan(6); // streamed chunks of the 5 kB file
    const rec = await getStoredTable('KRPvKR.rtbw');
    expect(rec).toMatchObject({ pack: 'rook', size: 5000, sha256: sha(FILES['KRPvKR.rtbw']) });
    expect(new Uint8Array(rec!.bytes)).toEqual(FILES['KRPvKR.rtbw']);
  });

  it('resumes: files already stored are not fetched again', async () => {
    await putStoredTable({
      name: 'KRPvKR.rtbw',
      pack: 'rook',
      sha256: sha(FILES['KRPvKR.rtbw']),
      size: 5000,
      bytes: FILES['KRPvKR.rtbw'].slice().buffer,
      fetchedAt: 1,
    });
    expect(await packStatus('rook')).toMatchObject({ state: 'partial', storedBytes: 5000 });
    const s = server();
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: s.fetch,
    });
    const first: DownloadProgress[] = [];
    await downloadPack('rook', { onProgress: (p) => first.push(p) });
    expect(s.requested).toEqual(['KRvKR.rtbw', 'KRvKP.rtbw']);
    expect(first[0]!.loaded).toBe(5000);
  });

  it('fails closed on a wrong digest: the file is not stored, earlier files stay', async () => {
    const s = server({ 'KRvKR.rtbw': () => new Response(bytesOf(300, 9)) });
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: s.fetch,
    });
    const err = await downloadPack('rook').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PackDownloadError);
    expect(err).toMatchObject({ kind: 'integrity', file: 'KRvKR.rtbw' });
    expect(await storedTableNames()).toEqual(['KRPvKR.rtbw']);
    expect(s.requested).not.toContain('KRvKP.rtbw');
  });

  it('fails closed on a body longer or shorter than the manifest says', async () => {
    for (const body of [bytesOf(301, 2), bytesOf(299, 2)]) {
      configureTbCache(null);
      const s = server({ 'KRvKR.rtbw': () => new Response(body) });
      configureTablePacks({
        manifest: MANIFEST,
        base: 'https://cdn.test/endgames/v1/',
        fetch: s.fetch,
      });
      await expect(downloadPack('rook')).rejects.toMatchObject({ kind: 'integrity' });
      expect(await storedTableNames()).toEqual(['KRPvKR.rtbw']);
    }
  });

  it('HTTP errors and network failures are network errors', async () => {
    const s = server({ 'KRPvKR.rtbw': new Response('', { status: 404 }) });
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: s.fetch,
    });
    await expect(downloadPack('rook')).rejects.toMatchObject({
      kind: 'network',
      file: 'KRPvKR.rtbw',
    });
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(downloadPack('rook')).rejects.toMatchObject({ kind: 'network' });
    expect(await storedTableNames()).toEqual([]);
  });

  it('can be cancelled; a second call joins the running download', async () => {
    const s = server();
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: s.fetch,
    });
    const ctl = new AbortController();
    const a = downloadPack('rook', {
      signal: ctl.signal,
      onProgress: (p) => {
        if (p.loaded >= 2000) ctl.abort();
      },
    });
    const b = downloadPack('rook');
    await expect(a).rejects.toMatchObject({ kind: 'aborted' });
    await expect(b).rejects.toMatchObject({ kind: 'aborted' });
    expect(s.fetch).toHaveBeenCalledTimes(1);
    expect(await storedTableNames()).toEqual([]);
    // A fresh call afterwards runs.
    expect((await downloadPack('rook')).state).toBe('ready');
  });

  it('deletePack removes the pack files only', async () => {
    const s = server();
    configureTablePacks({
      manifest: MANIFEST,
      base: 'https://cdn.test/endgames/v1/',
      fetch: s.fetch,
    });
    await downloadPack('rook');
    await putStoredTable({
      name: 'other.bin',
      pack: 'rook',
      sha256: '',
      size: 1,
      bytes: new ArrayBuffer(1),
      fetchedAt: 1,
    });
    await deletePack('rook');
    expect(await storedTableNames()).toEqual(['other.bin']);
    expect(await packStatus('rook')).toMatchObject({ state: 'absent', storedFiles: 0 });
  });

  it('packEntries follows the manifest', () => {
    expect(packEntries('rook').map((e) => e.name)).toEqual(['KRPvKR', 'KRvKR', 'KRvKP']);
  });
});
