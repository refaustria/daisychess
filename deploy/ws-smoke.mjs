#!/usr/bin/env node
// WebSocket smoke test: hello -> analyze(start position, depth 12) -> bestmove.
// Usage: node deploy/ws-smoke.mjs [wss://c.referee.at/ws]   (Node 22+, global WebSocket)
//   CHESSLAB_TOKEN=<token> node ...   for a server that requires an access token
const url = process.argv[2] ?? 'wss://c.referee.at/ws';
// Access token of a server with ACCESS_TOKEN set (ADR-010); never printed.
const token = process.env.CHESSLAB_TOKEN || undefined;
const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const ws = new WebSocket(url);
let lastInfo = null;
const timer = setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 30_000);

ws.onerror = (e) => {
  console.error('ws error', e.message ?? e);
  process.exit(1);
};
ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, client: { name: 'ws-smoke' }, ...(token ? { token } : {}) }));
ws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.type === 'welcome') {
    console.log('welcome', JSON.stringify({ serverVersion: m.serverVersion, engines: m.engines.map((e) => e.id), capabilities: m.capabilities }));
    if (m.capabilities && m.capabilities.analysis === false) {
      // ADR-013: a missing/wrong access token no longer closes the socket; analysis is just unavailable.
      console.error('restricted welcome: analysis unavailable; hint: set CHESSLAB_TOKEN=<access token>');
      process.exit(1);
    }
    ws.send(JSON.stringify({ type: 'analyze', sessionId: 'smoke', searchId: 1, engine: 'stockfish', fen: FEN, depth: 12 }));
  } else if (m.type === 'info') {
    lastInfo = m.info;
  } else if (m.type === 'bestmove') {
    console.log('last info', JSON.stringify(lastInfo));
    console.log('bestmove', JSON.stringify(m.bestMove), m.reason);
    clearTimeout(timer);
    ws.send(JSON.stringify({ type: 'release', sessionId: 'smoke' }));
    ws.close();
    process.exit(m.bestMove ? 0 : 1);
  } else if (m.type === 'error') {
    console.error('server error', JSON.stringify(m));
    if (m.code === 'unauthorized') console.error('hint: set CHESSLAB_TOKEN=<access token>');
    process.exit(1);
  }
};
