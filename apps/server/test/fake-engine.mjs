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
// Commands beyond UCI:
//   crash                 write to stderr and exit(3)
// Positions: a FEN whose full-move counter is 999 crashes on `go`; 998 ignores `stop`.
import { createInterface } from 'node:readline';

const flags = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const num = (k, d) => (flags.has(k) ? Number(flags.get(k)) : d);
const INFO_INTERVAL = num('info-interval', 5);
const ISREADY_DELAY = num('isready-delay', 0);

const out = (line) => process.stdout.write(line + '\n');

let multipv = 1;
let fen = 'startpos';
let search = null; // { timer, depth, reason }
let hung = false;
let ignoreStop = flags.has('ignore-stop');

if (flags.has('ignore-sigterm')) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 60_000); // stay alive after stdin closes, until SIGKILL
}

function fullmove() {
  const parts = fen.split(' ');
  return parts.length >= 6 ? Number(parts[5]) : 1;
}

function emitInfo(depth) {
  for (let k = 1; k <= multipv; k++) {
    out(
      `info depth ${depth} seldepth ${depth + 2} multipv ${k} score cp ${10 * depth - k} nodes ${depth * 1000} nps 1000000 time ${depth} pv e2e4 e7e5 g1f3`,
    );
  }
}

function finish() {
  if (!search) return;
  clearInterval(search.timer);
  if (search.deadline) clearTimeout(search.deadline);
  search = null;
  out('bestmove e2e4 ponder e7e5');
}

function go(args) {
  if (fullmove() === 999) {
    process.stderr.write('fake-engine: simulated crash\n');
    process.exit(3);
  }
  const ignore = fullmove() === 998 || ignoreStop;
  const di = args.indexOf('depth');
  const mi = args.indexOf('movetime');
  const maxDepth = di >= 0 ? Number(args[di + 1]) : Infinity;
  const movetime = mi >= 0 ? Number(args[mi + 1]) : undefined;
  let depth = 0;
  out('info string fake search started');
  search = { ignore, timer: null, deadline: null };
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
      if (name === 'MultiPV') multipv = Number(value);
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
