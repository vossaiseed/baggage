import { defineConfig } from '@playwright/test';

/**
 * Browser tests for the static demo. They drive the real apps over the dev server and share one
 * origin (which is what makes the cross-role flows possible — every departure app reads the same
 * `rabel_v7` key in localStorage).
 *
 * `channel: 'chrome'` uses the Chrome already on the machine, so no browser download is needed.
 * Run with `npm run test:browser`.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.js',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5173/index.html',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
