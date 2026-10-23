import { defineConfig, devices } from '@playwright/test';

// E2E_PORT / E2E_OUT_DIR let several runs share one checkout (separate preview server and build
// directory); defaults are the usual 4180 and dist/.
const port = Number(process.env.E2E_PORT ?? 4180);
const outDir = process.env.E2E_OUT_DIR ?? 'dist';

export default defineConfig({
  testDir: 'e2e',
  // Fails the run on any CSP violation reported by the preview server (vite.config.ts).
  globalSetup: './e2e/csp-violations.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: `pnpm exec vite build --outDir ${outDir} && pnpm exec vite preview --outDir ${outDir} --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
