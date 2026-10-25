/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { buildPortalCsp } from './csp.config.mjs';

// The portal is served under /portal/ (nginx) and talks to the hub API at the same origin
// (/api/portal/*). PORTAL_API_PROXY forwards that path to a hub (dev server and `vite preview`, e2e);
// without it the API is simply absent. The Host header is kept so the hub's same-origin check passes.
const apiTarget = process.env.PORTAL_API_PROXY;
const proxy = apiTarget ? { '/api/portal': { target: apiTarget, changeOrigin: false } } : undefined;

export default defineConfig({
  base: '/portal/',
  plugins: [react()],
  server: { port: 5181, strictPort: true, ...(proxy ? { proxy } : {}) },
  preview: {
    headers: { 'Content-Security-Policy': buildPortalCsp(), 'Cache-Control': 'no-store' },
    ...(proxy ? { proxy } : {}),
  },
  test: {
    environment: 'jsdom',
    globals: false,
    exclude: ['**/node_modules/**', 'e2e/**'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
