import { describe, expect, it, vi } from 'vitest';
import type { BestMove } from '@daisychess/engine-core';
import { checkServer, runSmoke, SMOKE_MARKER, type SmokeEngine, type SmokeSocket } from './smoke';

function fakeEngine(best: BestMove | null, opts: { loadError?: Error; hang?: boolean } = {}) {
  const dispose = vi.fn(async () => undefined);
  const engine: SmokeEngine = {
    load: () =>
      opts.loadError
        ? Promise.reject(opts.loadError)
        : opts.hang
          ? new Promise<void>(() => undefined)
          : Promise.resolve(),
    analyze: () => ({
      async *[Symbol.asyncIterator]() {
        yield { depth: 1 };
      },
      bestMove: Promise.resolve(best),
    }),
    dispose,
  };
  return { engine, dispose };
}

function parse(line: string) {
  expect(line.startsWith(`${SMOKE_MARKER} `)).toBe(true);
  return JSON.parse(line.slice(SMOKE_MARKER.length + 1)) as Record<string, unknown>;
}

describe('runSmoke', () => {
  it('logs one marker line with the context flags and the bestmove, then disposes', async () => {
    const { engine, dispose } = fakeEngine({ move: 'e2e4' });
    const lines: string[] = [];
    const r = await runSmoke({ createEngine: async () => engine, log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    const logged = parse(lines[0] ?? '');
    expect(logged).toMatchObject({
      engine: 'wasm:lite-single',
      bestmove: 'e2e4',
      platform: 'web',
      crossOriginIsolated: false,
    });
    expect(logged.error).toBeUndefined();
    expect(typeof logged.isSecureContext).toBe('boolean');
    expect(r.bestmove).toBe('e2e4');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports a load failure instead of throwing', async () => {
    const { engine, dispose } = fakeEngine(null, { loadError: new Error('wasm blocked') });
    const lines: string[] = [];
    const r = await runSmoke({ createEngine: async () => engine, log: (l) => lines.push(l) });
    expect(r.bestmove).toBeNull();
    expect(parse(lines[0] ?? '').error).toBe('wasm blocked');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports a missing bestmove', async () => {
    const { engine } = fakeEngine(null);
    const r = await runSmoke({ createEngine: async () => engine, log: () => undefined });
    expect(r.error).toBe('engine returned no bestmove');
  });

  it('times out a hanging engine and still logs', async () => {
    const { engine, dispose } = fakeEngine(null, { hang: true });
    const lines: string[] = [];
    const r = await runSmoke({
      createEngine: async () => engine,
      log: (l) => lines.push(l),
      timeoutMs: 20,
    });
    expect(r.error).toMatch(/timed out/);
    expect(lines).toHaveLength(1);
    expect(dispose).toHaveBeenCalledOnce();
  });
});

/** A scripted socket: `script` runs after the handlers are attached. */
function fakeSocket(script: (s: SmokeSocket & { sent: string[] }) => void) {
  const s: SmokeSocket & { sent: string[]; closed: boolean } = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    sent: [],
    closed: false,
    send(d) {
      s.sent.push(d);
    },
    close() {
      s.closed = true;
    },
  };
  queueMicrotask(() => script(s));
  return s;
}

describe('checkServer (M26-2)', () => {
  it('says hello and reports welcome with the server version', async () => {
    let sock: ReturnType<typeof fakeSocket> | undefined;
    const r = await checkServer('ws://127.0.0.1:1/ws', () => {
      sock = fakeSocket((s) => {
        s.onopen?.();
        s.onmessage?.({ data: 'not json' });
        s.onmessage?.({ data: JSON.stringify({ type: 'welcome', serverVersion: '1.2.3' }) });
      });
      return sock;
    });
    expect(r).toEqual({ url: 'ws://127.0.0.1:1/ws', welcome: true, serverVersion: '1.2.3' });
    expect(JSON.parse(sock!.sent[0]!)).toMatchObject({ type: 'hello', protocolVersion: 1 });
    expect(sock!.closed).toBe(true);
  });

  it('reports a refused upgrade (origin not allowed) as an error', async () => {
    const r = await checkServer('ws://127.0.0.1:1/ws', () =>
      fakeSocket((s) => {
        s.onerror?.();
        s.onclose?.({ code: 1006 });
      }),
    );
    expect(r.welcome).toBe(false);
    expect(r.error).toMatch(/origin refused/);
  });

  it('times out without welcome and survives a throwing constructor', async () => {
    const r = await checkServer('ws://127.0.0.1:1/ws', () => fakeSocket(() => undefined), 20);
    expect(r).toMatchObject({ welcome: false, error: 'no welcome within 20 ms' });
    const t = await checkServer('ws://127.0.0.1:1/ws', () => {
      throw new Error('blocked by CSP');
    });
    expect(t).toMatchObject({ welcome: false, error: 'blocked by CSP' });
  });

  it('runSmoke adds the server result when a server URL is configured', async () => {
    const { engine } = fakeEngine({ move: 'e2e4' });
    const lines: string[] = [];
    await runSmoke({
      createEngine: async () => engine,
      log: (l) => lines.push(l),
      serverUrl: 'ws://127.0.0.1:2/ws',
      openSocket: () =>
        fakeSocket((s) => {
          s.onopen?.();
          s.onmessage?.({ data: JSON.stringify({ type: 'welcome' }) });
        }),
    });
    expect(parse(lines[0] ?? '').server).toEqual({ url: 'ws://127.0.0.1:2/ws', welcome: true });
  });
});
