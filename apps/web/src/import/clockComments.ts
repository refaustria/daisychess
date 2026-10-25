/**
 * Clock data in PGN comments (M22-1): `[%clk h:mm:ss(.f)]` (remaining time after the move, as
 * written by lichess with `clocks=true` and by chess.com) and `[%emt h:mm:ss(.f)]` (elapsed move
 * time, e.g. ChessBase/TWIC). Pure functions; the game store calls {@link parsePgnClocks} from
 * `loadPgn`.
 *
 * Comments are read with our own small tokenizer over the movetext instead of chess.js'
 * `getComments()`: chess.js keys comments by FEN, so the n-th mainline move cannot be mapped back
 * reliably, and its parser keeps only one comment per position.
 */

/** Live time control from the `TimeControl` header. */
export interface TimeControl {
  initialMs: number;
  incrementMs: number;
}

/** Clock data of one move (ply). */
export interface MoveClock {
  /** Time on the mover's clock after the move (including any increment). */
  remainingMs?: number;
  /** Time the mover spent on the move. */
  spentMs?: number;
}

/** Raw values found in the comments of one move. */
export interface RawClock {
  clkMs?: number;
  emtMs?: number;
}

/**
 * Parses a `TimeControl` header: `"180+2"` → 3 min + 2 s, `"600"` → 10 min. `"-"`, `"?"`,
 * correspondence/daily (`"1/86400"`), multi-stage classical (`"40/7200:3600"`) and anything else
 * → `undefined` (no live clock we could derive move times from).
 */
export function parseTimeControl(tc: string | undefined): TimeControl | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?\s*$/.exec(tc ?? '');
  if (!m) return undefined;
  const initialMs = Math.round(Number(m[1]) * 1000);
  const incrementMs = Math.round(Number(m[2] ?? 0) * 1000);
  if (initialMs <= 0 && incrementMs <= 0) return undefined;
  return { initialMs, incrementMs };
}

/** Daily/correspondence games (`"1/86400"` on chess.com): their `%clk` values are not a live clock. */
export function isCorrespondence(tc: string | undefined): boolean {
  return /^\s*1\/\d+\s*$/.test(tc ?? '');
}

/** `h:mm:ss(.f)`, `m:ss(.f)` or `ss(.f)` → ms, or `undefined` if malformed. */
export function parseClockValue(text: string): number | undefined {
  const m = /^(?:(?:(\d+):)?(\d{1,2}):)?(\d{1,2}(?:\.\d+)?)$/.exec(text.trim());
  if (!m) return undefined;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2] ?? 0);
  const s = Number(m[3]);
  if (min >= 60 && m[1] !== undefined) return undefined;
  if (s >= 60 && m[2] !== undefined) return undefined;
  return Math.round((h * 3600 + min * 60 + s) * 1000);
}

/** `%clk` / `%emt` values from a comment's text (other text and commands around them are ignored). */
export function parseClockComment(comment: string): RawClock {
  const out: RawClock = {};
  const re = /\[%(clk|emt)\s+([0-9:.]+)\s*\]/g;
  for (let m = re.exec(comment); m; m = re.exec(comment)) {
    const ms = parseClockValue(m[2]!);
    if (ms === undefined) continue;
    if (m[1] === 'clk') out.clkMs ??= ms;
    else out.emtMs ??= ms;
  }
  return out;
}

/**
 * The comments after each mainline move of a PGN's first game, in move order: `result[i]` holds
 * the texts of `{…}` and `;…` comments between move i+1 and the next move. Variations, NAGs, move
 * numbers and the result are skipped; comments inside variations are ignored.
 */
