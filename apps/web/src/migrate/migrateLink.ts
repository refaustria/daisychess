import { inflateRaw } from './inflate';

/**
 * One-time move of the browser state from the legacy origin c.referee.at to play.daisychess.org
 * (ADR-021). localStorage is per origin, so the legacy page on c.referee.at (apps/web/legacy/)
 * reads its `daisychess.*` keys, packs them into the URL fragment and redirects to
 * `https://play.daisychess.org/#migrate=<payload>`. This module consumes that fragment on app
 * start, before any store reads storage (`runMigrateLink.ts` is imported right after the
 * ChessLab rename migration in main.tsx).
 *
 * Payload: `<format>.<base64url>`; format `1` = raw DEFLATE of the JSON, `0` = the JSON itself
 * (browsers without `CompressionStream('deflate-raw')`). JSON: `{ v: 1, items: { key: value },
 * dropped?: [key], hash?: "#/room/…" }`.
 *
 * Rules:
 * - only when `document.referrer` is a legacy origin (a crafted link from anywhere else must not
 *   plant a server token or a lichess login in a fresh browser);
 * - only allow-listed keys, each with a value check and a size cap; everything else is ignored;
 * - an existing key on play.daisychess.org is never overwritten;
 * - the fragment always leaves the address bar (replaceState), even when the payload is invalid;
 *   a valid follow-up route from the old URL (`#/room/<id>`, `#setup-token=…`) takes its place;
 * - nothing is logged (the payload can contain tokens).
 *
 * The IndexedDB review cache is not migrated (cached reviews are recomputable, ADR-016, and
 * token holders get them back from the server review store).
 */

export const MIGRATE_HASH_PREFIX = '#migrate=';
/** Origins whose legacy page may hand over state. */
export const LEGACY_ORIGINS: readonly string[] = ['https://c.referee.at'];
export const MIGRATED_NOTICE = 'Your settings were moved from c.referee.at';
/** Longest `#migrate=` fragment accepted (the legacy page targets 16 000 characters). */
export const MAX_FRAGMENT_LENGTH = 32_768;
/** Inflated JSON cap (decompression bomb guard). */
export const MAX_JSON_BYTES = 512 * 1024;
/** At most this many room seats (rooms live a few hours; seats are pruned after 24 h anyway). */
export const MAX_ROOM_SEATS = 50;
const ROOM_ID = /^[A-Za-z0-9_-]{16,64}$/;
export const ROOM_KEY_PREFIX = 'daisychess.room.';

type Check = 'json' | 'text' | 'theme' | 'flag';
interface Rule {
  check: Check;
  max: number;
  /** Human-readable name for the "not moved" notice. */
  label: string;
}

/** The allow-list: key → value check, size cap (characters) and label. */
export const MIGRATABLE_KEYS: Readonly<Record<string, Rule>> = {
  'daisychess.settings': { check: 'json', max: 8_192, label: 'settings' },
  'daisychess.theme': { check: 'theme', max: 8, label: 'theme' },
  'daisychess.lichess': { check: 'json', max: 4_096, label: 'lichess login' },
  'daisychess.nick': { check: 'text', max: 64, label: 'nickname' },
  'daisychess.analysis': { check: 'json', max: 32_768, label: 'analysis settings' },
  'daisychess.explorer': { check: 'json', max: 4_096, label: 'explorer settings' },
  'daisychess.play': { check: 'json', max: 4_096, label: 'play setup' },
  'daisychess.import.online': { check: 'json', max: 4_096, label: 'import settings' },
  'daisychess.drillAfterBook': { check: 'text', max: 64, label: 'drill setting' },
  'daisychess.fullBuildConfirmed': { check: 'flag', max: 1, label: 'browser engine download' },
  'daisychess.trainer': { check: 'json', max: 262_144, label: 'trainer schedule' },
};
const ROOM_RULE: Rule = { check: 'json', max: 2_048, label: 'room seats' };

/** The rule for `key`, or null when it is not migratable (pkce round trip, unknown keys …). */
export function ruleFor(key: string): Rule | null {
  if (Object.prototype.hasOwnProperty.call(MIGRATABLE_KEYS, key)) return MIGRATABLE_KEYS[key]!;
  if (key.startsWith(ROOM_KEY_PREFIX) && ROOM_ID.test(key.slice(ROOM_KEY_PREFIX.length)))
    return ROOM_RULE;
  return null;
}

/** True when `value` passes the allow-list check for `key`. */
export function isValidItem(key: string, value: unknown): value is string {
  const rule = ruleFor(key);
  if (!rule || typeof value !== 'string' || value.length > rule.max) return false;
  switch (rule.check) {
    case 'theme':
      return value === 'light' || value === 'dark';
    case 'flag':
      return value === '1';
    case 'text':
      // eslint-disable-next-line no-control-regex
      return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
    case 'json':
      try {
        const v: unknown = JSON.parse(value);
        return typeof v === 'object' && v !== null;
      } catch {
        return false;
      }
  }
}

