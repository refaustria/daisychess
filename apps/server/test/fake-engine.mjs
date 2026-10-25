#!/usr/bin/env node
// Minimal fake UCI engine for tests (no dependency on Stockfish).
//
// Flags:
//   --info-interval=<ms>  delay between info lines (default 5)
//   --isready-delay=<ms>  delay before readyok (default 0)
//   --no-uciok            never answer `uci` (handshake timeout tests)
//   --hang-on-newgame     after `ucinewgame`, never answer `isready` again (unhealthy instance)
//   --ignore-sigterm      ignore SIGTERM and `quit` (SIGKILL escalation tests)
//   --ignore-stop         ignore `stop` (hung engine tests)
//   --lc0                 imitate Lc0 (ADR-019): no `Hash` option (`error Unknown option`),
//                         `VerboseMoveStats`, `go nodes N` answers at once with one info line,
//                         policy lines when verbose, and `bestmove e2e4`; a FEN with full-move
//                         counter 997 answers `bestmove a1a1` (Lc0's null move on a terminal
//                         position). The command line is echoed as `info string lc0-fake args …`
//                         right after `id author` so tests can check `--weights=`.
//   --weights=<path>      accepted (and echoed) in --lc0 mode
//   --bestmove=<uci>      unrestricted searches report this move (pv and bestmove) instead of e2e4
// Commands beyond UCI:
//   crash                 write to stderr and exit(3)
// Positions: a FEN whose full-move counter is 999 crashes on `go`; 998 ignores `stop`.
// `go … searchmoves m1 …`: the pv and the bestmove start with m1 and the score is 25 cp lower.
import { createInterface } from 'node:readline';

const flags = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const num = (k, d) => (flags.has(k) ? Number(flags.get(k)) : d);
const INFO_INTERVAL = num('info-interval', 5);
const BESTMOVE = flags.get('bestmove') ?? null;
const ISREADY_DELAY = num('isready-delay', 0);

const out = (line) => process.stdout.write(line + '\n');

let multipv = 1;
let fen = 'startpos';
let search = null; // { timer, depth, reason, restrict }
let hung = false;
let ignoreStop = flags.has('ignore-stop');
const LC0 = flags.has('lc0');
let verboseMoveStats = false;

/** Lc0-style VerboseMoveStats lines (ascending by P, root summary last), as lc0 v0.32 prints them. */
const LC0_POLICY = [
  ['g1f3', '4.35'],
  ['c2c4', '4.97'],
  ['e2e3', '3.59'],
  ['d2d4', '23.34'],
  ['e2e4', '50.22'],
];
function emitLc0Verbose() {
  const sorted = [...LC0_POLICY].sort((a, b) => Number(a[1]) - Number(b[1]));
  for (const [move, p] of sorted) {
    out(
      `info string ${move}  (322 ) N:       0 (+ 0) (P: ${p.padStart(5)}%) (WL:  -.-----) (D: -.---) (M:  -.-) (Q:  0.04017) (U: 0.87639) (S:  0.91655) (V:  -.----) `,
    );
  }
  out(
    'info string node  (  20) N:       1 (+ 0) (P: 89.23%) (WL:  0.03473) (D: 0.038) (M:  3.8) (Q:  0.03473) (V:  0.0402) ',
  );
}

/** Lc0 `go nodes N`: the policy move at once (no timers). */
function goLc0Nodes(nodes) {
  if (fullmove() === 997) {
    out('bestmove a1a1'); // terminal position: Lc0 prints no info and a null move
    return;
  }
  for (let k = 1; k <= multipv; k++) {
    const mp = multipv > 1 ? ` multipv ${k}` : '';
    out(
      `info depth 1 seldepth 1 time 2 nodes ${nodes} score cp 99 tbhits 0${mp} pv ${['e2e4', 'd2d4', 'c2c4'][k - 1] ?? 'g1f3'}`,
    );
  }
  if (verboseMoveStats) emitLc0Verbose();
  out('bestmove e2e4');
}

if (flags.has('ignore-sigterm')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 60_000); // stay alive after stdin closes, until SIGKILL
}

function fullmove() {
  const parts = fen.split(' ');
  return parts.length >= 6 ? Number(parts[5]) : 1;
}

