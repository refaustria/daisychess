import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ENGINE_STYLES, PROTOCOL_BOUNDS } from '@daisychess/engine-core';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
// Option values end up in `setoption name X value Y`: a single line, never a newline.
const OptionValueSchema = z.union([
  z.string().regex(/^[^\r\n\0]*$/, 'option value must be a single line'),
  z.number(),
  z.boolean(),
]);

export const EngineConfigSchema = z.object({
  id: z.string().regex(ID_PATTERN, 'id must be alphanumeric (plus - and _)'),
  name: z.string().min(1),
  binary: z.string().min(1),
  /** Extra command-line arguments for the process (operator-controlled, e.g. Lc0 `--threads=1`). */
  args: z
    .array(z.string().regex(/^[^\r\n\0]+$/, 'argument must be a single line'))
    .max(32)
    .default([]),
  /**
   * Neural-network weights file, passed as `--weights=<path>` (Lc0, ADR-019). Resolved relative
   * to the registry file like `binary`; the engine is disabled when it is not readable.
   */
  weights: z.string().min(1).optional(),
  /**
   * UCI options set once after the handshake (e.g. `VerboseMoveStats` for Lc0). Operator-controlled
   * and not reachable by clients; `Threads`/`Hash`/`MultiPV` belong in `options` instead.
   */
  initOptions: z
    .record(z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_ ]*$/, 'invalid UCI option name'), OptionValueSchema)
    .default({}),
  enabled: z.boolean().default(true),
  /** Defaults for the client-settable `Threads`/`Hash` (`welcome.engines[].defaults`). */
  options: z.record(z.string(), OptionValueSchema).default({}),
  maxInstances: z.number().int().positive().default(1),
  /**
   * Process group (ADR-019): engines of one group share a total process cap (`EnginePool`
   * `groupLimits`), e.g. the nine Maia levels run at most `MAIA_MAX_PROCESSES` Lc0 processes.
   */
  group: z.string().regex(ID_PATTERN, 'group must be alphanumeric (plus - and _)').optional(),
  /** `human`: plays like people of `rating` (Maia); `strength` (default) plays to win. */
  style: z.enum(ENGINE_STYLES).default('strength'),
  rating: z.number().int().min(100).max(4_000).optional(),
  /** Hard node cap of this engine (Maia: 1 = the policy move); see `EngineDescriptor.maxNodes`. */
  maxNodes: z.number().int().min(PROTOCOL_BOUNDS.nodes.min).max(PROTOCOL_BOUNDS.nodes.max).optional(),
});

/** Command line of an engine process: configured `args` plus `--weights=<file>` when set. */
export function engineArgs(engine: Pick<EngineConfig, 'args' | 'weights'>): string[] {
  return engine.weights ? [...engine.args, `--weights=${engine.weights}`] : [...engine.args];
}

export const EngineRegistrySchema = z
  .object({
    engines: z.array(EngineConfigSchema),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.engines.forEach((engine, index) => {
      if (seen.has(engine.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['engines', index, 'id'],
          message: `duplicate engine id "${engine.id}"`,
        });
      }
      seen.add(engine.id);
    });
  });

export type EngineConfig = z.infer<typeof EngineConfigSchema>;
export type EngineRegistry = { engines: EngineConfig[] };

/**
 * Loads and validates an engines.json file. Each `binary` is resolved to an absolute path
 * relative to the directory containing the file.
 */
export async function loadEngineRegistry(filePath: string): Promise<EngineRegistry> {
  const absolute = path.resolve(filePath);
  let raw: string;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read engine registry ${absolute}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in engine registry ${absolute}: ${(err as Error).message}`);
  }
  const parsed = EngineRegistrySchema.safeParse(json);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid engine registry ${absolute}: ${details}`);
  }
  const dir = path.dirname(absolute);
  return {
    engines: parsed.data.engines.map((engine) => ({
      ...engine,
      binary: path.resolve(dir, engine.binary),
      ...(engine.weights ? { weights: path.resolve(dir, engine.weights) } : {}),
    })),
  };
}
