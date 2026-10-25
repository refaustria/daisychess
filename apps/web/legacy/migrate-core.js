// Legacy c.referee.at "moved" page (ADR-021): hands this origin's localStorage to
// play.daisychess.org in the URL fragment, then redirects. Plain browser ESM (served as is by
// nginx from /var/www/c.referee.at-legacy/, no build step); typed by migrate-core.d.ts and tested
// in migrate-core.test.ts. The importer in apps/web/src/migrate/migrateLink.ts is the authority
// on what is accepted; this side only collects, prioritises and encodes.
//
// The payload contains the user's own server token and lichess token. It travels only in the
// fragment (never sent to a server, never in nginx logs) and the app strips it on arrival.

export const TARGET_ORIGIN = 'https://play.daisychess.org';
export const KEY_PREFIX = 'daisychess.';
/** Round-trip state that must not move (the PKCE verifier lives in sessionStorage anyway). */
export const EXCLUDED_KEYS = ['daisychess.lichess.pkce', 'daisychess.portal.pkce'];
/** Longest `#migrate=…` fragment this page produces (URL limits of browsers and chat apps). */
export const MAX_FRAGMENT_LENGTH = 16_000;
export const ROOM_KEY_PREFIX = 'daisychess.room.';
export const TRAINER_KEY = 'daisychess.trainer';
/** Never dropped for size (small, and the ones users would miss most). */
export const ESSENTIAL_KEYS = [
  'daisychess.settings',
  'daisychess.lichess',
  'daisychess.theme',
  'daisychess.nick',
];

/** All `daisychess.*` items of `storage` except {@link EXCLUDED_KEYS}. Never throws. */
export function collectItems(storage) {
  const items = {};
  if (!storage) return items;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k === null || !k.startsWith(KEY_PREFIX) || EXCLUDED_KEYS.includes(k)) continue;
      const v = storage.getItem(k);
      if (typeof v === 'string') items[k] = v;
    }
  } catch {
    /* blocked storage: move nothing */
  }
  return items;
}

/**
 * The order in which keys are dropped when the payload is too long: other non-essential keys,
 * largest first; then the trainer schedule; then room seats, largest first. Essential keys never.
 */
export function dropOrder(items) {
  const size = (k) => k.length + items[k].length;
  const bySizeDesc = (a, b) => size(b) - size(a) || (a < b ? -1 : 1);
  const keys = Object.keys(items);
  const other = keys
    .filter(
      (k) => !ESSENTIAL_KEYS.includes(k) && k !== TRAINER_KEY && !k.startsWith(ROOM_KEY_PREFIX),
    )
    .sort(bySizeDesc);
  const rooms = keys.filter((k) => k.startsWith(ROOM_KEY_PREFIX)).sort(bySizeDesc);
  return [...other, ...(TRAINER_KEY in items ? [TRAINER_KEY] : []), ...rooms];
}

/** A follow-up route of the old URL worth keeping (`#/room/<id>`, `#setup-token=…`), else ''. */
export function followUpHash(hash) {
  if (typeof hash !== 'string' || hash.length > 1_200) return '';
  if (/^#\/[A-Za-z0-9/_-]{0,200}$/.test(hash)) return hash;
  if (/^#setup-token=[A-Za-z0-9%._~-]{1,1024}$/.test(hash)) return hash;
  return '';
}

export function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function readAll(readable) {
  const reader = readable.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Raw DEFLATE via CompressionStream, or null when the browser lacks 'deflate-raw'. */
export async function deflateRaw(bytes, CompressionStreamCtor) {
  if (typeof CompressionStreamCtor !== 'function') return null;
  try {
    const cs = new CompressionStreamCtor('deflate-raw');
    const writer = cs.writable.getWriter();
    writer.write(bytes).catch(() => {});
    writer.close().catch(() => {});
    return await readAll(cs.readable);
  } catch {
    return null;
  }
}

/** `<format>.<base64url>`: `1` = raw DEFLATE of the JSON, `0` = plain JSON. */
export async function encodePayload(obj, CompressionStreamCtor) {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const packed = await deflateRaw(json, CompressionStreamCtor);
  return packed && packed.length < json.length
    ? `1.${bytesToBase64Url(packed)}`
    : `0.${bytesToBase64Url(json)}`;
}

/**
 * The redirect target for this browser's state. Drops keys in {@link dropOrder} until the
 * fragment fits {@link MAX_FRAGMENT_LENGTH}; `dropped` travels along so the app can say what did
 * not move. Without anything to move: the target with the follow-up route only.
 */
export async function buildMigrateUrl({
  storage,
  hash,
  CompressionStream: CS,
  maxFragment = MAX_FRAGMENT_LENGTH,
}) {
  const items = collectItems(storage);
  const follow = followUpHash(hash);
  const base = `${TARGET_ORIGIN}/`;
  if (Object.keys(items).length === 0) return { url: `${base}${follow}`, dropped: [], moved: [] };
  const order = dropOrder(items);
  const dropped = [];
  for (;;) {
    const payload = {
      v: 1,
      items,
      ...(dropped.length ? { dropped } : {}),
      ...(follow ? { hash: follow } : {}),
    };
    const fragment = `#migrate=${await encodePayload(payload, CS)}`;
    if (fragment.length <= maxFragment) {
      return { url: `${base}${fragment}`, dropped, moved: Object.keys(items) };
    }
    const next = order.shift();
    if (next === undefined) {
      // Even the essential keys do not fit (should not happen: they are a few kB): move nothing.
      return { url: `${base}${follow}`, dropped: [...dropped, ...Object.keys(items)], moved: [] };
    }
    delete items[next];
    dropped.push(next);
  }
}

/** Page entry: build the target and leave (replace, so Back does not bounce through this page). */
export async function run(win = globalThis) {
  let storage;
  try {
    storage = win.localStorage;
  } catch {
    storage = undefined;
  }
  let target = `${TARGET_ORIGIN}/`;
  try {
    const r = await buildMigrateUrl({
      storage,
      hash: win.location.hash,
      CompressionStream: win.CompressionStream,
    });
    target = r.url;
  } catch {
    /* fall back to a plain redirect */
  }
  win.location.replace(target);
  return target;
}
