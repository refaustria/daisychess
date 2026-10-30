/**
 * Elo estimate of one side of one game (ADR-024 §5). Pure numbers — no chess.js — so the server,
 * the web and the calibration script (through the built package) share the same math.
 *
 * Two sources:
 * - **Maia maximum likelihood**: the probability the nine Maia levels give the *played* move in
 *   the scored positions ({@link selectEloPlies}) → a log-likelihood per level
 *   ({@link eloLikelihood}), refined by a parabola, with a likelihood-ratio band.
 * - **Offline fallback**: the side's mean win-probability loss mapped through a calibrated
 *   monotone table per speed class ({@link fallbackElo}, {@link EloCalibrationSchema}).
 */
import { z } from 'zod';

/** The Maia levels the estimate uses (the nine lichess-trained networks), ascending. */
export const MAIA_ELO_LEVELS = [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900] as const;
export type MaiaEloLevel = (typeof MAIA_ELO_LEVELS)[number];

/** Version of the Maia estimate method; a stored estimate of another version is recomputed. */
export const MAIA_ELO_VERSION = 1;
/** More scored positions than this are decimated evenly (ADR-024 §5). */
export const ELO_MAX_POSITIONS = 30;
/** Fewer scored positions than this give no estimate ("too few moves"). */
export const ELO_MIN_POSITIONS = 10;
/** Weight of the uniform mixture in {@link smoothPolicy}. */
export const ELO_SMOOTHING = 0.02;
/** Likelihood-ratio 95 % interval: χ²₁(0.95) / 2. */
export const ELO_BAND_DELTA_LL = 1.92;
/**
 * Estimate of a move's policy when the server did not return it (an older server answers with
 * the top 5 only): `min(minP, ELO_FLOOR_P) / 2`.
 */
export const ELO_FLOOR_P = 0.02;
/** A band built with floored samples is never narrower than ± this (ADR-024 §5). */
export const ELO_INEXACT_MIN_HALF_BAND = 200;
/** Scored positions are those whose mover win probability before the move is in this range. */
export const ELO_UNDECIDED_RANGE = { min: 10, max: 90 } as const;
/** Clamp and rounding of the fallback estimate. */
export const FALLBACK_ELO_BOUNDS = { min: 600, max: 2600, step: 50 } as const;

const LEVEL_STEP = 100;
const LOWEST = MAIA_ELO_LEVELS[0];
const HIGHEST = MAIA_ELO_LEVELS[MAIA_ELO_LEVELS.length - 1]!;

/**
 * `p̃ = 0.98·p + 0.02 / legalMoves`: a uniform mixture so that a move a level gives 0 % does not
 * zero that level's likelihood. `p` is clamped to 0…1, `legalMoves` to ≥ 1.
 */
export function smoothPolicy(p: number, legalMoves: number): number {
  const pp = Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0;
  const n = Number.isFinite(legalMoves) ? Math.max(1, Math.floor(legalMoves)) : 1;
  return (1 - ELO_SMOOTHING) * pp + ELO_SMOOTHING / n;
}

/** One scored position: the played move's policy probability at each Maia level. */
export interface EloSample {
  ply: number;
  /** Legal moves in the position before the move (for the smoothing). */
  legalMoves: number;
  /**
   * Policy probability (0…1) of the played move per level; `undefined` when the server did not
   * return it (outside the top 5 on a server older than ADR-024) — then the floor is used.
   */
  p: Partial<Record<MaiaEloLevel, number | undefined>>;
  /** Smallest probability the server returned for this position (for the floor). */
  minP?: number;
}

export interface EloLikelihood {
  /** Log-likelihood per level, in {@link MAIA_ELO_LEVELS} order. */
  ll: number[];
  /** Refined maximum-likelihood rating (rounded); undefined when the band spans all levels. */
  estimate: number | undefined;
  /** Lower end of the band; undefined when open (estimate at the low edge) or no estimate. */
  low: number | undefined;
  /** Upper end of the band; undefined when open (estimate at the high edge) or no estimate. */
  high: number | undefined;
  /** The maximum is at the edge of the grid: shown as "<1100" / ">1900". */
  edge?: 'low' | 'high';
  /** false when any sample used the floor for a missing probability. */
  exact: boolean;
}

/** Floor probability for a move the server did not return. */
function floorP(minP: number | undefined): number {
  const m = minP !== undefined && Number.isFinite(minP) && minP > 0 ? minP : ELO_FLOOR_P;
  return Math.min(m, ELO_FLOOR_P) / 2;
}

const roundTo = (x: number, step: number): number => Math.round(x / step) * step;

