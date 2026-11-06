/**
 * Tablebase Worker (ADR-025 §2, §9): holds `SyzygyTables` with the table bytes as `Uint8Array`s
 * and answers probes with the `TbPosition` shape of the lichess API. Messages are handled one at
 * a time in arrival order, so a probe sent after a `load` sees the loaded tables.
 *
 * `load` takes files either as bytes (downloaded packs, read from IndexedDB by the main thread and
 * transferred) or as a URL (the bundled core files, fetched here). Every file is checked against
 * the manifest's size and SHA-256 that the main thread passes along before `addTable`; a mismatch
 * or a file the reader rejects is reported in `failed` and never added (fail-closed).
 *
 * This module imports nothing but `@daisychess/endgames` (no DOM, no app state): it is the
 * Worker's entry. The SHA-256 helpers live here for that reason and `tablePacks.ts` re-exports
 * them.
 *
 * The protocol handler is a plain function ({@link createTbWorkerHandler}) so it is tested
 * without a Worker; the bootstrap at the end only runs inside a dedicated worker.
 */
import { SyzygyTables, type TbPosition } from '@daisychess/endgames';

// ---------------------------------------------------------------------------------------------
// SHA-256 of bytes: Web Crypto when present (secure contexts), else a small pure implementation
// (insecure origins, some WebViews, tests).

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Synchronous SHA-256 (hex) of bytes, pure TypeScript. */
export function sha256HexSync(data: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const len = data.length;
  const total = Math.ceil((len + 9) / 64) * 64;
  const tail = new Uint8Array(total - Math.floor(len / 64) * 64);
  tail.set(data.subarray(Math.floor(len / 64) * 64));
  tail[len % 64] = 0x80;
  const bits = len * 8;
  const tv = new DataView(tail.buffer);
  tv.setUint32(tail.length - 8, Math.floor(bits / 0x100000000));
  tv.setUint32(tail.length - 4, bits >>> 0);
  const full = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fullBlocks = Math.floor(len / 64);
  const blocks = total / 64;
  for (let blk = 0; blk < blocks; blk++) {
    const view = blk < fullBlocks ? full : tv;
    const off = blk < fullBlocks ? blk * 64 : (blk - fullBlocks) * 64;
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!,
      b = h[1]!,
      c = h[2]!,
      d = h[3]!,
      e = h[4]!,
      f = h[5]!,
      g = h[6]!,
      hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return [...h].map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** SHA-256 (hex) of bytes: `crypto.subtle` when available, else {@link sha256HexSync}. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (subtle) {
    try {
      const copy = new Uint8Array(data); // a plain ArrayBuffer view (digest rejects shared buffers)
      const d = new Uint8Array(await subtle.digest('SHA-256', copy));
      return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fall through to the pure implementation.
    }
  }
  return sha256HexSync(data);
}

/** Whether `bytes` are exactly the manifest's file (size and SHA-256). */
export async function verifyTableBytes(
  expected: { size: number; sha256: string },
  bytes: Uint8Array,
): Promise<boolean> {
  if (bytes.byteLength !== expected.size) return false;
  return (await sha256Hex(bytes)) === expected.sha256;
}

// ---------------------------------------------------------------------------------------------
// Protocol

export interface TbWorkerFile {
  /** File name, e.g. `KQvK.rtbw`. */
  name: string;
  sha256: string;
  size: number;
  /** Bundled file to fetch (core pack). */
  url?: string;
  /** File bytes (downloaded pack). */
  bytes?: ArrayBuffer;
}

export type TbWorkerRequest =
  { type: 'load'; id: number; files: TbWorkerFile[] } | { type: 'probe'; id: number; fen: string };

export type TbWorkerResponse =
  | {
      type: 'loaded';
      id: number;
      loaded: string[];
      failed: Array<{ name: string; reason: 'fetch' | 'integrity' | 'format' }>;
    }
  | { type: 'result'; id: number; pos: TbPosition | null }
  | { type: 'error'; id: number; message: string };

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export function createTbWorkerHandler(
  deps: { fetch?: FetchFn; tables?: SyzygyTables } = {},
): (req: TbWorkerRequest) => Promise<TbWorkerResponse> {
  const tables = deps.tables ?? new SyzygyTables();
  const doFetch: FetchFn = deps.fetch ?? ((i, init) => globalThis.fetch(i, init));
  const loaded = new Set<string>();

  async function bytesOf(file: TbWorkerFile): Promise<Uint8Array | null> {
    if (file.bytes) return new Uint8Array(file.bytes);
    if (!file.url) return null;
    try {
      const res = await doFetch(file.url, { credentials: 'omit' });
      if (!res.ok) return null;
      return new Uint8Array(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  return async (req) => {
    if (req.type === 'load') {
      const ok: string[] = [];
      const failed: Array<{ name: string; reason: 'fetch' | 'integrity' | 'format' }> = [];
      for (const file of req.files) {
        if (loaded.has(file.name)) {
          ok.push(file.name);
          continue;
        }
        const bytes = await bytesOf(file);
        if (!bytes) {
          failed.push({ name: file.name, reason: 'fetch' });
          continue;
        }
        if (!(await verifyTableBytes(file, bytes))) {
          failed.push({ name: file.name, reason: 'integrity' });
          continue;
        }
        try {
          tables.addTable(file.name, bytes);
          loaded.add(file.name);
          ok.push(file.name);
        } catch {
          failed.push({ name: file.name, reason: 'format' });
        }
      }
      return { type: 'loaded', id: req.id, loaded: ok, failed };
    }
    try {
      return { type: 'result', id: req.id, pos: tables.probePosition(req.fen) };
    } catch (e) {
      return { type: 'error', id: req.id, message: e instanceof Error ? e.message : String(e) };
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Bootstrap (dedicated worker only). The app's `lib` has no WebWorker types: minimal shape.

interface WorkerScope {
  postMessage(msg: TbWorkerResponse): void;
  addEventListener(type: 'message', fn: (e: { data: TbWorkerRequest }) => void): void;
}

const g = globalThis as unknown as { WorkerGlobalScope?: unknown; document?: unknown };
if (typeof g.WorkerGlobalScope !== 'undefined' && typeof g.document === 'undefined') {
  const scope = globalThis as unknown as WorkerScope;
  const handle = createTbWorkerHandler();
  let chain: Promise<void> = Promise.resolve();
  scope.addEventListener('message', (e) => {
    const req = e.data;
    chain = chain.then(async () => {
      scope.postMessage(await handle(req));
    });
  });
}
