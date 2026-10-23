import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ status: 'ok', version: pkg.version }));
  return app;
}