function emitInfo(depth) {
  const restrict = search?.restrict ?? null;
  const pv = restrict ?? (BESTMOVE ? BESTMOVE : 'e2e4 e7e5 g1f3');
  const malus = restrict ? 25 : 0;
  for (let k = 1; k <= multipv; k++) {
    out(
      `info depth ${depth} seldepth ${depth + 2} multipv ${k} score cp ${10 * depth - k - malus} nodes ${depth * 1000} nps 1000000 time ${depth} pv ${pv}`,
    );
  }
}

function finish() {
  if (!search) return;
  clearInterval(search.timer);
  if (search.deadline) clearTimeout(search.deadline);
  const restrict = search.restrict;
  search = null;
  const move = restrict ?? BESTMOVE;
  out(move ? `bestmove ${move}` : 'bestmove e2e4 ponder e7e5');
}

function go(args) {
  if (fullmove() === 999) {
    process.stderr.write('fake-engine: simulated crash\n');
    process.exit(3);
  }
  const ignore = fullmove() === 998 || ignoreStop;
  const di = args.indexOf('depth');
  const mi = args.indexOf('movetime');
  const ni = args.indexOf('nodes');
  if (LC0 && ni >= 0) {
    goLc0Nodes(Number(args[ni + 1]));
    return;
  }
  const maxDepth = di >= 0 ? Number(args[di + 1]) : Infinity;
  const movetime = mi >= 0 ? Number(args[mi + 1]) : undefined;
  let depth = 0;
  out('info string fake search started');
  const si = args.indexOf('searchmoves');
  search = {
    ignore,
    timer: null,
    deadline: null,
    restrict: si >= 0 ? (args[si + 1] ?? null) : null,
  };
  search.timer = setInterval(() => {
    depth++;
    out(`info depth ${depth} currmove e2e4 currmovenumber 1`);
    emitInfo(depth);
    if (depth >= maxDepth) finish();
  }, INFO_INTERVAL);
  if (movetime !== undefined) search.deadline = setTimeout(finish, movetime);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (raw) => {
  const line = raw.trim();
  const [cmd, ...args] = line.split(/\s+/);
  switch (cmd) {
    case 'uci':
      if (flags.has('no-uciok')) return;
      if (LC0) {
        out('id name Lc0 v0.32.1 fake');
        out('id author The LCZero Authors.');
        out(`info string lc0-fake args ${process.argv.slice(2).join(' ')}`);
        out('option name Threads type spin default 0 min 0 max 128');
        out('option name MultiPV type spin default 1 min 1 max 500');
        out('option name VerboseMoveStats type check default false');
        out('option name MinibatchSize type spin default 0 min 0 max 1024');
        out('uciok');
        break;
      }
      out('id name FakeEngine 1.0');
      out('id author tests');
      out('option name Threads type spin default 1 min 1 max 1024');
      out('option name Hash type spin default 16 min 1 max 33554432');
      out('option name MultiPV type spin default 1 min 1 max 256');
      out('uciok');
      break;
    case 'isready':
      if (hung) return;
      if (ISREADY_DELAY > 0) setTimeout(() => out('readyok'), ISREADY_DELAY);
      else out('readyok');
      break;
    case 'setoption': {
      // setoption name <Name> value <v>
      const ni = args.indexOf('name');
      const vi = args.indexOf('value');
      const name = args.slice(ni + 1, vi < 0 ? undefined : vi).join(' ');
      const value = vi < 0 ? '' : args.slice(vi + 1).join(' ');
      if (LC0 && name === 'Hash') {
        out('error Unknown option: Hash');
        break;
      }
      if (name === 'MultiPV') multipv = Number(value);
      if (name === 'VerboseMoveStats') verboseMoveStats = value === 'true';
      out(`info string setoption ${name}=${value}`);
      break;
    }
    case 'ucinewgame':
      if (flags.has('hang-on-newgame')) hung = true;
      break;
    case 'position':
      fen = args[0] === 'fen' ? args.slice(1, 7).join(' ') : 'startpos';
      break;
    case 'go':
      go(args);
      break;
    case 'stop':
      if (search && !search.ignore) finish();
      break;
    case 'crash':
      process.stderr.write('fake-engine: crash requested\n');
      process.exit(3);
      break;
    case 'quit':
      if (flags.has('ignore-sigterm')) return;
      process.exit(0);
      break;
    default:
      if (line) out(`info string unknown command: ${line}`);
  }
});
rl.on('close', () => {
  if (!flags.has('ignore-sigterm')) process.exit(0);
});
