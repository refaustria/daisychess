/**
 * Token formats of the hub (ADR-020 §2). Pure string helpers shared by the hub (minting,
 * lookup), the node CLI (config validation) and the web app (telling a `dc1_` token from a legacy
 * `ACCESS_TOKEN` in Settings). No hashing or randomness here: secrets are generated and hashed on
 * the server, which has `node:crypto`; engine-core stays free of platform specifics.
 *
 * Formats (fixed length, case-sensitive, lowercase RFC 4648 base32 without padding):
 * - player token `dc1_<tokenId>_<secret>` — `dc1` = DaisyChess token format 1
 * - node token   `dcn_<nodeId>_<secret>`  — the credential of a node's link
 * where the id is 8 characters (40 bits, public: logs, portal, error messages) and the secret is
 * 32 characters (160 bits, shown once, stored as a SHA-256 hash). Everything else that is not
 * empty and carries no reserved prefix is a *legacy* token: the shared `ACCESS_TOKEN` of
 * ADR-010, which the hub keeps accepting (routed to its built-in node `local`).
 */
import { z } from 'zod';
import { MAX_TOKEN_LENGTH } from './protocol.js';

/** RFC 4648 base32 alphabet, lowercase, no padding. 5 bits per character. */
export const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const TOKEN_ID_LENGTH = 8;
export const TOKEN_SECRET_LENGTH = 32;

/** What a token identifies: a player's device/person (`dc1_`) or a node (`dcn_`). */
export const TOKEN_KINDS = ['player', 'node'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/** Prefix per kind, including the separator. Any token starting with one of these is *not* legacy. */
export const TOKEN_PREFIXES: Readonly<Record<TokenKind, string>> = Object.freeze({
  player: 'dc1_',
  node: 'dcn_',
});

export const TOKEN_PATTERNS = {
  /** `tokenId` / `nodeId`. */
  id: /^[a-z2-7]{8}$/,
  secret: /^[a-z2-7]{32}$/,
  player: /^dc1_([a-z2-7]{8})_([a-z2-7]{32})$/,
  node: /^dcn_([a-z2-7]{8})_([a-z2-7]{32})$/,
} as const;

/** Length of a well-formed token of either kind: prefix + id + `_` + secret. */
export const TOKEN_LENGTH = 4 + TOKEN_ID_LENGTH + 1 + TOKEN_SECRET_LENGTH;

/** Public id of a player token or node (8 base32 characters). Used on the wire and in logs. */
export const TokenIdSchema = z
  .string()
  .regex(TOKEN_PATTERNS.id, 'id must be 8 characters of [a-z2-7]');

/**
 * Access tiers of a player token (ADR-020 §2). The hub maps a tier to limits and composes
 * `welcome.limits = min(tier, node)`; the numbers are hub policy (operator-adjustable later) and
 * deliberately not part of the protocol.
 */
export const TOKEN_TIERS = ['small', 'standard', 'full'] as const;
export type TokenTier = (typeof TOKEN_TIERS)[number];
export const TokenTierSchema = z.enum(TOKEN_TIERS);

export interface ParsedToken {
  kind: TokenKind;
  /** `tokenId` (player) or `nodeId` (node). */
  id: string;
  secret: string;
}

/**
 * Builds a token from its parts. Throws `TypeError` when a part is malformed: this is the minting
 * side (the hub generates id and secret itself), so a bad part is a programming error, not input.
 */
export function formatToken(kind: TokenKind, id: string, secret: string): string {
  if (!TOKEN_KINDS.includes(kind)) throw new TypeError(`unknown token kind ${String(kind)}`);
  if (!TOKEN_PATTERNS.id.test(id)) throw new TypeError('token id must be 8 characters of [a-z2-7]');
  if (!TOKEN_PATTERNS.secret.test(secret)) {
    throw new TypeError('token secret must be 32 characters of [a-z2-7]');
  }
  return `${TOKEN_PREFIXES[kind]}${id}_${secret}`;
}

/**
 * Splits a well-formed `dc1_`/`dcn_` token into its parts; null for anything else (wrong prefix,
 * wrong length, characters outside the alphabet, uppercase, whitespace). Strict on purpose: the
 * hub answers `bad_token` for null without touching its store, and a legacy token is recognised
 * separately with {@link isLegacyToken}. Never logs or returns anything but the given parts.
 */
export function parseToken(raw: unknown): ParsedToken | null {
  if (typeof raw !== 'string' || raw.length !== TOKEN_LENGTH) return null;
  for (const kind of TOKEN_KINDS) {
    const match = TOKEN_PATTERNS[kind].exec(raw);
    if (match) return { kind, id: match[1] as string, secret: match[2] as string };
  }
  return null;
}

/**
 * True for a token the hub must compare against its legacy `ACCESS_TOKEN` (ADR-010/020 §2):
 * non-empty, within {@link MAX_TOKEN_LENGTH}, and not carrying a reserved prefix. A token that
 * starts with `dc1_`/`dcn_` but fails {@link parseToken} is neither (→ `bad_token`), so a
 * legacy `ACCESS_TOKEN` must not start with a reserved prefix.
 */
export function isLegacyToken(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_TOKEN_LENGTH) return false;
  return !hasReservedPrefix(raw);
}

/** True when `raw` starts with one of {@link TOKEN_PREFIXES}. */
export function hasReservedPrefix(raw: string): boolean {
  return TOKEN_KINDS.some((kind) => raw.startsWith(TOKEN_PREFIXES[kind]));
}
