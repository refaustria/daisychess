// Vitest setup (apps/web/vite.config.ts `test.setupFiles`): jsdom provides a `WebSocket`, so the
// shared api connection (ADR-017) is disabled for every test; tests that need it install a fake
// socket with `configureApiConnection({ createSocket })`.
import { configureApiConnection } from '../server/apiConnection';

configureApiConnection(null);