/** A follow-up route from the old URL that may replace the fragment, or '' for none. */
export function safeFollowUpHash(h: unknown): string {
  if (typeof h !== 'string' || h.length > 1_200) return '';
  if (/^#\/[A-Za-z0-9/_-]{0,200}$/.test(h)) return h;
  if (/^#setup-token=[A-Za-z0-9%._~-]{1,1024}$/.test(h)) return h;
  return '';
}

export interface MigrationPayload {
  items: Record<string, string>;
  /** Keys the legacy page had to leave out to stay under the URL length limit. */
  dropped: string[];
  hash: string;
}

function base64UrlToBytes(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Decodes the part after `#migrate=`; null for anything malformed. Never throws. */
export function decodeMigratePayload(raw: string): MigrationPayload | null {
  if (raw.length > MAX_FRAGMENT_LENGTH) return null;
  const dot = raw.indexOf('.');
  if (dot < 0) return null;
  const format = raw.slice(0, dot);
  const bytes = base64UrlToBytes(raw.slice(dot + 1));
  if (!bytes) return null;
  let json: Uint8Array;
  try {
    if (format === '1') json = inflateRaw(bytes, MAX_JSON_BYTES);
    else if (format === '0' && bytes.length <= MAX_JSON_BYTES) json = bytes;
    else return null;
  } catch {
    return null;
  }
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || typeof o.items !== 'object' || o.items === null || Array.isArray(o.items))
    return null;
  const items: Record<string, string> = {};
  for (const [k, val] of Object.entries(o.items as Record<string, unknown>)) {
    if (typeof val === 'string') items[k] = val;
  }
  const dropped = Array.isArray(o.dropped)
    ? o.dropped
        .filter((k): k is string => typeof k === 'string' && ruleFor(k) !== null)
        .slice(0, 64)
    : [];
  return { items, dropped, hash: safeFollowUpHash(o.hash) };
}

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ImportResult {
  imported: string[];
  /** Present on play.daisychess.org already: kept. */
  kept: string[];
  /** Not on the allow-list, invalid value, too large, over the room cap or quota. */
  rejected: string[];
  dropped: string[];
}

/** Writes the allow-listed, valid items that `storage` does not have yet. */
export function importItems(storage: KeyValueStorage, payload: MigrationPayload): ImportResult {
  const res: ImportResult = { imported: [], kept: [], rejected: [], dropped: payload.dropped };
  let rooms = 0;
  for (const [key, value] of Object.entries(payload.items)) {
    if (!isValidItem(key, value)) {
      res.rejected.push(key);
      continue;
    }
    if (key.startsWith(ROOM_KEY_PREFIX) && ++rooms > MAX_ROOM_SEATS) {
      res.rejected.push(key);
      continue;
    }
    try {
      if (storage.getItem(key) !== null) {
        res.kept.push(key);
        continue;
      }
      storage.setItem(key, value);
      res.imported.push(key);
    } catch {
      res.rejected.push(key); // quota or blocked storage
    }
  }
  return res;
}

/** The one-time notice for an import, or null when nothing was moved. */
export function migrationNotice(res: ImportResult): string | null {
  if (res.imported.length === 0) return null;
  const labels = [
    ...new Set(res.dropped.map((k) => ruleFor(k)?.label).filter((l): l is string => !!l)),
  ];
  return labels.length > 0
    ? `${MIGRATED_NOTICE} (not moved: ${labels.join(', ')})`
    : MIGRATED_NOTICE;
}

/** True when `referrer` belongs to one of `origins`. */
export function fromLegacyOrigin(
  referrer: string,
  origins: readonly string[] = LEGACY_ORIGINS,
): boolean {
  try {
    return origins.includes(new URL(referrer).origin);
  } catch {
    return false;
  }
}

export interface MigrateDeps {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>;
  history: Pick<History, 'replaceState' | 'state'>;
  referrer: string;
  storage: KeyValueStorage | undefined;
  legacyOrigins?: readonly string[];
}

export interface MigrateOutcome {
  /** Why nothing was imported, when nothing was. */
  status: 'imported' | 'nothing-new' | 'invalid' | 'foreign-referrer' | 'no-storage';
  result: ImportResult | null;
  notice: string | null;
}

/**
 * Consumes a `#migrate=` fragment: strips it (keeping path, query and a valid follow-up route),
 * then imports when the navigation came from a legacy origin. Returns null without a fragment.
 */
export function consumeMigrateLink(deps: MigrateDeps): MigrateOutcome | null {
  const { location: loc, history } = deps;
  if (!loc.hash.startsWith(MIGRATE_HASH_PREFIX)) return null;
  const payload = decodeMigratePayload(loc.hash.slice(MIGRATE_HASH_PREFIX.length));
  const trusted = fromLegacyOrigin(deps.referrer, deps.legacyOrigins);
  // A follow-up route is harmless (a room link or a setup link the user could open anyway), but
  // only a trusted hand-over carries one over; otherwise the fragment simply disappears.
  const next = payload && trusted ? payload.hash : '';
  try {
    history.replaceState(history.state, '', `${loc.pathname}${loc.search}${next}`);
  } catch {
    /* history unavailable */
  }
  if (!payload) return { status: 'invalid', result: null, notice: null };
  if (!trusted) return { status: 'foreign-referrer', result: null, notice: null };
  if (!deps.storage) return { status: 'no-storage', result: null, notice: null };
  const result = importItems(deps.storage, payload);
  const notice = migrationNotice(result);
  return { status: result.imported.length > 0 ? 'imported' : 'nothing-new', result, notice };
}
