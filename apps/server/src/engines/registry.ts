import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const EngineConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/i, 'id must be alphanumeric (plus - and _)'),
  name: z.string().min(1),
  binary: z.string().min(1),
  enabled: z.boolean().default(true),
  options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  maxInstances: z.number().int().positive().default(1),
});

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
    })),
  };
}
