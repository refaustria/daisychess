/**
 * Engine strength presets for "Play vs Engine".
 *
 * Stockfish limits its play with `UCI_LimitStrength` + `UCI_Elo` (accepted range 1320–3190,
 * calibrated against CCRL 40/4 at about 120 s + 1 s per game). "Full strength" switches the limit
 * off again. `Skill Level` (0–20) is not used: Elo presets are easier to understand and both
 * options cannot be combined meaningfully.
 */
export interface StrengthPreset {
  id: string;
  label: string;
  /** Target Elo; undefined = full strength (or a human-like engine, see `human`). */
  elo?: number;
  /**
   * A human-like engine of the server (Maia, ADR-019): the server engine id `maia-<rating>`
   * plays the moves players of `rating` would play. Absent = Stockfish in the browser.
   */
  human?: { rating: number };
}

export const MIN_UCI_ELO = 1320;
export const MAX_UCI_ELO = 3190;

export const STRENGTH_PRESETS: readonly StrengthPreset[] = [
  { id: '1350', label: '1350 Elo', elo: 1350 },
  { id: '1500', label: '1500 Elo', elo: 1500 },
  { id: '1800', label: '1800 Elo', elo: 1800 },
  { id: '2100', label: '2100 Elo', elo: 2100 },
  { id: '2400', label: '2400 Elo', elo: 2400 },
  { id: '2800', label: '2800 Elo', elo: 2800 },
  { id: 'full', label: 'Full strength' },
];

/** Ratings of the Maia networks the server ships (ADR-019). */
export const MAIA_RATINGS: readonly number[] = [
  1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900,
];

/** Server engine id of a Maia level (`maia-1500`); also the preset id. */
export const maiaEngineId = (rating: number): string => `maia-${rating}`;

/** Human-like opponents (Maia on the engine server); their id is the server engine id. */
export const HUMAN_PRESETS: readonly StrengthPreset[] = MAIA_RATINGS.map((rating) => ({
  id: maiaEngineId(rating),
  label: `Maia ${rating}`,
  human: { rating },
}));

export const DEFAULT_STRENGTH = '1500';
export const DEFAULT_MAIA = maiaEngineId(1500);

export function findStrength(id: string): StrengthPreset {
  return (
    STRENGTH_PRESETS.find((p) => p.id === id) ??
    HUMAN_PRESETS.find((p) => p.id === id) ??
    (STRENGTH_PRESETS[1] as StrengthPreset)
  );
}

/** True for a human-like (Maia) preset id. */
export const isHumanStrength = (id: string): boolean => findStrength(id).human !== undefined;

/** UCI options for a preset; "Full strength" clears the limit. Human-like engines take none. */
export function strengthOptions(p: StrengthPreset): Record<string, string | number | boolean> {
  if (p.human) return {};
  if (p.elo === undefined) return { UCI_LimitStrength: false };
  const elo = Math.round(Math.min(MAX_UCI_ELO, Math.max(MIN_UCI_ELO, p.elo)));
  return { UCI_LimitStrength: true, UCI_Elo: elo };
}

/** Thinking time per engine move (ms). */
export const MOVE_TIMES: readonly { ms: number; label: string }[] = [
  { ms: 100, label: '0.1 s' },
  { ms: 500, label: '0.5 s' },
  { ms: 1000, label: '1 s' },
  { ms: 3000, label: '3 s' },
];

export const DEFAULT_MOVE_TIME = 500;
