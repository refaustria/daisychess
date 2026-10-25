import { DEFAULT_LIMITS, type AnalyzeMessage, type EngineInfo } from '@chesslab/engine-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteEngineClient } from '../engine/RemoteEngineClient';
import { FakeWebSocket, TEST_WELCOME } from '../engine/remoteTesting';
import { BatchAnalyzer } from './BatchAnalyzer';
import { REVIEW_SERVER_HASH_MB, ServerReviewEngine, remoteError } from './serverReviewEngine';

const LIMITS = { ...DEFAULT_LIMITS, maxThreads: 8, maxHash: 128, maxDepth: 16, maxMovetimeMs: 200 };
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Fake server: answers every `analyze` with one info (cp 30 from the mover's view) + bestmove. */
class AnsweringSocket extends FakeWebSocket {
  answer = true;
  override send(data: string): void {
    super.send(data);
    const msg = this.sent.at(-1)!;
    if (msg.type !== 'analyze' || !this.answer) return;
    const a: AnalyzeMessage = msg;
    queueMicrotask(() => {
      this.emit({
        type: 'info',
        sessionId: a.sessionId,
        searchId: a.searchId,
        info: { depth: 12, multipv: 1, score: { cp: 30 }, pv: ['e2e4', 'e7e5'] },
      });
      this.emit({
        type: 'bestmove',
        sessionId: a.sessionId,
        searchId: a.searchId,
        bestMove: { move: 'e2e4' },
        reason: 'completed',
      });
    });
  }
}

function setup(): { engine: ServerReviewEngine; sockets: AnsweringSocket[] } {
  const sockets: AnsweringSocket[] = [];
  const client = new RemoteEngineClient({
    url: 'ws://test/ws',
    createSocket: (url) => {
      const s = new AnsweringSocket(url);
      s.welcome = { ...TEST_WELCOME, limits: LIMITS };
      sockets.push(s);
      return s;
    },
  });
  return { engine: new ServerReviewEngine(client), sockets };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ServerReviewEngine', () => {
  it('asks for the server maximum threads and a capped hash on every analyze', async () => {
    const { engine, sockets } = setup();
    await engine.load();
    expect(engine.threads).toBe(8);
    expect(engine.engineName).toBe('Stockfish 19');
    const infos: EngineInfo[] = [];
    for await (const i of engine.analyze(START, { depth: 18, multipv: 1 })) infos.push(i);
    const sent = sockets[0]!.ofType('analyze')[0]!;
    expect(sent).toMatchObject({ threads: 8, hash: Math.min(REVIEW_SERVER_HASH_MB, 128) });
    expect(sent.depth).toBe(16); // clamped to maxDepth
    expect(infos).toHaveLength(1);
    await engine.dispose();
    expect(sockets[0]!.ofType('release')).toHaveLength(1); // session released on dispose
  });

  it('clamps movetime to maxMovetimeMs instead of failing with limit_exceeded', async () => {
    const { engine, sockets } = setup();
    await engine.load();
    expect(engine.clampOptions({ movetime: 300, multipv: 1 })).toEqual({
      movetime: 200,
      multipv: 1,
    });
    for await (const _ of engine.analyze(START, { movetime: 300, multipv: 1 })) void _;
    expect(sockets[0]!.ofType('analyze')[0]!.movetime).toBe(200);
    await engine.dispose();
  });

  it('works with BatchAnalyzer unchanged (White-POV scores, best move)', async () => {
    const { engine } = setup();
    await engine.load();
    const analyzer = new BatchAnalyzer({ engine, options: { movetime: 300 } });
    const after = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const summary = await analyzer.run({
      startFen: START,
      moves: [{ uci: 'e2e4', san: 'e4', fenAfter: after }],
    }).promise;
    expect(summary.moves).toHaveLength(1);
    // Black to move after e4: +30 for the mover is −30 from White's view.
    expect(analyzer.cache.get(after)?.eval).toEqual({ cp: -30 });
    expect(analyzer.cache.get(START)?.bestMove).toBe('e2e4');
    await engine.dispose();
  });

  it('a search that stalls rejects with a timeout RemoteEngineError', async () => {
    const sockets: AnsweringSocket[] = [];
    const client = new RemoteEngineClient({
      url: 'ws://test/ws',
      createSocket: (url) => {
        const s = new AnsweringSocket(url);
        s.answer = false;
        sockets.push(s);
        return s;
      },
    });
    const engine = new ServerReviewEngine(client, { stallTimeoutMs: 20 });
    await engine.load();
    const it = engine.analyze(START, { depth: 10 })[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ name: 'RemoteEngineError', code: 'timeout' });
    await it.return?.();
    expect(sockets[0]!.ofType('stop')).toHaveLength(1); // the stalled search is stopped
    await engine.dispose();
  });

  it('load rejects on a restricted welcome (no or wrong token)', async () => {
    const client = new RemoteEngineClient({
      url: 'ws://test/ws',
      createSocket: (url) => {
        const s = new FakeWebSocket(url);
        s.welcome = { ...TEST_WELCOME, capabilities: { analysis: false, rooms: true } };
        return s;
      },
    });
    const engine = new ServerReviewEngine(client);
    await expect(engine.load()).rejects.toMatchObject({ code: 'unauthorized' });
    await engine.dispose();
  });

  it('remoteError carries name and code', () => {
    expect(remoteError('x', 'closed')).toMatchObject({
      message: 'x',
      name: 'RemoteEngineError',
      code: 'closed',
    });
  });
});
