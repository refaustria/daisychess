import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { SpawnEngine } from '../src/engines/EnginePool.js';
import type { EngineConfig, EngineRegistry } from '../src/engines/registry.js';
import { UciProcess, type UciProcessOptions } from '../src/engines/UciProcess.js';

export const FAKE_ENGINE = fileURLToPath(new URL('./fake-engine.mjs', import.meta.url));

/** A UciProcess running the fake engine with the given flags (via `node`, no exec bit needed). */
export function fakeProcess(flags: string[] = [], opts: UciProcessOptions = {}): UciProcess {
  return new UciProcess(process.execPath, { ...opts, args: [FAKE_ENGINE, ...flags] });
}

/** Spawner for EnginePool/buildApp: per-engine-id fake engine flags. */
export function fakeSpawner(
  flagsById: Record<string, string[]> = {},
  opts: UciProcessOptions = {},
): SpawnEngine {
  return (cfg: EngineConfig) => fakeProcess(flagsById[cfg.id] ?? [], opts);
}

export function engineConfig(partial: Partial<EngineConfig> & { id: string }): EngineConfig {
  return {
    name: partial.id,
    binary: FAKE_ENGINE,
    enabled: true,
    options: { Threads: 1, Hash: 16 },
    maxInstances: 1,
    ...partial,
  };
}

export function registry(...engines: (Partial<EngineConfig> & { id: string })[]): EngineRegistry {
  return { engines: engines.map(engineConfig) };
}

/** PIDs of running fake engine processes (any test file). */
export function fakeEnginePids(): Promise<number[]> {
  return new Promise((resolve) => {
    // Anchored to the exact command line we spawn, so shells mentioning the file don't match.
    const pattern = `^${escapeRegex(process.execPath)} ${escapeRegex(FAKE_ENGINE)}`;
    execFile('pgrep', ['-f', pattern], (err, stdout) => {
      if (err) return resolve([]); // exit code 1 = no match
      resolve(
        stdout
          .split('\n')
          .filter(Boolean)
          .map(Number)
          .filter((pid) => pid !== process.pid),
      );
    });
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isRunning(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}
