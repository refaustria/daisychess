import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp({ config });

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  // A node first drains (ADR-020 §3: `node.drain`, running searches finish within drainMs).
  const link = config.node ? app.daisychessNode.link : null;
  const drainMs = link?.currentWelcome?.drainMs ?? 0;
  setTimeout(() => process.exit(1), 10_000 + drainMs).unref();
  (link ? link.drain('shutdown') : Promise.resolve())
    .catch((err: unknown) => app.log.error({ err }, 'error while draining'))
    .then(() => app.close())
    .then(
      () => process.exit(0),
      (err: unknown) => {
        app.log.error({ err }, 'error during shutdown');
        process.exit(1);
      },
    );
};
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  await app.close().catch(() => {});
  process.exit(1);
}
