import { defineConfig } from '@playwright/test';

/**
 * Chaos e2e for rooms (`e2e/chaos*.spec.ts`, docs/04 §4.8 and the M3 exit criteria): up to
 * 10 browser contexts against the REAL local Supabase stack WITH Realtime, pg_cron and the
 * capture worker, with network drops, skewed clocks, refreshes, a host who vanishes,
 * everyone gone at T-0, an abandoned battle, REVEAL and VOTE under chaos, an 8-player battle
 * and a full room:
 * `pnpm --filter @br/web test:e2e:chaos` (builds first). About 13 minutes: the battles run
 * real (shortened) deadlines. The stack must be
 * up with Realtime (`supabase start` without `realtime` in `-x`, see supabase/README.md);
 * the tests move deadlines with psql as the superuser and commit their data.
 *
 * Same servers as the solo e2e (scripts/solo-services.ts, here with `--realtime`, which
 * fails fast when Realtime is not running) and `next start`. `E2E_REUSE_SERVERS=1` reuses
 * servers that are already running.
 */
const APP_PORT = Number(process.env['APP_PORT'] ?? 3100);
const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /chaos.*\.spec\.ts$/,
  // One stack, one capture worker, one job queue: run serially.
  workers: 1,
  fullyParallel: false,
  // Each test sets its own budget (test.setTimeout).
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: APP_ORIGIN,
    browserName: 'chromium',
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'tsx scripts/solo-services.ts --realtime',
      url: 'http://127.0.0.1:4321/v1/',
      env: { BR_APP_ORIGINS: APP_ORIGIN },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 40_000 },
      reuseExistingServer: process.env['E2E_REUSE_SERVERS'] === '1',
      stdout: 'pipe',
      timeout: 120_000,
    },
    {
      command: `next start -p ${String(APP_PORT)}`,
      url: `${APP_ORIGIN}/`,
      env: { NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: process.env['E2E_REUSE_SERVERS'] === '1',
      stdout: 'pipe',
      timeout: 60_000,
    },
  ],
});
