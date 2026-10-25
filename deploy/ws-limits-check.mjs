#!/usr/bin/env node
// Per-IP session cap check (docs/SECURITY.md): two connections from this host open three engine
// sessions; the first two must stream `info`, the third must get `no_capacity` ("too many
// sessions from your address"). Everything is released afterwards.
// Usage: node deploy/ws-limits-check.mjs [wss://c.referee.at/ws]   (Node 22+, global WebSocket)
//   DAISYCHESS_TOKEN=<token> node ...   for a server that requires an access token
// Assumes MAX_SESSIONS_PER_IP=2 and no other sessions from this address.
const url = process.argv[2] ?? 'wss://c.referee.at/ws';
// Access token of a server with ACCESS_TOKEN set (ADR-010); never printed.
const token = process.env.DAISYCHESS_TOKEN || undefined;
const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiters = [];
    const messages = [];
    ws.onerror = (e) => reject(new Error(`${name}: ${e.message ?? 'ws error'}`));
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          client: { name: 'ws-limits-check' },
          ...(token ? { token } : {}),
        }),
      );
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      messages.push(m);
      if (m.type === 'welcome') resolve(conn);
      else if (m.type === 'error' && m.code === 'unauthorized')
        reject(new Error(`${name}: unauthorized (set DAISYCHESS_TOKEN)`));
      for (const w of waiters.splice(0)) w();
    };
    const conn = {
      ws,
      send: (m) => ws.send(JSON.stringify(m)),
      async waitFor(pred, ms = 15_000) {
        const deadline = Date.now() + ms;
        for (;;) {
          const hit = messages.find(pred);
          if (hit) return hit;
          if (Date.now() > deadline)
            throw new Error(`${name}: timeout; last ${JSON.stringify(messages.at(-1))}`);
          await new Promise((r) => {
            waiters.push(r);
            setTimeout(r, 200);
          });
        }
      },
    };
  });
}

const analyze = (sessionId) => ({
  type: 'analyze',
  sessionId,
  searchId: 1,
  engine: 'stockfish',
  fen: FEN,
  movetime: 10_000,
  threads: 1,
  hash: 16,
});
const firstOf = (sessionId) => (m) =>
  (m.type === 'info' || m.type === 'bestmove' || m.type === 'error') && m.sessionId === sessionId;

const a = await connect('A');
const b = await connect('B');
let ok = true;
try {
  a.send(analyze('a1'));
  const r1 = await a.waitFor(firstOf('a1'));
  console.log('A/a1 ->', r1.type === 'info' ? 'info (leased)' : JSON.stringify(r1));
  b.send(analyze('b1'));
  const r2 = await b.waitFor(firstOf('b1'));
  console.log('B/b1 ->', r2.type === 'info' ? 'info (leased)' : JSON.stringify(r2));
  a.send(analyze('a2'));
  const r3 = await a.waitFor(firstOf('a2'));
  console.log('A/a2 ->', r3.type === 'info' ? 'info (leased)' : JSON.stringify(r3));
  ok =
    r1.type === 'info' &&
    r2.type === 'info' &&
    r3.type === 'error' &&
    r3.code === 'no_capacity' &&
    /your address/.test(r3.message);
} finally {
  for (const [c, ids] of [
    [a, ['a1', 'a2']],
    [b, ['b1']],
  ]) {
    for (const id of ids) c.send({ type: 'release', sessionId: id });
    c.ws.close();
  }
}
console.log(ok ? 'PASS: third session from one address refused' : 'FAIL');
process.exit(ok ? 0 : 1);
