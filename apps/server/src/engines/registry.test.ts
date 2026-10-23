import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEngineRegistry } from './registry.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'registry-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name: string, content: string): Promise<string> {
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

describe('loadEngineRegistry', () => {
  it('loads a valid file and applies defaults', async () => {
    const file = await write(
      'engines.json',
      JSON.stringify({
        _comment: 'ignored',
        engines: [{ id: 'stockfish', name: 'Stockfish', binary: 'bin/sf', options: { Hash: 64 } }],
      }),
    );
    const reg = await loadEngineRegistry(file);
    expect(reg.engines).toHaveLength(1);
    expect(reg.engines[0]).toMatchObject({
      id: 'stockfish',
      enabled: true,
      maxInstances: 1,
      options: { Hash: 64 },
    });
  });

  it('resolves binary relative to the file directory', async () => {
    const file = await write(
      'conf/engines.json',
      JSON.stringify({ engines: [{ id: 'a', name: 'A', binary: '../engines/a/a' }] }),
    );
    const reg = await loadEngineRegistry(file);
    expect(reg.engines[0]?.binary).toBe(path.join(dir, 'engines/a/a'));
  });

  it('throws on invalid schema', async () => {
    const file = await write('engines.json', JSON.stringify({ engines: [{ id: 'a' }] }));
    await expect(loadEngineRegistry(file)).rejects.toThrow(/Invalid engine registry/);
  });

  it('throws on duplicate ids', async () => {
    const e = { id: 'a', name: 'A', binary: 'a' };
    const file = await write('engines.json', JSON.stringify({ engines: [e, e] }));
    await expect(loadEngineRegistry(file)).rejects.toThrow(/duplicate engine id/);
  });

  it('throws on invalid JSON and missing file', async () => {
    const file = await write('engines.json', '{ nope');
    await expect(loadEngineRegistry(file)).rejects.toThrow(/Invalid JSON/);
    await expect(loadEngineRegistry(path.join(dir, 'missing.json'))).rejects.toThrow(/Cannot read/);
  });
});
