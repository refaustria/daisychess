import type { UciTransport } from './UciSession';

/** Scriptable fake UCI engine for unit tests. Answers `uci`/`isready` automatically unless disabled. */
export class FakeUciEngine implements UciTransport {
  readonly sent: string[] = [];
  autoHandshake = true;
  autoReady = true;
  private cb: ((line: string) => void) | null = null;

  send(line: string): void {
    this.sent.push(line);
    if (line === 'uci' && this.autoHandshake) {
      queueMicrotask(() => {
        this.emit('id name Stockfish 19 Fake');
        this.emit('option name Threads type spin default 1 min 1 max 1024');
        this.emit('option name MultiPV type spin default 1 min 1 max 256');
        this.emit('uciok');
      });
    }
    if (line === 'isready' && this.autoReady) queueMicrotask(() => this.emit('readyok'));
  }

  onLine(cb: (line: string) => void): void {
    this.cb = cb;
  }

  emit(line: string): void {
    this.cb?.(line);
  }

  /** Commands sent after the handshake / since index `from`. */
  since(from: number): string[] {
    return this.sent.slice(from);
  }
}

/** Let queued microtasks and promise chains settle. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
