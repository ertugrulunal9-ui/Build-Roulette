import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import { APP_SERVER_ENV, appServerCommand } from './e2e/app-server';

/**
 * E2E for rooms (`e2e/multiplayer*.spec.ts`): several browser contexts (each one an
 * anonymous player) against the REAL local Supabase stack WITH Realtime, and the capture
 * worker running: `pnpm --filter @br/web test:e2e:multi` (builds first). The stack must be
 * up with Realtime (`supabase start` without `realtime` in `-x`, see supabase/README.md);
 * the tests move deadlines with psql as the superuser and commit their data.
 *
 * Same servers as the solo e2e (scripts/solo-services.ts, here with `--realtime`, which
 * fails fast when Realtime is not running) and the static export served by `wrangler pages
 * dev` (e2e/app-server.ts). `E2E_REUSE_SERVERS=1` reuses servers that are already running.
 */
const APP_PORT = Number(process.env['APP_PORT'] ?? 3100);
const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;
// The services' output with timestamps, for the diagnostics of a failed test
// (e2e/diagnostics.ts). In the output directory: wiped at the start of a run, uploaded by CI.
const SERVICES_LOG = (process.env['BR_SERVICES_LOG'] ??= fileURLToPath(
  new URL('./test-results/services.log', import.meta.url),
));

export default defineConfig({
  testDir: './e2e',
  testMatch: /multiplayer.*\.spec\.ts$/,
  // One stack, one capture worker, one job queue: run serially.
  workers: 1,
  fullyParallel: false,
  timeout: 420_000,
  expect: { timeout: 20_000 },
  // The HTML report keeps every failure's error, trace, screenshots and diagnostics
  // (players.md, db.json, services.log, docker-*.log) until the next run of this suite.
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/multi' }]],
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
      env: { BR_APP_ORIGINS: APP_ORIGIN, BR_SERVICES_LOG: SERVICES_LOG },
      gracefulShutdown: { signal: 'SIGTERM', timeout: 40_000 },
      reuseExistingServer: process.env['E2E_REUSE_SERVERS'] === '1',
      stdout: 'pipe',
      timeout: 120_000,
    },
    {
      command: appServerCommand(APP_PORT),
      url: `${APP_ORIGIN}/`,
      env: APP_SERVER_ENV,
      reuseExistingServer: process.env['E2E_REUSE_SERVERS'] === '1',
      stdout: 'pipe',
      timeout: 60_000,
    },
  ],
});