/**
 * Maximum-likelihood Elo over the Maia grid (ADR-024 §5): `LL(r) = Σ log p̃ᵢ(r)`, the argmax
 * refined by a parabola through its neighbours, the band = the contiguous levels around it
 * with `LL ≥ LL(r̂) − 1.92`. At the grid edges the estimate is the edge level, `edge` is set and
 * the band is open on that side. A band over all nine levels (e.g. no samples, or a flat
 * likelihood) gives no estimate. With floored samples (`exact: false`) the band is widened to at
 * least ±200 (rounded to 50, within the grid).
 */
export function eloLikelihood(samples: readonly EloSample[]): EloLikelihood {
  const ll = MAIA_ELO_LEVELS.map(() => 0);
  let exact = true;
  for (const s of samples) {
    MAIA_ELO_LEVELS.forEach((level, k) => {
      let p = s.p[level];
      if (p === undefined || !Number.isFinite(p)) {
        p = floorP(s.minP);
        exact = false;
      }
      ll[k]! += Math.log(smoothPolicy(p, s.legalMoves));
    });
  }
  const none: EloLikelihood = { ll, estimate: undefined, low: undefined, high: undefined, exact };
  const last = ll.length - 1;
  let i = 0;
  for (let k = 1; k <= last; k++) if (ll[k]! > ll[i]!) i = k;

  let offset = 0;
  let peak = ll[i]!;
  if (i > 0 && i < last) {
    const a = ll[i - 1]!;
    const b = ll[i]!;
    const c = ll[i + 1]!;
    const denom = a - 2 * b + c;
    if (denom < 0) {
      offset = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
      peak = Math.max(b, b - 0.25 * (a - c) * offset);
    }
  }
  const threshold = peak - ELO_BAND_DELTA_LL;
  let lo = i;
  let hi = i;
  while (lo > 0 && ll[lo - 1]! >= threshold) lo--;
  while (hi < last && ll[hi + 1]! >= threshold) hi++;
  if (lo === 0 && hi === last) return none;

  const level = (k: number): number => MAIA_ELO_LEVELS[k]!;
  const out: EloLikelihood = {
    ll,
    estimate: Math.round(level(i) + offset * LEVEL_STEP),
    low: level(lo),
    high: level(hi),
    exact,
  };
  if (i === 0) {
    out.edge = 'low';
    out.low = undefined;
  } else if (i === last) {
    out.edge = 'high';
    out.high = undefined;
  }
  if (!exact && out.estimate !== undefined) {
    const e = out.estimate;
    if (out.low !== undefined) {
      out.low = Math.max(LOWEST, Math.min(out.low, roundTo(e - ELO_INEXACT_MIN_HALF_BAND, 50)));
    }
    if (out.high !== undefined) {
      out.high = Math.min(HIGHEST, Math.max(out.high, roundTo(e + ELO_INEXACT_MIN_HALF_BAND, 50)));
    }
  }
  return out;
}

/** What {@link selectEloPlies} needs of a reviewed move (`ReviewedMove` fits). */
export interface EloPlyCandidate {
  ply: number;
  mover: 'white' | 'black';
  classification: string;
  /** Mover's win probability before the move, 0…100. */
  winProbBefore: number;
  /** Legal moves in the position before the move, when known (1 = forced). */
  legalMoves?: number;
}

/**
 * The positions scored for `side` (ADR-024 §5): its moves after the book (`ply > lastBookPly`;
 * pass 0 for a custom start), not forced, in an undecided position (`winProbBefore` 10…90).
 * More than `max` are decimated evenly (deterministic, first kept); fewer than `min` give `[]`.
 * Returns the selected entries in ply order.
 */
export function selectEloPlies<T extends EloPlyCandidate>(
  moves: readonly T[],
  side: 'white' | 'black',
  lastBookPly: number,
  max = ELO_MAX_POSITIONS,
  min = ELO_MIN_POSITIONS,
): T[] {
  const eligible = moves
    .filter(
      (m) =>
        m.mover === side &&
        m.ply > lastBookPly &&
        m.classification !== 'forced' &&
        (m.legalMoves === undefined || m.legalMoves > 1) &&
        m.winProbBefore >= ELO_UNDECIDED_RANGE.min &&
        m.winProbBefore <= ELO_UNDECIDED_RANGE.max,
    )
    .sort((a, b) => a.ply - b.ply);
  if (eligible.length < Math.max(1, min)) return [];
  const cap = Math.max(1, Math.floor(max));
  if (eligible.length <= cap) return eligible;
  const out: T[] = [];
  for (let k = 0; k < cap; k++) out.push(eligible[Math.floor((k * eligible.length) / cap)]!);
  return out;
}

export const SPEED_CLASSES = ['bullet', 'blitz', 'rapid', 'classical', 'unknown'] as const;
export type SpeedClass = (typeof SPEED_CLASSES)[number];

