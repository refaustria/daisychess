import type { BestMove, EngineInfo, PolicyEntry, Score } from './types.js';

/**
 * Null moves some engines print when there is no legal move: `0000` (UCI standard) and
 * `a1a1` (Lc0 on a checkmated or stalemated position). Treated like `(none)`.
 */
const NULL_MOVES = new Set(['0000', 'a1a1']);

const UCI_MOVE = /^[a-h][1-8][a-h][1-8][nbrq]?$/;

/** Parse a UCI `info` line. Returns null for lines without `score` or `pv`. */
export function parseUciInfo(line: string): EngineInfo | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info') return null;
  let depth: number | undefined;
  let seldepth: number | undefined;
  let multipv = 1;
  let score: Score | undefined;
  let nps: number | undefined;
  let nodes: number | undefined;
  let time: number | undefined;
  let pv: string[] | undefined;
  const num = (s: string | undefined): number | undefined => {
    if (s === undefined) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  for (let i = 1; i < t.length; i++) {
    switch (t[i]) {
      case 'depth':
        depth = num(t[++i]);
        break;
      case 'seldepth':
        seldepth = num(t[++i]);
        break;
      case 'multipv':
        multipv = num(t[++i]) ?? 1;
        break;
      case 'nps':
        nps = num(t[++i]);
        break;
      case 'nodes':
        nodes = num(t[++i]);
        break;
      case 'time':
        time = num(t[++i]);
        break;
      case 'score': {
        const kind = t[++i];
        const v = num(t[++i]);
        if (v !== undefined) {
          if (kind === 'cp') score = { cp: v };
          else if (kind === 'mate') score = { mate: v };
        }
        break;
      }
      case 'lowerbound':
      case 'upperbound':
        break;
      case 'pv':
        pv = t.slice(i + 1);
        i = t.length;
        break;
      default:
        break;
    }
  }
  if (!pv || pv.length === 0 || !score || depth === undefined) return null;
  const info: EngineInfo = { depth, multipv, score, pv };
  if (seldepth !== undefined) info.seldepth = seldepth;
  if (nps !== undefined) info.nps = nps;
  if (nodes !== undefined) info.nodes = nodes;
  if (time !== undefined) info.time = time;
  return info;
}

/**
 * Parse `bestmove e2e4 [ponder e7e5]`. `bestmove (none)`, the null moves `0000`/`a1a1` (Lc0 on
 * a terminal position) and other lines give null.
 */
export function parseUciBestMove(line: string): BestMove | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'bestmove' || !t[1] || t[1] === '(none)' || NULL_MOVES.has(t[1])) return null;
  const result: BestMove = { move: t[1] };
  const p = t.indexOf('ponder');
  const ponder = p >= 0 ? t[p + 1] : undefined;
  if (ponder && ponder !== '(none)' && !NULL_MOVES.has(ponder)) result.ponder = ponder;
  return result;
}

/**
 * Parse one Lc0 `VerboseMoveStats` line (ADR-019), printed per legal move at the end of a search:
 *
 *     info string e2e4  (322 ) N:       0 (+ 0) (P: 50.22%) (WL: ...) (D: ...) ... (V:  -.----)
 *
 * Returns the move and its policy prior `p` as a fraction (0.5022), or null for any other line —
 * including Lc0's root summary `info string node  (  20) N: ...`.
 */
export function parseLc0MoveStats(line: string): PolicyEntry | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'info' || t[1] !== 'string' || !t[2] || !UCI_MOVE.test(t[2])) return null;
  const m = /\(P:\s*(\d+(?:\.\d+)?)%\)/.exec(line);
  if (!m?.[1]) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return { uci: t[2], p: Math.round(pct * 100) / 10_000 };
}

/** The `n` most probable entries, most probable first (stable for equal probabilities). */
export function topPolicy(entries: readonly PolicyEntry[], n = 5): PolicyEntry[] {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.p - a.e.p || a.i - b.i)
    .slice(0, Math.max(0, n))
    .map(({ e }) => e);
}
