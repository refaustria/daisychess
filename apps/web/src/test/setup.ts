// Vitest setup (apps/web/vite.config.ts `test.setupFiles`): jsdom provides a `WebSocket`, so the
// shared api connection (ADR-017) is disabled for every test; tests that need it install a fake
// socket with `configureApiConnection({ createSocket })`.
import { setHumanProbe } from '../maia/opponentProbe';
import { setMaiaHintClientFactory } from '../maia/hintClient';
import { configureApiConnection } from '../server/apiConnection';

configureApiConnection(null);

// No engine server in unit tests: the Play/Openings panels would probe it for Maia (M23-2).
setHumanProbe(() => undefined);

// No engine server for the review's human-like hints either (M23-3); hint tests install a fake.
setMaiaHintClientFactory(null);
