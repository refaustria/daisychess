import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 8580);
const host = process.env.HOST ?? '127.0.0.1';

const app = buildApp();
app.listen({ port, host }).then(
  (addr) => console.log(`ChessLab server listening on ${addr}`),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
