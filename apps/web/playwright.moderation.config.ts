import { defineConfig } from '@playwright/test';
import { APP_SERVER_ENV, appServerCommand } from './e2e/app-server';

/**
 * E2E for moderation (T-024, `e2e/moderation.spec.ts`) and the per-battle link previews
 * (T-038, `e2e/link-preview.spec.ts`: the Pages Function on `/battles/*`) against the REAL
 * local Supabase stack, with the jobs Edge Function running (its takedown job deletes the
 * screenshot): `pnpm --filter @br/web test:e2e:moderation` (builds first). The stack must be
 * up (`supabase start`); the tests insert finished battles with psql, seed an email admin with
 * supabase/scripts/seed-admin.mjs, and commit their data. Same servers as the solo e2e.
 *
 * scripts/solo-services.ts starts the sandbox shell (with the capture gate), the mock CDN and
 * the jobs Edge Function with its Browser Rendering stand-in (T-034; `--worker`: the Node
 * worker); Playwright serves the static export with `wrangler pages dev` (e2e/app-server.ts),
 * the way Cloudflare Pages serves it. The production build uses the
 * default (local) Supabase URL and anon key. `E2E_REUSE_SERVERS=1` reuses servers already
 * running (e.g. `tsx scripts/solo-services.ts` + `wrangler pages dev --port 3100 --ip
 * localhost`) while iterating.
 */
const APP_PORT = Number(process.env['APP_PORT'] ?? 3100);
const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /(moderation|link-preview)\.spec\.ts$/,
  // One stack, one job queue (and one admin): run serially.
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
      // SIGTERM, so solo-services removes its pg_cron schedule and Vault secrets (and a
      // --worker hands its job back) before it exits.
      gracefulShutdown: { signal: 'SIGTERM', timeout: 40_000 },
      reuseExistingServer: process.env['E2E_REUSE_SERVERS'] === '1',
      stdout: 'pipe',
      timeout: 120_000,
    },
    {
      command: appServerCommand(APP_PORT),
      url: `${APP_ORIGIN}/play`,
      env: APP_SERVER_ENV,
      reuseExistingServer: process.env['E2E_REUSE_SERVERS'] === '1',
      stdout: 'pipe',
      timeout: 60_000,
    },
  ],
});
