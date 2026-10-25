import { defineConfig, devices } from '@playwright/test';

// The specs run against a production build (`dist-e2e`) served by `vite preview`, which sends the
// same CSP and security headers as nginx (csp.config.mjs) and answers unknown paths with 404.html.
// SITE_E2E_PORT overrides the port (default 4192; the web app's e2e uses 4180, the portal's 4190).
const port = Number(process.env.SITE_E2E_PORT ?? 4192);

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/artifacts',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    screenshot: 'only-on-failure',
    // SwiftShader gives headless Chromium a software WebGL context for the 3D hero.
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `pnpm exec vite build --outDir dist-e2e && pnpm exec vite preview --outDir dist-e2e --port ${port} --strictPort`,
    url: `http://localhost:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
