import { fileURLToPath } from 'node:url';
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
 * **Shards.** `CHAOS_SHARD=1|2|3` runs one third of the suite (CI runs the three as parallel
 * jobs, each with its own stack, about 5 minutes of tests each). A test joins shard 1 or 2
 * with `@chaos-1` / `@chaos-2` at the end of its title; shard 3 runs every test without
 * either tag, so a new test always runs somewhere. Measured locally (T-023): shard 1
 * (6 players, abandoned, full room) ≈ 4.7 min, shard 2 (random chaos, T-0) ≈ 4.4 min,
 * shard 3 (REVEAL/VOTE chaos, typing, 8 players) ≈ 3.5 min. Each shard has its own output
 * directory and report, so two shards can run side by side on one stack
 * (`E2E_REUSE_SERVERS=1`, servers started once).
 *
 * Same servers as the solo e2e (scripts/solo-services.ts, here with `--realtime`, which
 * fails fast when Realtime is not running) and `next start`. `E2E_REUSE_SERVERS=1` reuses
 * servers that are already running (start them with BR_SERVICES_LOG set to keep their logs
 * in the failure diagnostics).
 */
const APP_PORT = Number(process.env['APP_PORT'] ?? 3100);
const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;

const SHARD = process.env['CHAOS_SHARD'] ?? '';
const SHARD_FILTERS: Record<string, { grep?: RegExp; grepInvert?: RegExp }> = {
  '': {},
  '1': { grep: /@chaos-1\b/ },
  '2': { grep: /@chaos-2\b/ },
  '3': { grepInvert: /@chaos-[12]\b/ },
};
const shardFilter = SHARD_FILTERS[SHARD];
if (!shardFilter) throw new Error(`CHAOS_SHARD must be 1, 2 or 3 (got "${SHARD}")`);
const SUFFIX = SHARD ? `-shard-${SHARD}` : '';
const OUTPUT_DIR = `./test-results/chaos${SUFFIX}`;

// The services' output with timestamps, for the diagnostics of a failed test
// (e2e/diagnostics.ts). In the output directory: wiped at the start of a run, uploaded by CI.
const SERVICES_LOG = (process.env['BR_SERVICES_LOG'] ??= fileURLToPath(
  new URL(`${OUTPUT_DIR}/services.log`, import.meta.url),
));

export default defineConfig({
  testDir: './e2e',
  testMatch: /chaos.*\.spec\.ts$/,
  ...shardFilter,
  outputDir: OUTPUT_DIR,
  // One stack, one capture worker, one job queue: run serially.
  workers: 1,
  fullyParallel: false,
  // Each test sets its own budget (test.setTimeout).
  timeout: 600_000,
  expect: { timeout: 20_000 },
  // The HTML report keeps every failure's error, trace, screenshots and diagnostics
  // (players.md, db.json, services.log, docker-*.log) until the next run of this suite.
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: `playwright-report/chaos${SUFFIX}` }],
  ],
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
      command: `next start -p ${String(APP_PORT)}`,
      url: `${APP_ORIGIN}/`,
      env: { NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: process.env['E2E_REUSE_SERVERS'] === '1',
      stdout: 'pipe',
      timeout: 60_000,
    },
  ],
});
