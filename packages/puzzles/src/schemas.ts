import { z } from 'zod';

/**
 * Data formats of the puzzle files (ADR-023 §3). Every file carries `format: 1`, the same number
 * as the URL path (`/puzzles/v1/`); a format change is a new path and new schemas.
 */
export const PUZZLE_FORMAT = 1;
/** Width of a rating band (points). */
export const BAND_SIZE = 100;
/** Lowest band (ratings below are not curated; `bandOf` clamps to it). */
export const MIN_BAND = 500;
/** Highest band; open-ended (2900 holds every rating ≥ 2900). */
export const MAX_BAND = 2900;

/** One side of the board. */
export type Side = 'white' | 'black';

/** Engine score: centipawns or mate in N (sign = who mates). */
export type Score = { cp: number } | { mate: number };

/** Runtime puzzle (both stages; one solver). */
export interface Puzzle {
  /** lichess PuzzleId, or `m:<16 hex of sha256(fen of the mistake)>` for a mistake puzzle. */
  id: string;
  /** Position BEFORE `moves[0]`. */
  fen: string;
  /**
   * UCI. `moves[0]` is the opponent's move (played by the app); the user plays `moves[1]`,
   * `moves[3]`, … — unless {@link Puzzle.noIntro} is set.
   */
  moves: string[];
  /** lichess puzzle Glicko-2 values; absent for mistake puzzles (unrated). */
  rating?: number;
  rd?: number;
  /** lichess theme keys; labels are ours (`themes.ts`). */
  themes: string[];
  /** lichess OpeningTags, family tag first. */
  openings: string[];
  /** lichess GameUrl without `https://lichess.org/`, e.g. `787zsVup/black#48`. */
  game?: string;
  source: 'lichess' | 'mistake';
  /**
   * Mistake puzzle at ply 1 only (no previous opponent move, ADR-023 §9): the user is to move in
   * `fen` and plays `moves[0]`, `moves[2]`, … Absent (= false) for every lichess puzzle.
   */
  noIntro?: boolean;
}

const uci = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const int = z.number().int();
const nonNegInt = int.nonnegative();

/** Space-separated UCI line of 2…20 plies. */
const UciLineSchema = z
  .string()
  .max(20 * 6)
  .refine((s) => {
    const parts = s.split(' ');
    return parts.length >= 2 && parts.length <= 20 && parts.every((m) => uci.test(m));
  }, 'moves must be 2…20 space-separated UCI moves');

/**
 * Compact row of a shard / the starter:
 * `[id, fen, moves (space-separated UCI), rating, rd, themeIdx[], openingIdx[], game]`.
 * `themeIdx`/`openingIdx` index the `themes`/`openings` lists of the index (or the starter).
 * `game` is `''` when unknown.
 */
export const PuzzleRowSchema = z.tuple([
  z.string().min(1).max(16),
  z.string().min(10).max(100),
  UciLineSchema,
  int.min(0).max(4000),
  nonNegInt.max(500),
  z.array(nonNegInt).max(32),
  z.array(nonNegInt).max(8),
  z.string().max(64),
]);
export type PuzzleRow = z.infer<typeof PuzzleRowSchema>;

/** Rating band: multiple of 100 in 500…2900. */
const BandSchema = int.min(MIN_BAND).max(MAX_BAND).multipleOf(BAND_SIZE);

/** `Record<number, number>` with JSON's string keys (non-negative integer keys only). */
const CountMapSchema = z
  .record(z.string().regex(/^(0|[1-9]\d*)$/), nonNegInt)
  .transform((r) => r as Record<number, number>);

/** One shard file (`shards/<band>-<16 hex>.json`): ≤ 2,000 rows of one band, sorted by id. */
export const ShardSchema = z.object({
  format: z.literal(PUZZLE_FORMAT),
  /** sha256 of the source dump (= `index.dataset.sha256`): recognises shards of an older dataset. */
  dataset: z.string().min(1),
  band: BandSchema,
  rows: z.array(PuzzleRowSchema),
});
export type Shard = z.infer<typeof ShardSchema>;

export const DatasetInfoSchema = z.object({
  /** Download URL of the dump. */
  source: z.string(),
  /** sha256 of the dump (hex). */
  sha256: z.string(),
  /** `Last-Modified` of the dump. */
  lastModified: z.string(),
  /** ISO date of the build. */
  builtAt: z.string(),
  /** Puzzles in all shards. */
  total: nonNegInt,
});
export type DatasetInfo = z.infer<typeof DatasetInfoSchema>;

export const ShardEntrySchema = z.object({
  file: z.string().regex(/^shards\/\d{3,4}-[0-9a-f]{16}\.json$/),
  band: BandSchema,
  count: nonNegInt,
  bytes: nonNegInt,
  /** Theme index → puzzles of this shard with the theme. */
  themes: CountMapSchema,
  /** Opening-family index (into `openings`) → puzzles of this shard in the family. */
  families: CountMapSchema,
});
export type ShardEntry = z.infer<typeof ShardEntrySchema>;

/** `index.json`. */
export const PuzzleIndexSchema = z
  .object({
    format: z.literal(PUZZLE_FORMAT),
    dataset: DatasetInfoSchema,
    themes: z.array(z.string()),
    openings: z.array(z.string()),
    /** Indexes into `openings` of the tags that are families. */
    families: z.array(nonNegInt),
    bandSize: z.literal(BAND_SIZE),
    shards: z.array(ShardEntrySchema),
    counts: z.object({ themes: z.array(nonNegInt), openings: z.array(nonNegInt) }),
  })
  .refine(
    (ix) =>
      ix.counts.themes.length === ix.themes.length &&
      ix.counts.openings.length === ix.openings.length &&
      ix.families.every((f) => f < ix.openings.length),
    'counts/families must match the themes/openings lists',
  );
export type PuzzleIndex = z.infer<typeof PuzzleIndexSchema>;

/** Bundled starter set (`apps/web/src/puzzles/data/starter.json`). */
export const StarterSchema = z
  .object({
    format: z.literal(PUZZLE_FORMAT),
    dataset: z.string().min(1),
    themes: z.array(z.string()),
    openings: z.array(z.string()),
    rows: z.array(PuzzleRowSchema),
    /** Row indexes of the daily pool (seeded shuffle). */
    daily: z.array(nonNegInt),
  })
  .refine((s) => s.daily.every((i) => i < s.rows.length), 'daily indexes out of range');
export type Starter = z.infer<typeof StarterSchema>;

/** Theme and opening lists a {@link PuzzleRow} indexes into (an index, a starter, a dictionary). */
export interface RowDictionary {
  themes: readonly string[];
  openings: readonly string[];
}
