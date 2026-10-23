/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { stockfishEngines } from './vite-plugin-stockfish';

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  plugins: [react(), stockfishEngines()],
  resolve: {
    alias: {
      '@chesslab/engine-core': fileURLToPath(
        new URL('../../packages/engine-core/src/index.ts', import.meta.url),
      ),
    },
  },
  server: { port: 5180, strictPort: true, headers },
  preview: { headers },
  test: { environment: 'jsdom', globals: false, exclude: ['**/node_modules/**', 'e2e/**'] },
});
