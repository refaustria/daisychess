/**
 * Local Syzygy probing (ADR-025 §2, §9) — the main-thread side of `tbWorker.ts`.
 *
 * - Availability is decided here, without the Worker: a position can be probed locally when the
 *   WDL tables of its whole capture/promotion closure (`requiredTables`) are bundled (core pack)
 *   or downloaded (IndexedDB `tables`). `KBvK`/`KNvK` need no table.
 * - The Worker is created on the first probe and loads tables lazily: only the files a position
 *   needs, once per Worker. Core files are fetched by the Worker from the bundle; downloaded
 *   files are read here and transferred. The Worker re-verifies every file against the manifest.
 * - Terminated {@link IDLE_MS} after the last probe (releases up to ~21 MB of tables), on
 *   `reset()` (pack deleted) and after a crash or a stuck request ({@link REQUEST_TIMEOUT_MS});
 *   the next probe starts a fresh Worker. A crash never rejects a probe: it resolves `null`.
 */
import {
  DRAWN_WITHOUT_TABLE,
  materialKey,
  normalizeTableName,
  requiredTables,
  tablebaseEligible,
  type TablebaseProbe,
  type TbPosition,
} from '@daisychess/endgames';
import { abortError } from './lichessTablebase';
import { bundledTablesBase, MANIFEST_FILES, storedManifestFiles } from './tablePacks';
import { getStoredTable, type StoredTable } from './tbCache';
import type { TbWorkerFile, TbWorkerRequest, TbWorkerResponse } from './tbWorker';

export const IDLE_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;

/** The part of `Worker` this module uses (tests pass an in-process fake). */
export interface TbWorkerLike {
  postMessage(msg: TbWorkerRequest, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<TbWorkerResponse>) => void) | null;
  onerror: ((e: ErrorEvent | Event) => void) | null;
  terminate(): void;
}

export interface LocalTablebaseOptions {
  createWorker?: () => TbWorkerLike;
  /** File names of the downloaded tables (default: IndexedDB `tables`, manifest files only). */
  storedFiles?: () => Promise<Set<string>>;
  getStored?: (name: string) => Promise<StoredTable | undefined>;
  bundledBase?: () => string;
  idleMs?: number;
  requestTimeoutMs?: number;
}

export interface LocalCoverage {
  /** Every WDL table probing needs is bundled or downloaded. */
  wdl: boolean;
  /** The material's own DTZ table is available too (exact 50-move categories, `dtz` values). */
  dtz: boolean;
  /** Missing file names (for "needs the rook endgames download"). */
  missing: string[];
}

export interface LocalTablebase extends TablebaseProbe {
  probe(fen: string, opts?: { signal?: AbortSignal }): Promise<TbPosition | null>;
  /** What the local tables cover for the material of `fen`. */
  coverage(fen: string): Promise<LocalCoverage>;
  /** Forget the downloaded-file list (after a download); with `terminate` also the Worker. */
  reset(opts?: { terminate?: boolean }): void;
  /** Whether a Worker is running (tests). */
  running(): boolean;
}

const defaultWorker = (): TbWorkerLike =>
  new Worker(new URL('./tbWorker.ts', import.meta.url), {
    type: 'module',
    name: 'daisychess-tablebase',
  }) as unknown as TbWorkerLike;

const CORE_FILES = new Set(
  [...MANIFEST_FILES.entries()].filter(([, e]) => e.pack === 'core').map(([name]) => name),
);

/** Throws for a FEN the tables cannot answer (invalid, castling rights, more than 7 pieces). */
function filesFor(fen: string): { wdl: string[]; dtz: string | null } {
  if (!tablebaseEligible(fen)) throw new Error('not eligible');
  const key = materialKey(fen);
  const own = normalizeTableName(key);
  return {
    wdl: requiredTables(key).map((n) => `${n}.rtbw`),
    dtz: DRAWN_WITHOUT_TABLE.has(own) || own === 'KvK' ? null : `${own}.rtbz`,
  };
}

interface Pending {
  resolve: (r: TbWorkerResponse | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createLocalTablebase(opts: LocalTablebaseOptions = {}): LocalTablebase {
  const createWorker = opts.createWorker ?? defaultWorker;
  const storedFiles = opts.storedFiles ?? storedManifestFiles;
  const getStored = opts.getStored ?? getStoredTable;
  const bundledBase = opts.bundledBase ?? bundledTablesBase;
  const idleMs = opts.idleMs ?? IDLE_MS;
  const requestTimeout = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  let stored: Promise<Set<string>> | null = null;
  /** Files refused in this session (integrity, format): never offered again until `reset`. */
  const refused = new Set<string>();
  let worker: TbWorkerLike | null = null;
  let loaded = new Set<string>();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let active = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const available = async (): Promise<Set<string>> => {
    stored ??= storedFiles().catch(() => new Set<string>());
    const s = await stored;
    const out = new Set<string>([...CORE_FILES, ...s]);
    for (const r of refused) out.delete(r);
    return out;
  };

  function stop(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const w = worker;
    worker = null;
    loaded = new Set();
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.resolve(null);
    }
    try {
      w?.terminate();
    } catch {
      // Already gone.
    }
  }

  function ensureWorker(): TbWorkerLike {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (worker) return worker;
    const w = createWorker();
    w.onmessage = (e) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      p.resolve(msg);
    };
    w.onerror = () => {
      if (worker === w) stop();
    };
    worker = w;
    return w;
  }

