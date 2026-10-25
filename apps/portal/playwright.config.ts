import { defineConfig, devices } from '@playwright/test';

// E2E_PORT: preview server of the portal build; the spec starts its own ROLE=hub server and fake
// lichess on other ports (see e2e/portal.spec.ts, which also sets PORTAL_API_PROXY for the webServer).
const port = Number(process.env.PORTAL_E2E_PORT ?? 4190);
const hubPort = Number(process.env.PORTAL_E2E_HUB_PORT ?? 8591);

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${port}`, screenshot: 'only-on-failure', viewport: { width: 1100, height: 900 } },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1100, height: 900 } } }],
  webServer: {
    command: `pnpm exec vite build --outDir dist-e2e && pnpm exec vite preview --outDir dist-e2e --port ${port} --strictPort`,
    url: `http://localhost:${port}/portal/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { PORTAL_API_PROXY: `http://127.0.0.1:${hubPort}` },
  },
});
