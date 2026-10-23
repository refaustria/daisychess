import { z } from 'zod';

// zod v4 probes JIT support with `new Function("")`, which the CSP blocks (and reports).
// This module must be the first import of main.tsx: ESM evaluates imports before the importer's
// body, and the protocol schemas in @chesslab/engine-core are built at import time.
z.config({ jitless: true });
