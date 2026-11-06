// @vitest-environment node
import { readFileSync } from 'node:fs';
import { tableFileName } from '@daisychess/endgames';
import { describe, expect, it, vi } from 'vitest';
import { isAbortError } from './lichessTablebase';
import { createLocalTablebase, localFilesFor, type TbWorkerLike } from './localTablebase';
import { packEntries } from './tablePacks';
import type { StoredTable } from './tbCache';
import { createTbWorkerHandler, type TbWorkerRequest, type TbWorkerResponse } from './tbWorker';

const dir = new URL('../../public/endgames/v1/', import.meta.url);
const diskFetch = async (url: string) => {
  try {
    return new Response(new Uint8Array(readFileSync(new URL(url.split('/').pop()!, dir))));
  } catch {
    return new Response('', { status: 404 });
  }
};

const KQK = '8/8/8/8/8/2k5/8/KQ6 w - - 0 1';
const KQKP = '4Q3/8/8/8/8/2k5/p7/K7 w - - 0 1';
const KRPKR = '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1';

/** An in-process "Worker" running the real handler, asynchronously like postMessage. */
function fakeWorkers(opts: { hang?: (req: TbWorkerRequest) => boolean } = {}) {
  const made: Array<
    TbWorkerLike & { posted: TbWorkerRequest[]; terminated: boolean; crash: () => void }
  > = [];
  const create = () => {
    const handle = createTbWorkerHandler({ fetch: diskFetch });
    const w = {
      onmessage: null as TbWorkerLike['onmessage'],
      onerror: null as TbWorkerLike['onerror'],
      posted: [] as TbWorkerRequest[],
      terminated: false,
      postMessage(msg: TbWorkerRequest) {
        w.posted.push(msg);
        if (opts.hang?.(msg)) return;
        void handle(msg).then((res: TbWorkerResponse) => {
          if (!w.terminated) w.onmessage?.({ data: res } as MessageEvent<TbWorkerResponse>);
        });
      },
      terminate() {
        w.terminated = true;
      },
      crash() {
        w.onerror?.(new Event('error'));
      },
    };
    made.push(w);
    return w;
  };
  return { create, made };
}

const base = {
  bundledBase: () => 'http://bundle/endgames/v1/',
  storedFiles: async () => new Set<string>(),
};

describe('coverage', () => {
  it('core materials with and without DTZ; the rook endgame needs the pack', async () => {
    const local = createLocalTablebase({ ...base, createWorker: fakeWorkers().create });
    expect(await local.coverage(KQK)).toEqual({ wdl: true, dtz: true, missing: [] });
    expect(await local.coverage(KQKP)).toEqual({ wdl: true, dtz: false, missing: [] });
    const rook = await local.coverage(KRPKR);
    expect(rook.wdl).toBe(false);
    const rookFiles = new Set(packEntries('rook').map(tableFileName));
    expect(rook.missing).toContain('KRPvKR.rtbw');
    expect(rook.missing.every((f) => rookFiles.has(f))).toBe(true);
    // Every WDL file of the closure is in the rook pack (addendum M32-2).
    expect(rookFiles.size).toBe(rook.missing.length);
    expect(await local.coverage('8/8/8/8/8/2k5/8/KB6 w - - 0 1')).toEqual({
      wdl: true,
      dtz: true,
      missing: [],
    });
    expect(await local.coverage('garbage')).toEqual({ wdl: false, dtz: false, missing: [] });
  });

  it('localFilesFor lists the WDL closure, then the own DTZ', () => {
    expect(localFilesFor(KQK)).toEqual(['KQvK.rtbw', 'KQvK.rtbz']);
    expect(localFilesFor(KQKP)).toEqual(
      expect.arrayContaining(['KQvKP.rtbw', 'KQvKQ.rtbw', 'KQvK.rtbw', 'KQvKP.rtbz']),
    );
  });
});

