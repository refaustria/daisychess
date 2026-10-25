// Minimal stand-in for the hub's /link endpoint, used by scripts/node-image-smoke.sh (M24-8) until
// the real `ROLE=hub` LinkServer (M24-5) can be started from the image. It speaks just enough of
// the node ↔ hub link protocol (packages/engine-core/src/link.ts, LINK_PROTOCOL_VERSION 1) to
// check a node container end to end: register, relay one Stockfish search and (optionally) one
// Maia move, see a node.status heartbeat, then close the link cleanly.
//
// Runs inside the node image (plain Node.js, no build step): `ws` is resolved from the image's
// server package. Usage: node node-smoke-hub.mjs   (env below). Exit 0 = every check passed;
// the last stdout line is a JSON summary.
//   SMOKE_PORT          listen port (default 9000), path /link
//   SMOKE_NODE_TOKEN    the token the node must present (required)
//   SMOKE_EXPECT_MAIA   1 = require the maia-* engines enabled and run one Maia move; 0 = require them disabled
//   SMOKE_TIMEOUT_MS    overall deadline (default 90000)
import { createRequire } from 'node:module';

const require = createRequire(process.env.SMOKE_WS_FROM ?? '/app/server/package.json');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.SMOKE_PORT ?? 9000);
const TOKEN = process.env.SMOKE_NODE_TOKEN ?? '';
const EXPECT_MAIA = process.env.SMOKE_EXPECT_MAIA ?? '1';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 90_000);
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const log = (msg, extra = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), hub: 'smoke', msg, ...extra }));

if (!TOKEN) {
  log('SMOKE_NODE_TOKEN is required');
  process.exit(2);
}

const summary = { registered: false, engines: [], searches: [], status: 0, closeCode: null };
const fail = (reason) => {
  log('FAIL', { reason, summary });
  process.exit(1);
};
setTimeout(() => fail(`deadline of ${TIMEOUT_MS} ms passed`), TIMEOUT_MS).unref();

const wss = new WebSocketServer({ port: PORT, path: '/link', maxPayload: 20 * 1024 });
wss.on('listening', () => log('listening', { port: PORT }));
let busy = false;

wss.on('connection', (ws, req) => {
  log('link connected', { from: req.socket.remoteAddress, origin: req.headers.origin ?? null });
  if (busy) {
    ws.close(1013, 'one link at a time');
    return;
  }
  busy = true;
  const waiters = [];
  const frames = [];
  const send = (msg) => ws.send(JSON.stringify(msg));
  const next = (pred, what, ms = 60_000) =>
    new Promise((resolve, reject) => {
      const hit = frames.find(pred);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms);
      waiters.push({ pred, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });

  ws.on('message', (data) => {
    let f;
    try {
      f = JSON.parse(String(data));
    } catch {
      return fail('node sent a frame that is not JSON');
    }
    if (f.type === 'node.status') summary.status += 1;
    if (f.type === 'client.msg' && f.msg?.type === 'error') log('node error', { msg: f.msg });
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) waiters.splice(i, 1)[0].resolve(f);
    }
  });
  ws.on('close', (code) => {
    summary.closeCode = code;
  });

  (async () => {
    const hello = await next((f) => f.type === 'node.hello', 'node.hello', 30_000);
    if (hello.linkVersion !== 1) fail(`linkVersion ${hello.linkVersion}`);
    if (hello.nodeToken !== TOKEN) {
      send({ type: 'node.error', code: 'bad_token', message: 'smoke hub: unexpected token' });
      ws.close(4001, 'bad_token');
      return fail('node presented an unexpected token');
    }
    summary.engines = hello.engines.map((e) => ({ id: e.id, enabled: e.enabled }));
    log('node.hello', {
      node: hello.node,
      maxSessions: hello.maxSessions,
      pool: hello.pool,
      limits: hello.limits,
      engines: summary.engines,
    });
    const sf = hello.engines.find((e) => e.id === 'stockfish');
    if (!sf?.enabled) fail('stockfish is not enabled on the node');
    const maia = hello.engines.filter((e) => e.id.startsWith('maia-'));
    const maiaOn = maia.length > 0 && maia.every((e) => e.enabled);
    if (EXPECT_MAIA === '1' && !maiaOn) fail('maia engines expected enabled');
    if (EXPECT_MAIA === '0' && maia.some((e) => e.enabled)) fail('maia engines expected disabled');

    send({
      type: 'node.welcome',
      linkVersion: 1,
      hubVersion: '0.0.0',
      nodeId: 'smoketst',
      name: 'smoke-node',
      pool: false,
      heartbeatMs: 2_000,
      drainMs: 5_000,
      minNodeVersion: '0.0.0',
      latestNodeVersion: '0.0.0',
    });
    summary.registered = true;
    send({ type: 'client.open', cid: 'c1', limits: hello.limits, shared: false, tier: 'full' });

    const search = async (searchId, sessionId, engine, extra) => {
      const started = Date.now();
      send({
        type: 'client.msg',
        cid: 'c1',
        msg: { type: 'analyze', sessionId, searchId, engine, fen: START_FEN, ...extra },
      });
      const end = await next(
        (f) =>
          f.type === 'client.msg' &&
          f.cid === 'c1' &&
          f.msg.sessionId === sessionId &&
          (f.msg.type === 'bestmove' || f.msg.type === 'error'),
        `terminal for ${engine}`,
      );
      if (end.msg.type !== 'bestmove' || !end.msg.bestMove) fail(`${engine}: ${end.msg.code} ${end.msg.message ?? ''}`);
      const infos = frames.filter(
        (f) => f.type === 'client.msg' && f.msg.type === 'info' && f.msg.sessionId === sessionId,
      ).length;
      const r = { engine, bestMove: end.msg.bestMove, reason: end.msg.reason, infos, ms: Date.now() - started };
      summary.searches.push(r);
      log('search done', r);
      send({ type: 'client.msg', cid: 'c1', msg: { type: 'release', sessionId } });
    };

    await search(1, 'sf', 'stockfish', { depth: 12 });
    if (maiaOn && EXPECT_MAIA !== '0') await search(1, 'maia', 'maia-1500', { nodes: 1 });
    await next((f) => f.type === 'node.status', 'node.status', 10_000);

    send({ type: 'client.close', cid: 'c1' });
    await next((f) => f.type === 'client.closed' && f.cid === 'c1', 'client.closed', 10_000);
    log('PASS', { summary });
    console.log(JSON.stringify(summary));
    process.exit(0);
  })().catch((err) => fail(err.message));
});
