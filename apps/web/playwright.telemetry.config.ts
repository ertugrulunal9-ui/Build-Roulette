import { defineConfig } from '@playwright/test';

/**
 * Error reporting and analytics end to end (T-030) against a local fake ingest (Sentry
 * envelopes and PostHog batches, `@br/telemetry/testing`, started by the specs on port 4399).
 * Needs the local Supabase stack (rooms, the admin). `pnpm --filter @br/web test:e2e:telemetry`
 * runs both halves, each against its own production build:
 *
 * - `E2E_TELEMETRY=on` (`build:telemetry`: the DSN, the PostHog key and host pointing at the
 *   fake ingest): e2e/telemetry-on.spec.ts. A browser error and a server error (on `next
 *   start`, or on the Workers preview with `E2E_APP_SERVER=workers`) and the analytics events
 *   arrive scrubbed; nothing from the sandbox iframe; DNT/GPC respected.
 * - `E2E_TELEMETRY=off` (the plain build): e2e/telemetry-off.spec.ts. Nothing is loaded and
 *   nothing is requested.
 *
 * `test:e2e:cf:telemetry` runs the "on" half against the Workers build (`cf:build`).
 */
const MODE = process.env['E2E_TELEMETRY'] === 'off' ? 'off' : 'on';
const APP_PORT = Number(process.env['APP_PORT'] ?? 3100);
const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;
const APP_SERVER_COMMAND =
  process.env['E2E_APP_SERVER'] === 'workers'
    ? `opennextjs-cloudflare preview --port ${String(APP_PORT)}`
    : `next start -p ${String(APP_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: MODE === 'on' ? /telemetry-on\.spec\.ts$/ : /telemetry-off\.spec\.ts$/,
  // One fake ingest on a fixed port (baked into the "on" build): run serially.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: APP_ORIGIN,
    browserName: 'chromium',
    channel: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'tsx scripts/sandbox-servers.ts',
      url: 'http://127.0.0.1:4321/v1/',
      env: { BR_APP_ORIGINS: APP_ORIGIN },
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 60_000,
    },
    {
      command: APP_SERVER_COMMAND,
      url: `${APP_ORIGIN}/play`,
      env: { NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' },
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 60_000,
    },
  ],
});
