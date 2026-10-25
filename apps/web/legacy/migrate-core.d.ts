// Types for migrate-core.js (plain browser ESM served by nginx without a build step).
export const TARGET_ORIGIN: string;
export const KEY_PREFIX: string;
export const EXCLUDED_KEYS: readonly string[];
export const MAX_FRAGMENT_LENGTH: number;
export const ROOM_KEY_PREFIX: string;
export const TRAINER_KEY: string;
export const ESSENTIAL_KEYS: readonly string[];
export type LegacyStorage = Pick<Storage, 'length' | 'key' | 'getItem'>;
export type CompressionStreamCtor = new (format: 'deflate-raw') => CompressionStream;
export function collectItems(storage: LegacyStorage | undefined): Record<string, string>;
export function dropOrder(items: Record<string, string>): string[];
export function followUpHash(hash: unknown): string;
export function bytesToBase64Url(bytes: Uint8Array): string;
export function deflateRaw(
  bytes: Uint8Array,
  ctor: CompressionStreamCtor | undefined,
): Promise<Uint8Array | null>;
export function encodePayload(
  obj: unknown,
  ctor: CompressionStreamCtor | undefined,
): Promise<string>;
export function buildMigrateUrl(opts: {
  storage: LegacyStorage | undefined;
  hash: string;
  CompressionStream: CompressionStreamCtor | undefined;
  maxFragment?: number;
}): Promise<{ url: string; dropped: string[]; moved: string[] }>;
export function run(win?: {
  localStorage: LegacyStorage;
  location: Pick<Location, 'hash' | 'replace'>;
  CompressionStream?: CompressionStreamCtor;
}): Promise<string>;
