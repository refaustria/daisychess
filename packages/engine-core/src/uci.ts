import type { BestMove, EngineInfo, Score } from './types.js';

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

/** Parse `bestmove e2e4 [ponder e7e5]`. `bestmove (none)` and other lines give null. */
export function parseUciBestMove(line: string): BestMove | null {
  const t = line.trim().split(/\s+/);
  if (t[0] !== 'bestmove' || !t[1] || t[1] === '(none)') return null;
  const result: BestMove = { move: t[1] };
  const p = t.indexOf('ponder');
  const ponder = p >= 0 ? t[p + 1] : undefined;
  if (ponder && ponder !== '(none)') result.ponder = ponder;
  return result;
}
