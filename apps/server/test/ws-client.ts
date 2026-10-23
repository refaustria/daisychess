import WebSocket, { type ClientOptions } from 'ws';
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ServerMessage,
  type WelcomeMessage,
} from '@chesslab/engine-core';

/** Test client: records every server message and asserts each one conforms to the protocol. */
export class TestClient {
  readonly messages: ServerMessage[] = [];
  readonly invalid: string[] = [];
  closeCode: number | null = null;
  private waiters: (() => void)[] = [];
  private readonly closed: Promise<number>;

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const text = (data as Buffer).toString('utf8');
      const parsed = parseServerMessage(text);
      if (parsed.ok) this.messages.push(parsed.message);
      else this.invalid.push(`${parsed.error}: ${text}`);
      this.notify();
    });
    this.closed = new Promise((resolve) =>
      ws.on('close', (code) => {
        this.closeCode = code;
        this.notify();
        resolve(code);
      }),
    );
  }

  static async connect(url: string, opts?: ClientOptions): Promise<TestClient> {
    const ws = new WebSocket(url, opts);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    return new TestClient(ws);
  }

  static async connectAndHello(
    url: string,
    opts?: ClientOptions,
  ): Promise<{ client: TestClient; welcome: WelcomeMessage }> {
    const client = await TestClient.connect(url, opts);
    client.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, client: { name: 'test' } });
    const welcome = await client.waitFor((m): m is WelcomeMessage => m.type === 'welcome');
    return { client, welcome };
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  /** Resolves with the first message (seen so far or arriving later) matching `pred`. */
  async waitFor<T extends ServerMessage>(
    pred: ((m: ServerMessage) => m is T) | ((m: ServerMessage) => boolean),
    timeoutMs = 5_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(pred as (m: ServerMessage) => boolean);
      if (found) return found as T;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for message; got: ${JSON.stringify(this.messages.slice(-5))}`,
        );
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  /** Terminal message (bestmove or error with searchId) of a search. */
  terminal(sessionId: string, searchId: number, timeoutMs?: number): Promise<ServerMessage> {
    return this.waitFor(
      (m) =>
        (m.type === 'bestmove' || m.type === 'error') &&
        m.sessionId === sessionId &&
        m.searchId === searchId,
      timeoutMs,
    );
  }

  waitClosed(): Promise<number> {
    return this.closed;
  }

  close(): Promise<number> {
    this.ws.close();
    return this.closed;
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}
