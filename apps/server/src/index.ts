import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp({ config });

let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'shutting down');
  setTimeout(() => process.exit(1), 10_000).unref();
  app.close().then(
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