/**
 * Speed class from a PGN `TimeControl` header with lichess's rule: estimated duration =
 * initial + 40 × increment (seconds); < 3 min bullet, < 8 min blitz, < 25 min rapid, else
 * classical. Accepts `"180+2"`, `"600"` and the first period of `"40/7200:3600"`; a missing,
 * `"-"`, `"?"` or unparsable value is `unknown`.
 */
export function speedClass(timeControl?: string): SpeedClass {
  if (timeControl === undefined) return 'unknown';
  const first = timeControl.trim().split(':')[0] ?? '';
  const m = /^(?:\d+\/)?(\d+)(?:\+(\d+(?:\.\d+)?))?$/.exec(first);
  if (!m) return 'unknown';
  const initial = Number(m[1]);
  const increment = m[2] === undefined ? 0 : Number(m[2]);
  if (!Number.isFinite(initial) || !Number.isFinite(increment)) return 'unknown';
  const total = initial + 40 * increment;
  if (total <= 0) return 'unknown';
  if (total < 180) return 'bullet';
  if (total < 480) return 'blitz';
  if (total < 1500) return 'rapid';
  return 'classical';
}

const eloRating = (name: string) =>
  z
    .number()
    .int(`${name} must be an integer`)
    .min(800, `${name} must be >= 800`)
    .max(2200, `${name} must be <= 2200`);

/** A stored Maia estimate of one side (ADR-024 §5). The fallback is never stored. */
export const EloEstimateSchema = z.object({
  method: z.literal('maia'),
  rating: eloRating('elo.rating'),
  low: eloRating('elo.low').optional(),
  high: eloRating('elo.high').optional(),
  edge: z.enum(['low', 'high']).optional(),
  /** Scored positions the estimate is based on. */
  positions: z.number().int().min(0).max(1_000),
  exact: z.boolean(),
  maiaVersion: z.number().int().min(1).max(1_000),
});
export type EloEstimate = z.infer<typeof EloEstimateSchema>;

/** `[meanLoss (0…100), rating]`. */
const KnotSchema = z.tuple([z.number().min(0).max(100), z.number().min(0).max(4_000)]);

/** One speed class's curve: knots ascending in mean loss, and the residual standard deviation. */
export const EloCurveSchema = z.object({
  knots: z
    .array(KnotSchema)
    .min(2)
    .max(32)
    .refine((k) => k.every((p, i) => i === 0 || p[0] > k[i - 1]![0]), {
      message: 'knots must be strictly ascending in mean loss',
    }),
  residualSd: z.number().min(0).max(1_000),
});
export type EloCurve = z.infer<typeof EloCurveSchema>;

/**
 * The committed fallback table (`apps/web/src/review/data/eloCalibration.json`, ADR-024 §5).
 * `unknown` is required so every speed class has a curve to fall back to.
 */
export const EloCalibrationSchema = z.object({
  version: z.literal(1),
  source: z.object({
    /** `YYYY-MM` of the lichess dump, or `provisional` for the hand-set curve. */
    month: z.string().regex(/^(\d{4}-\d{2}|provisional)$/, 'month must be YYYY-MM or provisional'),
    games: z.number().int().min(0),
    sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters')
      .optional(),
  }),
  speeds: z.object({
    bullet: EloCurveSchema.optional(),
    blitz: EloCurveSchema.optional(),
    rapid: EloCurveSchema.optional(),
    classical: EloCurveSchema.optional(),
    unknown: EloCurveSchema,
  }),
});
export type EloCalibration = z.infer<typeof EloCalibrationSchema>;

/**
 * Offline estimate from the side's mean win-probability loss (ADR-024 §5): linear interpolation
 * over the speed class's knots (the `unknown` curve when the class has none; flat beyond the
 * ends), clamped to 600…2600 and rounded to 50. `sd` is the curve's residual sd rounded to 50
 * (at least 50).
 */
export function fallbackElo(
  meanLoss: number,
  speed: SpeedClass,
  table: EloCalibration,
): { rating: number; sd: number } {
  const curve = table.speeds[speed] ?? table.speeds.unknown;
  const knots = curve.knots;
  const x = Number.isFinite(meanLoss) ? meanLoss : 0;
  let rating: number;
  const first = knots[0]!;
  const lastKnot = knots[knots.length - 1]!;
  if (x <= first[0]) rating = first[1];
  else if (x >= lastKnot[0]) rating = lastKnot[1];
  else {
    let k = 1;
    while (knots[k]![0] < x) k++;
    const [x0, y0] = knots[k - 1]!;
    const [x1, y1] = knots[k]!;
    rating = y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  const { min, max, step } = FALLBACK_ELO_BOUNDS;
  return {
    rating: roundTo(Math.min(max, Math.max(min, rating)), step),
    sd: Math.max(step, roundTo(curve.residualSd, step)),
  };
}
