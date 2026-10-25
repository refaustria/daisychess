import { afterEach, describe, expect, it } from 'vitest';
import type { EngineInfo } from '@daisychess/engine-core';
import { fakeProcess, isRunning } from '../../test/helpers.js';
import {
  UciProcess,
  UciProcessExitedError,
  UciTimeoutError,
  type ExitInfo,
  type UciOptions,
} from './UciProcess.js';

const procs: UciProcess[] = [];
function make(...args: Parameters<typeof fakeProcess>): UciProcess {
  const p = fakeProcess(...args);
  procs.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(procs.splice(0).map((p) => p.dispose()));
});

function nextExit(p: UciProcess): Promise<ExitInfo> {
  return new Promise((resolve) => p.onExit(resolve));
}

describe('UciProcess', () => {
  it('performs the uci/isready handshake and records id and options', async () => {
    const p = make();
    await p.start();
    expect(p.alive).toBe(true);
    expect(p.pid).toBeTypeOf('number');
    expect(p.engineName).toBe('FakeEngine 1.0');
    expect([...p.supportedOptions]).toEqual(['Threads', 'Hash', 'MultiPV']);
    await p.isReady();
  });

  it('runs a depth search, relays parsed infos only and resolves with the bestmove', async () => {
    const p = make();
    await p.start();
    const raw: string[] = [];
    p.onLine((l) => raw.push(l));
    const infos: EngineInfo[] = [];
    p.position('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    const res = await p.go({ depth: 3 }, (i) => infos.push(i));
    expect(res.bestMove).toEqual({ move: 'e2e4', ponder: 'e7e5' });
    expect(infos.map((i) => i.depth)).toEqual([1, 2, 3]);
    expect(infos[0]).toMatchObject({ multipv: 1, score: { cp: 9 }, pv: ['e2e4', 'e7e5', 'g1f3'] });
    // currmove / info string lines reach onLine but not onInfo
    expect(raw.some((l) => l.includes('currmove'))).toBe(true);
    expect(p.searching).toBe(false);
  });

  it('sets allowed options once (cached) and waits for readyok', async () => {
    const p = make();
    await p.start();
    const raw: string[] = [];
    p.onLine((l) => raw.push(l));
    await p.setOptions({ MultiPV: 2, Threads: 3 });
    await p.setOptions({ MultiPV: 2, Threads: 3 });
    await p.isReady();
    expect(raw.filter((l) => l.startsWith('info string setoption'))).toEqual([
      'info string setoption MultiPV=2',
      'info string setoption Threads=3',
    ]);
    const infos: EngineInfo[] = [];
    await p.go({ depth: 2 }, (i) => infos.push(i));
    expect(infos.map((i) => i.multipv)).toEqual([1, 2, 1, 2]);
  });

  it('rejects options outside the allow-list without sending anything', async () => {
    const p = make();
    await p.start();
    const raw: string[] = [];
    p.onLine((l) => raw.push(l));
    const evil = { 'Debug Log File': '/tmp/x' } as unknown as UciOptions;
    await expect(p.setOptions(evil)).rejects.toThrow(/not allowed/);
    await expect(p.setOptions({ Threads: 1.5 })).rejects.toThrow(/integer/);
    await p.isReady();
    expect(raw.filter((l) => l.startsWith('info string setoption'))).toEqual([]);
  });

  it('rejects multi-line commands', async () => {
    const p = make();
    await p.start();
    expect(() => p.send('isready\nquit')).toThrow(/single line/);
    expect(() => p.position('8/8/8/8/8/8/8/8 w - - 0 1\rquit')).toThrow(/single line/);
    expect(p.alive).toBe(true);
  });

  it('stops an infinite search and resolves the pending go', async () => {
    const p = make();
    await p.start();
    const go = p.go({ infinite: true });
    expect(() => p.go({ depth: 1 })).toThrow(/already running/);
    await new Promise((r) => setTimeout(r, 30));
    const stopped = p.stop();
    await expect(stopped).resolves.toEqual({ bestMove: { move: 'e2e4', ponder: 'e7e5' } });
    await expect(go).resolves.toBeTruthy();
    await expect(p.stop()).resolves.toBeNull();
  });

  it('surfaces a crash as an exit event and rejects the running search', async () => {
    const p = make();
    await p.start();
    const exit = nextExit(p);
    const go = p.go({ infinite: true });
    p.send('crash');
    await expect(go).rejects.toBeInstanceOf(UciProcessExitedError);
    const info = await exit;
    expect(info).toMatchObject({ code: 3, expected: false });
    expect(info.stderr.join('\n')).toContain('crash requested');
    expect(p.alive).toBe(false);
    expect(() => p.send('isready')).toThrow(UciProcessExitedError);
  });

  it('dispose sends quit/SIGTERM and reports an expected exit', async () => {
    const p = make();
    await p.start();
    const pid = p.pid;
    const info = await p.dispose();
    expect(info?.expected).toBe(true);
    expect(isRunning(pid)).toBe(false);
    expect(await p.dispose()).toBe(info);
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const p = make(['--ignore-sigterm'], { killTimeoutMs: 200 });
    await p.start();
    const t0 = Date.now();
    const info = await p.dispose();
    expect(info?.signal).toBe('SIGKILL');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
  });

  it('times out the handshake and leaves no process behind', async () => {
    const p = make(['--no-uciok'], { handshakeTimeoutMs: 200 });
    await expect(p.start()).rejects.toBeInstanceOf(UciTimeoutError);
    expect(p.exited).not.toBeNull();
    expect(isRunning(p.pid)).toBe(false);
  });

  it('reports a binary that cannot be spawned', async () => {
    const p = new UciProcess('/nonexistent/engine');
    procs.push(p);
    const err = await p.start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UciProcessExitedError);
    expect((err as UciProcessExitedError).exit.error?.message).toMatch(/ENOENT/);
  });

  it('times out isready on a hung engine', async () => {
    const p = make(['--hang-on-newgame']);
    await p.start();
    await expect(p.newGame(200)).rejects.toBeInstanceOf(UciTimeoutError);
  });
});
