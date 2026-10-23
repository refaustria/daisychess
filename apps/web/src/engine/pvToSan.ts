import { Chess } from 'chess.js';

export interface ConvertedPv {
  /** SAN moves, truncated at the first illegal move. */
  san: string[];
  /** Move numbers + SAN, e.g. `12. Nf3 Nc6 13. O-O` or `12... Nc6`. */
  text: string;
  /** FEN after the last converted move (the input FEN if none). */
  fen: string;
  /** Number of UCI moves converted. */
  count: number;
}

const CACHE_LIMIT = 300;
const cache = new Map<string, ConvertedPv>();

/** Converts a UCI principal variation to SAN from `fen`; stops at the first illegal move. Memoised. */
export function convertPv(fen: string, pv: readonly string[]): ConvertedPv {
  const key = `${fen}|${pv.join(' ')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = compute(fen, pv);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

function compute(fen: string, pv: readonly string[]): ConvertedPv {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return { san: [], text: '', fen, count: 0 };
  }
  const parts = fen.split(' ');
  let white = parts[1] !== 'b';
  let num = Number(parts[5]) || 1;
  const san: string[] = [];
  const tokens: string[] = [];
  for (const uci of pv) {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) break;
    let m;
    try {
      m = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    } catch {
      break; // stale / illegal tail
    }
    if (white) tokens.push(`${num}. ${m.san}`);
    else tokens.push(san.length === 0 ? `${num}... ${m.san}` : m.san);
    san.push(m.san);
    if (!white) num++;
    white = !white;
  }
  return { san, text: tokens.join(' '), fen: chess.fen(), count: san.length };
}

/** PV in SAN with move numbers, e.g. `12. Nf3 Nc6 13. O-O`. */
export function pvToSan(fen: string, pv: readonly string[]): string {
  return convertPv(fen, pv).text;
}