export function mainlineComments(pgn: string): string[][] {
  const out: string[][] = [];
  let i = 0;
  const n = pgn.length;
  let depth = 0;
  let lineStart = true;
  while (i < n) {
    const c = pgn[i]!;
    if (c === '\n') {
      lineStart = true;
      i++;
      continue;
    }
    // Header lines and `%` escape lines, only at the start of a line.
    if (lineStart && (c === '[' || c === '%') && depth === 0) {
      if (c === '[' && out.length > 0) break; // the next game's headers
      const end = pgn.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    lineStart = false;
    if (c === '{') {
      const end = pgn.indexOf('}', i + 1);
      const text = pgn.slice(i + 1, end < 0 ? n : end);
      if (depth === 0 && out.length > 0) out[out.length - 1]!.push(text);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (c === ';') {
      const end = pgn.indexOf('\n', i);
      const text = pgn.slice(i + 1, end < 0 ? n : end);
      if (depth === 0 && out.length > 0) out[out.length - 1]!.push(text);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    // A plain token up to the next delimiter.
    let j = i;
    while (j < n && !/[\s{}();[\]]/.test(pgn[j]!)) j++;
    if (j === i) {
      i++; // stray delimiter (`]`)
      continue;
    }
    const tok = pgn.slice(i, j);
    i = j;
    if (depth > 0) continue;
    if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(tok)) break;
    if (/^\$\d+$/.test(tok)) continue;
    // Move number, possibly glued to the move (`12.e4`, `12...Nf6`).
    const san = tok.replace(/^\d+\.+/, '');
    if (san === '' || /^[!?]+$/.test(san)) continue;
    out.push([]);
  }
  return out;
}

const mover = (startWhite: boolean, index: number): 'w' | 'b' =>
  (index % 2 === 0) === startWhite ? 'w' : 'b';

/**
 * Per-ply clock data from the raw comment values. The missing value is derived where the time
 * control is known: `spent = before − after + increment` (before = the side's previous remaining
 * time, the initial time for its first move), `after = before − spent + increment` for `%emt` only.
 * A first move that leaves the clock at the initial time (lichess starts the clocks after each
 * side's first move) spent 0. Plies without comments stay `undefined`; the chain resumes at the
 * side's next `%clk`.
 */
export function deriveClocks(
  raw: readonly (RawClock | undefined)[],
  tc: TimeControl | undefined,
  startTurn: 'w' | 'b' = 'w',
): (MoveClock | undefined)[] {
  const before: Record<'w' | 'b', number | undefined> = {
    w: tc?.initialMs,
    b: tc?.initialMs,
  };
  const first: Record<'w' | 'b', boolean> = { w: true, b: true };
  return raw.map((r, idx) => {
    const side = mover(startTurn === 'w', idx);
    const prev = before[side];
    const isFirst = first[side];
    first[side] = false;
    let remainingMs = r?.clkMs;
    let spentMs = r?.emtMs;
    if (tc && prev !== undefined) {
      if (spentMs === undefined && remainingMs !== undefined) {
        spentMs =
          isFirst && remainingMs >= tc.initialMs
            ? 0
            : Math.max(0, prev - remainingMs + tc.incrementMs);
      } else if (remainingMs === undefined && spentMs !== undefined) {
        remainingMs = Math.max(0, prev - spentMs + tc.incrementMs);
      }
    }
    before[side] = remainingMs;
    if (remainingMs === undefined && spentMs === undefined) return undefined;
    const clock: MoveClock = {};
    if (remainingMs !== undefined) clock.remainingMs = remainingMs;
    if (spentMs !== undefined) clock.spentMs = spentMs;
    return clock;
  });
}

export interface PgnClocks {
  timeControl?: TimeControl;
  /** One entry per mainline move (`plies` long); `undefined` where nothing is known. */
  clocks: (MoveClock | undefined)[];
}

/**
 * Clock data of a PGN whose mainline has `plies` moves. Returns no clocks for daily games, or
 * when the comment walk does not find exactly `plies` moves (unusual movetext; better nothing
 * than misaligned times).
 */
export function parsePgnClocks(
  pgn: string,
  headers: Readonly<Record<string, string>>,
  plies: number,
  startTurn: 'w' | 'b' = 'w',
): PgnClocks {
  const tcHeader = headers.TimeControl;
  if (isCorrespondence(tcHeader)) return { clocks: [] };
  const timeControl = parseTimeControl(tcHeader);
  const base: PgnClocks = timeControl ? { timeControl, clocks: [] } : { clocks: [] };
  const comments = mainlineComments(pgn);
  if (comments.length !== plies) return base;
  const raw = comments.map((texts) => {
    const r = parseClockComment(texts.join(' '));
    return r.clkMs === undefined && r.emtMs === undefined ? undefined : r;
  });
  if (raw.every((r) => r === undefined)) return base;
  return { ...base, clocks: deriveClocks(raw, timeControl, startTurn) };
}

/** `[%clk]` value: `h:mm:ss`, with tenths when the time has them (`0:02:58.3`). */
export function formatClkComment(ms: number): string {
  const t = Math.max(0, Math.round(ms / 100)); // tenths
  const tenths = t % 10;
  const secs = Math.floor(t / 10);
  const h = Math.floor(secs / 3600);
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${h}:${m}:${s}${tenths ? `.${tenths}` : ''}`;
}
