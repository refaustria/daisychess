import type { EngineDescriptor, PolicyEntry, WelcomeMessage } from '@daisychess/engine-core';
import { FakeWebSocket, TEST_WELCOME } from '../engine/remoteTesting';
import { RemoteEngineClient } from '../engine/RemoteEngineClient';
import { MaiaOpponent, type MaiaOpponentOptions } from './opponent';

/** Test helpers: a fake engine server with Maia engines (ADR-019) for the opponent tests. */

export const maiaDescriptor = (rating: number, enabled = true): EngineDescriptor => ({
  id: `maia-${rating}`,
  name: `Maia ${rating}`,
  enabled,
  defaults: { threads: 1, hash: 16 },
  style: 'human',
  rating,
  maxNodes: 1,
});

export const MAIA_WELCOME: WelcomeMessage = {
  ...TEST_WELCOME,
  engines: [
    ...TEST_WELCOME.engines,
    maiaDescriptor(1100),
    maiaDescriptor(1500),
    maiaDescriptor(1900),
  ],
};

/** What the fake server does with one `analyze` (in order; the last one repeats). */
export type MaiaReply =
  | { kind: 'move'; best: string | null; policy?: PolicyEntry[] }
  /** `error no_capacity` for the search (all Maia processes busy). */
  | { kind: 'busy' }
  /** The connection drops (server restart, network). */
  | { kind: 'close' }
  /** No answer (the test answers or stops). */
  | { kind: 'hang' };

/**
 * Fake engine server: every `createSocket` gives a {@link FakeWebSocket} that answers `hello`
 * with `welcome` and each `analyze` with the next {@link MaiaReply}.
 */
export class FakeMaiaServer {
  readonly sockets: FakeWebSocket[] = [];
  replies: MaiaReply[] = [];
  welcome: WelcomeMessage = MAIA_WELCOME;
  /** Analyze messages received (all sockets). */
  readonly analyzes: {
    engine: string;
    fen: string;
    nodes?: number;
    depth?: number;
    movetime?: number;
  }[] = [];
  private replyIndex = 0;

  createSocket = (url: string): FakeWebSocket => {
    const ws = new FakeWebSocket(url);
    ws.welcome = this.welcome;
    const send = ws.send.bind(ws);
    ws.send = (data: string) => {
      send(data);
      const msg = ws.sent[ws.sent.length - 1]!;
      if (msg.type !== 'analyze') return;
      this.analyzes.push({
        engine: msg.engine,
        fen: msg.fen,
        ...(msg.nodes !== undefined ? { nodes: msg.nodes } : {}),
        ...(msg.depth !== undefined ? { depth: msg.depth } : {}),
        ...(msg.movetime !== undefined ? { movetime: msg.movetime } : {}),
      });
      const reply =
        this.replies[Math.min(this.replyIndex, this.replies.length - 1)] ??
        ({ kind: 'move', best: null } as const);
      this.replyIndex++;
      const { sessionId, searchId } = msg;
      queueMicrotask(() => {
        if (ws.readyState !== 1) return;
        if (reply.kind === 'busy') {
          ws.emit({
            type: 'error',
            code: 'no_capacity',
            message: 'all 3 process(es) of engine group "maia" are busy',
            sessionId,
            searchId,
          });
        } else if (reply.kind === 'close') {
          ws.serverClose(1006, 'gone');
        } else if (reply.kind === 'move') {
          // A terminal position (null bestmove) relays no info (Lc0 prints none, ADR-019).
          if (reply.best)
            ws.emit({
              type: 'info',
              sessionId,
              searchId,
              info: {
                depth: 1,
                multipv: 1,
                score: { cp: 20 },
                pv: [reply.best],
                ...(reply.policy ? { policy: reply.policy } : {}),
              },
            });
          ws.emit({
            type: 'bestmove',
            sessionId,
            searchId,
            bestMove: reply.best ? { move: reply.best } : null,
            reason: 'completed',
          });
        }
      });
    };
    this.sockets.push(ws);
    return ws;
  };

  /** A real {@link RemoteEngineClient} on this fake server. */
  client(engineId = 'maia-1500', token?: string): RemoteEngineClient {
    return new RemoteEngineClient({
      url: 'ws://fake/ws',
      engineId,
      createSocket: this.createSocket,
      ...(token ? { token } : {}),
    });
  }

  /** A {@link MaiaOpponent} on this fake server (no waits unless given). */
  opponent(over: Partial<MaiaOpponentOptions> = {}): MaiaOpponent {
    return new MaiaOpponent({
      engineId: 'maia-1500',
      createClient: () => this.client(over.engineId ?? 'maia-1500'),
      wait: () => Promise.resolve(),
      thinkDelay: () => 0,
      ...over,
    });
  }
}
