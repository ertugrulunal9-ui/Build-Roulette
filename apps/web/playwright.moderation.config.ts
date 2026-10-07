import { defineConfig } from '@playwright/test';

/**
 * E2E for moderation (T-024, `e2e/moderation.spec.ts`) against the REAL local Supabase stack,
 * with the capture worker running (its takedown loop deletes the screenshot):
 * `pnpm --filter @br/web test:e2e:moderation` (builds first). The stack must be up
 * (`supabase start`); the test inserts a finished battle with psql, seeds an email admin
 * with supabase/scripts/seed-admin.mjs, and commits its data. Same servers as the solo e2e.
 *
 * scripts/solo-services.ts starts the sandbox shell (with the capture gate), the mock CDN and
 * the capture worker; Playwright starts `next start`. The production build uses the default
 * (local) Supabase URL and anon key. `E2E_REUSE_SERVERS=1` reuses servers already running
 * (e.g. `tsx scripts/solo-services.ts` + `next start -p 3100`) while iterating.
 */
const APP_PORT = Number(process.env['APP_PORT'] ?? 3100);
const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /moderation\.spec\.ts$/,
  // One stack, one capture worker, one job queue (and one admin): run serially.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: APP_ORIGIN,
    browserName: 'chromium',
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    // A long, stateful flow: keep what is needed to debug a failure (CI uploads test-results).
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'tsx scripts/solo-services.ts',
      url: 'http://127.0.0.1:4321/v1/',
      env: { BR_APP_ORIGINS: APP_ORIGIN },
      // SIGTERM, so the capture worker can hand its job back before it exits.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 40_000 },
      reuseExistingServer: process.env['E2E_REUSE_SERVERS'] === '1',
      stdout: 'pipe',
      timeout: 120_000,
    },
    {
      command: `next start -p ${String(APP_PORT)}`,
      url: `${APP_ORIGIN}/play`,
      env: { NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: process.env['E2E_REUSE_SERVERS'] === '1',
      stdout: 'pipe',
      timeout: 60_000,
    },
  ],
});
