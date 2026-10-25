import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import {
  parseNodeToHubMessage,
  type HubToNodeMessage,
  type NodeToHubMessage,
  type NodeWelcomeMessage,
} from '@daisychess/engine-core';

type Frame<T extends NodeToHubMessage['type']> = Extract<NodeToHubMessage, { type: T }>;

/** One node link as the fake hub sees it: every frame is validated with `parseNodeToHubMessage`. */
export class FakeHubLink {
  readonly frames: NodeToHubMessage[] = [];
  readonly invalid: string[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const parsed = parseNodeToHubMessage(data.toString());
      if (parsed.ok) this.frames.push(parsed.message);
      else this.invalid.push(parsed.error);
      this.wake();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.wake();
    });
  }

  send(msg: HubToNodeMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  welcome(over: Partial<NodeWelcomeMessage> = {}): void {
    this.send({
      type: 'node.welcome',
      linkVersion: 1,
      hubVersion: '0.1.0',
      nodeId: 'abcdefgh',
      name: 'fast-box',
      pool: false,
      heartbeatMs: 10_000,
      drainMs: 30_000,
      minNodeVersion: '0.0.0',
      latestNodeVersion: '0.0.0',
      ...over,
    });
  }

  of<T extends NodeToHubMessage['type']>(type: T): Frame<T>[] {
    return this.frames.filter((f): f is Frame<T> => f.type === type);
  }

  /** Frames relayed for `cid` (`client.msg` payloads), in order. */
  relayed(cid: string) {
    return this.of('client.msg')
      .filter((f) => f.cid === cid)
      .map((f) => f.msg);
  }

  /** Resolves with the first frame (from index 0) matching `pred`. */
  async waitFor<T extends NodeToHubMessage['type']>(
    type: T,
    pred: (f: Frame<T>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Frame<T>> {
    return this.until(() => this.of(type).find(pred), timeoutMs, `frame ${type}`);
  }

  async waitClosed(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    return this.until(() => this.closed ?? undefined, timeoutMs, 'link close');
  }

  private until<T>(get: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`fake hub: no ${what} within ${timeoutMs} ms`));
      }, timeoutMs);
      const check = () => {
        const v = get();
        if (v === undefined) return false;
        cleanup();
        resolve(v);
        return true;
      };
      const waiter = () => {
        if (!check()) this.waiters.push(waiter);
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
      };
      waiter();
    });
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }
}

/** A WebSocket server on a random loopback port standing in for the hub's `/link`. */
export class FakeHub {
  readonly links: FakeHubLink[] = [];
  private waiters: (() => void)[] = [];

  private constructor(readonly wss: WebSocketServer) {
    wss.on('connection', (ws) => {
      this.links.push(new FakeHubLink(ws));
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static async start(opts: { autoPong?: boolean } = {}): Promise<FakeHub> {
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      path: '/link',
      ...(opts.autoPong === false ? { autoPong: false } : {}),
    });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    return new FakeHub(wss);
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}/link`;
  }

  /** Resolves with link number `n` (0-based) once the node connected that often. */
  link(n: number, timeoutMs = 5_000): Promise<FakeHubLink> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake hub: no link #${n}`)), timeoutMs);
      const check = () => {
        const l = this.links[n];
        if (l) {
          clearTimeout(timer);
          resolve(l);
        } else this.waiters.push(check);
      };
      check();
    });
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}