  function send(
    req: TbWorkerRequest,
    transfer: Transferable[] = [],
  ): Promise<TbWorkerResponse | null> {
    const w = ensureWorker();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // A stuck Worker is replaced; its other requests resolve null too.
        pending.delete(req.id);
        if (worker === w) stop();
        resolve(null);
      }, requestTimeout);
      pending.set(req.id, { resolve, timer });
      try {
        w.postMessage(req, transfer);
      } catch {
        clearTimeout(timer);
        pending.delete(req.id);
        resolve(null);
      }
    });
  }

  function scheduleIdle(): void {
    if (active > 0 || !worker) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, idleMs);
  }

  async function coverage(fen: string): Promise<LocalCoverage> {
    let files: { wdl: string[]; dtz: string | null };
    try {
      files = filesFor(fen);
    } catch {
      return { wdl: false, dtz: false, missing: [] };
    }
    const have = await available();
    const missing = files.wdl.filter((f) => !have.has(f));
    return {
      wdl: missing.length === 0,
      dtz: missing.length === 0 && (files.dtz === null || have.has(files.dtz)),
      missing,
    };
  }

  /** Loads run one after the other: concurrent probes must not read and send a pack twice. */
  let loadChain: Promise<unknown> = Promise.resolve();
  function load(names: string[]): Promise<boolean> {
    const run = loadChain.then(() => loadNow(names));
    loadChain = run.catch(() => undefined);
    return run;
  }

  async function loadNow(names: string[]): Promise<boolean> {
    const want = names.filter((n) => !loaded.has(n));
    if (want.length === 0) return true;
    const files: TbWorkerFile[] = [];
    const transfer: Transferable[] = [];
    for (const name of want) {
      const entry = MANIFEST_FILES.get(name);
      if (!entry) return false;
      const meta = { name, sha256: entry.sha256, size: entry.bytes };
      if (entry.pack === 'core') {
        files.push({ ...meta, url: `${bundledBase()}${name}` });
      } else {
        const rec = await getStored(name);
        if (!rec) {
          stored = null; // the list was stale
          return false;
        }
        files.push({ ...meta, bytes: rec.bytes });
        transfer.push(rec.bytes);
      }
    }
    const res = await send({ type: 'load', id: nextId++, files }, transfer);
    if (!res || res.type !== 'loaded') return false;
    for (const n of res.loaded) loaded.add(n);
    for (const f of res.failed) {
      if (f.reason !== 'fetch') {
        console.warn(`Endgame tables: ${f.name} failed verification (${f.reason}); not used`);
        refused.add(f.name);
      }
    }
    return res.failed.length === 0;
  }

  async function probe(fen: string, o: { signal?: AbortSignal } = {}): Promise<TbPosition | null> {
    if (o.signal?.aborted) throw abortError();
    let files: { wdl: string[]; dtz: string | null };
    try {
      files = filesFor(fen);
    } catch {
      return null;
    }
    const have = await available();
    if (!files.wdl.every((f) => have.has(f))) return null;
    const names = files.dtz && have.has(files.dtz) ? [...files.wdl, files.dtz] : files.wdl;
    active++;
    try {
      // A missing DTZ only costs the `dtz` values; a missing WDL table makes the probe null.
      await load(names);
      if (!files.wdl.every((f) => loaded.has(f))) return null;
      if (o.signal?.aborted) throw abortError();
      const res = await send({ type: 'probe', id: nextId++, fen });
      if (o.signal?.aborted) throw abortError();
      return res && res.type === 'result' ? res.pos : null;
    } finally {
      active--;
      scheduleIdle();
    }
  }

  return {
    probe,
    coverage,
    reset: (r = {}) => {
      stored = null;
      refused.clear();
      if (r.terminate) stop();
    },
    running: () => worker !== null,
  };
}

/** File names needed to probe `fen` locally (WDL closure, then the own DTZ when one exists). */
export function localFilesFor(fen: string): string[] {
  const f = filesFor(fen);
  return f.dtz ? [...f.wdl, f.dtz] : f.wdl;
}
