import { z } from 'zod';
import type { TbCategory, TbMove, TbPosition } from './types.js';

/**
 * Categories the lichess tablebase API (`lichess-org/lila-tablebase`) answers with. `unknown`
 * and `maybe-*` (DTZ rounding makes the 50-move outcome uncertain) are not exact data.
 */
export const LICHESS_CATEGORIES = [
  'win',
  'unknown',
  'syzygy-win',
  'maybe-win',
  'cursed-win',
  'draw',
  'blessed-loss',
  'maybe-loss',
  'syzygy-loss',
  'loss',
] as const;

export type LichessCategory = (typeof LICHESS_CATEGORIES)[number];

const optInt = z.number().int().nullable().optional();

export const LichessTablebaseMoveSchema = z.object({
  uci: z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/),
  san: z.string().min(1).max(10),
  category: z.enum(LICHESS_CATEGORIES),
  dtz: optInt,
  precise_dtz: optInt,
  dtm: optInt,
  zeroing: z.boolean().optional(),
  checkmate: z.boolean().optional(),
  stalemate: z.boolean().optional(),
});

/** Zod schema of `GET https://tablebase.lichess.ovh/standard?fen=…` (unknown keys stripped). */
export const LichessTablebaseSchema = z.object({
  category: z.enum(LICHESS_CATEGORIES),
  dtz: optInt,
  precise_dtz: optInt,
  dtm: optInt,
  checkmate: z.boolean().optional(),
  stalemate: z.boolean().optional(),
  moves: z.array(LichessTablebaseMoveSchema).max(256),
});

export type LichessTablebase = z.infer<typeof LichessTablebaseSchema>;

/** Exact category, or undefined for `unknown`/`maybe-*`. */
function exactCategory(c: LichessCategory): TbCategory | undefined {
  switch (c) {
    case 'win':
    case 'syzygy-win':
      return 'win';
    case 'loss':
    case 'syzygy-loss':
      return 'loss';
    case 'cursed-win':
    case 'draw':
    case 'blessed-loss':
      return c;
    default:
      return undefined;
  }
}

const num = (precise: number | null | undefined, rounded: number | null | undefined) =>
  precise ?? rounded ?? undefined;

/**
 * Validates and normalises a lichess API answer for `fen`. Returns null when the JSON does not
 * match the schema or when the position **or any of its moves** has an inexact category
 * (`unknown`, `maybe-*`): such answers are never shown as data. `dtz` prefers `precise_dtz`.
 */
export function normalizeLichess(json: unknown, fen: string): TbPosition | null {
  const parsed = LichessTablebaseSchema.safeParse(json);
  if (!parsed.success) return null;
  const data = parsed.data;
  const category = exactCategory(data.category);
  if (!category) return null;
  const moves: TbMove[] = [];
  for (const m of data.moves) {
    const mc = exactCategory(m.category);
    if (!mc) return null;
    const move: TbMove = {
      uci: m.uci,
      san: m.san,
      category: mc,
      zeroing: m.zeroing ?? false,
      checkmate: m.checkmate ?? false,
      stalemate: m.stalemate ?? false,
    };
    const dtz = num(m.precise_dtz, m.dtz);
    if (dtz !== undefined) move.dtz = dtz;
    if (m.dtm !== null && m.dtm !== undefined) move.dtm = m.dtm;
    moves.push(move);
  }
  const pos: TbPosition = { fen, category, moves };
  const dtz = num(data.precise_dtz, data.dtz);
  if (dtz !== undefined) pos.dtz = dtz;
  if (data.dtm !== null && data.dtm !== undefined) pos.dtm = data.dtm;
  return pos;
}
