// Hand-tuned profile of a Staunton-style pawn for three.js LatheGeometry (x = radius, y = height,
// both in scene units, base at y = 0). Pure and dependency-free so it can be unit-tested.

export interface ProfilePoint {
  x: number;
  y: number;
}

/** Height of the top of the head. */
export const PAWN_HEIGHT = 1.8;
/** Centre and radius of the head sphere. */
export const HEAD = { y: 1.5, r: 0.3 } as const;

/**
 * Control points of the body from the base edge up to the neck. Consecutive duplicates mark corners
 * that must stay crisp; everything else is smoothed with a centripetal Catmull-Rom spline.
 */
const BODY: readonly ProfilePoint[] = [
  { x: 0.62, y: 0.0 },
  { x: 0.645, y: 0.035 },
  { x: 0.645, y: 0.1 },
  { x: 0.61, y: 0.14 },
  { x: 0.545, y: 0.165 },
  { x: 0.525, y: 0.215 },
  { x: 0.47, y: 0.265 },
  { x: 0.425, y: 0.295 },
  { x: 0.445, y: 0.335 },
  { x: 0.405, y: 0.375 },
  { x: 0.32, y: 0.48 },
  { x: 0.245, y: 0.7 },
  { x: 0.205, y: 0.94 },
  { x: 0.205, y: 1.05 },
  { x: 0.27, y: 1.09 },
  { x: 0.335, y: 1.125 },
  { x: 0.34, y: 1.16 },
  { x: 0.3, y: 1.195 },
  { x: 0.19, y: 1.215 },
  { x: 0.155, y: 1.25 },
];

function catmullRom(p0: ProfilePoint, p1: ProfilePoint, p2: ProfilePoint, p3: ProfilePoint, t: number): ProfilePoint {
  // Centripetal parameterisation (alpha = 0.5) avoids cusps and overshoot on uneven spacing.
  const d = (a: ProfilePoint, b: ProfilePoint) => Math.max(Math.hypot(b.x - a.x, b.y - a.y) ** 0.5, 1e-6);
  const t0 = 0;
  const t1 = t0 + d(p0, p1);
  const t2 = t1 + d(p1, p2);
  const t3 = t2 + d(p2, p3);
  const tt = t1 + (t2 - t1) * t;
  const lerp = (a: ProfilePoint, b: ProfilePoint, ta: number, tb: number): ProfilePoint => {
    const w = (tt - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/**
 * The full outline from the centre of the base (0, 0) to the top of the head (0, PAWN_HEIGHT),
 * monotonic in the order a lathe needs. `detail` = samples per body segment (>= 1).
 */
export function pawnProfile(detail = 6, headSegments = 28): ProfilePoint[] {
  const n = Math.max(1, Math.floor(detail));
  const out: ProfilePoint[] = [{ x: 0, y: 0 }];
  for (let i = 0; i < BODY.length - 1; i++) {
    const p1 = BODY[i]!;
    const p2 = BODY[i + 1]!;
    const p0 = BODY[i - 1] ?? { x: p1.x * 2 - p2.x, y: p1.y * 2 - p2.y };
    const p3 = BODY[i + 2] ?? { x: p2.x * 2 - p1.x, y: p2.y * 2 - p1.y };
    for (let s = 0; s < n; s++) out.push(catmullRom(p0, p1, p2, p3, s / n));
  }
  const neck = BODY[BODY.length - 1]!;
  out.push(neck);
  // Head: arc of the sphere from the neck radius up to the pole.
  const start = Math.asin(Math.min(1, neck.x / HEAD.r)); // angle from the downward axis
  const a0 = Math.PI - start;
  const segs = Math.max(4, Math.floor(headSegments));
  for (let s = 1; s <= segs; s++) {
    const a = a0 - (a0 * s) / segs; // angle from the upward axis, a0 -> 0
    out.push({ x: Math.max(0, HEAD.r * Math.sin(a)), y: HEAD.y + HEAD.r * Math.cos(a) });
  }
  const last = out[out.length - 1]!;
  last.x = 0;
  last.y = HEAD.y + HEAD.r;
  return out;
}

/** Largest radius of the profile (for framing and the contact shadow). */
export function profileMaxRadius(points: readonly ProfilePoint[]): number {
  return points.reduce((m, p) => Math.max(m, p.x), 0);
}