describe('probe', () => {
  it('starts the Worker lazily, loads only the needed files once, and answers', async () => {
    const workers = fakeWorkers();
    const local = createLocalTablebase({ ...base, createWorker: workers.create });
    expect(local.running()).toBe(false);
    const pos = await local.probe(KQK);
    expect(pos?.category).toBe('win');
    expect(pos?.dtz).toBeGreaterThan(0);
    expect(workers.made).toHaveLength(1);
    const loads = workers.made[0]!.posted.filter((m) => m.type === 'load');
    expect(loads).toHaveLength(1);
    expect(loads[0]!.type === 'load' && loads[0]!.files.map((f) => f.name)).toEqual([
      'KQvK.rtbw',
      'KQvK.rtbz',
    ]);
    expect(loads[0]!.type === 'load' && loads[0]!.files[0]!.url).toBe(
      'http://bundle/endgames/v1/KQvK.rtbw',
    );
    await local.probe('8/8/8/8/8/2k5/8/1Q4K1 b - - 0 1');
    expect(workers.made[0]!.posted.filter((m) => m.type === 'load')).toHaveLength(1);
    // KQvKP: WDL only (no DTZ in the core pack), still exact WDL.
    const p = await local.probe(KQKP);
    expect(p?.dtz).toBeUndefined();
    expect(p?.category).toBeDefined();
  });

  it('concurrent probes do not load a file twice', async () => {
    const workers = fakeWorkers();
    const local = createLocalTablebase({ ...base, createWorker: workers.create });
    const [a, b] = await Promise.all([local.probe(KQK), local.probe(KQK)]);
    expect(a?.category).toBe('win');
    expect(b?.category).toBe('win');
    const names = workers.made[0]!.posted.flatMap((m) =>
      m.type === 'load' ? m.files.map((f) => f.name) : [],
    );
    expect(names).toEqual(['KQvK.rtbw', 'KQvK.rtbz']);
  });

  it('answers null without a Worker when tables are missing', async () => {
    const workers = fakeWorkers();
    const local = createLocalTablebase({ ...base, createWorker: workers.create });
    expect(await local.probe(KRPKR)).toBeNull();
    expect(workers.made).toHaveLength(0);
  });

  it('fail-closed: a stored file that does not verify is refused and reported missing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const workers = fakeWorkers();
    const rook = packEntries('rook').map(tableFileName);
    const getStored = vi.fn(async (name: string): Promise<StoredTable> => ({
      name,
      pack: 'rook',
      sha256: 'f'.repeat(64),
      size: 8,
      bytes: new Uint8Array(8).buffer,
      fetchedAt: 1,
    }));
    const local = createLocalTablebase({
      ...base,
      storedFiles: async () => new Set(rook),
      getStored,
      createWorker: workers.create,
    });
    expect((await local.coverage(KRPKR)).wdl).toBe(true);
    expect(await local.probe(KRPKR)).toBeNull();
    const load = workers.made[0]!.posted.find((m) => m.type === 'load');
    const rookSet = new Set(rook);
    expect(load?.type === 'load' && load.files.filter((f) => rookSet.has(f.name)).length).toBe(
      rook.length,
    );
    expect(
      load?.type === 'load' &&
        load.files.every((f) => (rookSet.has(f.name) ? f.bytes && !f.url : f.url && !f.bytes)),
    ).toBe(true);
    expect((await local.coverage(KRPKR)).wdl).toBe(false);
    // Not offered again in this session.
    getStored.mockClear();
    expect(await local.probe(KRPKR)).toBeNull();
    expect(getStored).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a stale stored list (file gone) answers null and re-reads the list', async () => {
    const workers = fakeWorkers();
    const rook = packEntries('rook').map(tableFileName);
    const storedFiles = vi.fn(async () => new Set(rook));
    const local = createLocalTablebase({
      ...base,
      storedFiles,
      getStored: async () => undefined,
      createWorker: workers.create,
    });
    expect(await local.probe(KRPKR)).toBeNull();
    await local.coverage(KRPKR);
    expect(storedFiles).toHaveBeenCalledTimes(2);
  });

  it('terminates after the idle time and starts a fresh Worker on the next probe', async () => {
    const workers = fakeWorkers();
    const local = createLocalTablebase({ ...base, createWorker: workers.create, idleMs: 30 });
    await local.probe(KQK);
    expect(local.running()).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(local.running()).toBe(false);
    expect(workers.made[0]!.terminated).toBe(true);
    expect((await local.probe(KQK))?.category).toBe('win');
    expect(workers.made).toHaveLength(2);
    // The new Worker loads its tables again.
    expect(workers.made[1]!.posted.filter((m) => m.type === 'load')).toHaveLength(1);
    local.reset({ terminate: true });
    expect(local.running()).toBe(false);
  });

  it('a crash resolves the pending probe with null; the next probe recovers', async () => {
    const workers = fakeWorkers({ hang: (m) => m.type === 'probe' });
    const local = createLocalTablebase({ ...base, createWorker: workers.create });
    const p = local.probe(KQK);
    await vi.waitFor(() =>
      expect(workers.made[0]?.posted.some((m) => m.type === 'probe')).toBe(true),
    );
    workers.made[0]!.crash();
    expect(await p).toBeNull();
    expect(workers.made[0]!.terminated).toBe(true);
    expect(local.running()).toBe(false);
  });

  it('a stuck Worker is replaced after the request timeout', async () => {
    let hang = true;
    const workers = fakeWorkers({ hang: (m) => hang && m.type === 'probe' });
    const local = createLocalTablebase({
      ...base,
      createWorker: workers.create,
      requestTimeoutMs: 30,
    });
    expect(await local.probe(KQK)).toBeNull();
    expect(workers.made[0]!.terminated).toBe(true);
    hang = false;
    expect((await local.probe(KQK))?.category).toBe('win');
  });

  it('honours an aborted signal', async () => {
    const local = createLocalTablebase({ ...base, createWorker: fakeWorkers().create });
    const ctl = new AbortController();
    ctl.abort();
    await expect(local.probe(KQK, { signal: ctl.signal })).rejects.toSatisfy(isAbortError);
  });
});
