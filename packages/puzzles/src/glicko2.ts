/**
 * Glicko-2 (Mark Glickman, "Example of the Glicko-2 system", 2022), used for the local puzzle
 * rating: one rating period per puzzle, the puzzle is the opponent with its lichess rating/RD.
 */

export interface GlickoRating {
  rating: number;
  rd: number;
  /** Volatility σ. */
  vol: number;
}

export interface GlickoResult {
  /** Opponent rating and RD (Glicko scale). */
  rating: number;
  rd: number;
  /** 1 = win (solved), 0 = loss (failed), 0.5 = draw. */
  score: number;
}

/** Start values of a new player (ADR-023 §7). */
export const GLICKO_DEFAULT: Readonly<GlickoRating> = { rating: 1500, rd: 350, vol: 0.09 };
/** System constant τ of the puzzle rating (lichess puzzles). */
export const PUZZLE_TAU = 0.75;
/** RD never grows beyond the start value. */
export const MAX_RD = 350;

const SCALE = 173.7178;
const EPSILON = 1e-6;

const g = (phi: number): number => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const expected = (mu: number, muJ: number, phiJ: number): number =>
  1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/**
 * One Glicko-2 rating period. With no results only the RD grows (by the volatility). Results
 * use the Glicko scale. The new RD is capped at {@link MAX_RD}; inputs are not validated beyond
 * finiteness (a non-finite input returns the player unchanged).
 */
export function glicko2Update(
  player: GlickoRating,
  results: readonly GlickoResult[],
  tau: number = PUZZLE_TAU,
): GlickoRating {
  const finite = [
    player.rating,
    player.rd,
    player.vol,
    tau,
    ...results.flatMap((r) => [r.rating, r.rd, r.score]),
  ];
  if (!finite.every(Number.isFinite) || player.rd <= 0 || player.vol <= 0) return { ...player };
  const mu = (player.rating - 1500) / SCALE;
  const phi = player.rd / SCALE;
  const sigma = player.vol;

  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return { rating: player.rating, rd: Math.min(MAX_RD, phiStar * SCALE), vol: sigma };
  }

  let vInv = 0;
  let deltaSum = 0;
  for (const r of results) {
    const muJ = (r.rating - 1500) / SCALE;
    const phiJ = r.rd / SCALE;
    const e = expected(mu, muJ, phiJ);
    vInv += g(phiJ) ** 2 * e * (1 - e);
    deltaSum += g(phiJ) * (r.score - e);
  }
  const v = 1 / vInv;
  const delta = v * deltaSum;

  // Step 5: new volatility (Illinois algorithm).
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    return (
      (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) -
      (x - a) / (tau * tau)
    );
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0 && k < 1000) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; Math.abs(B - A) > EPSILON && i < 1000; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const sigmaNew = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + sigmaNew * sigmaNew);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * deltaSum;
  return {
    rating: 1500 + muNew * SCALE,
    rd: Math.min(MAX_RD, phiNew * SCALE),
    vol: sigmaNew,
  };
}

/** Display form "1620 ± 85" (rounded). */
export function formatPuzzleRating(r: Pick<GlickoRating, 'rating' | 'rd'>): string {
  return `${Math.round(r.rating)} ± ${Math.round(r.rd)}`;
}
