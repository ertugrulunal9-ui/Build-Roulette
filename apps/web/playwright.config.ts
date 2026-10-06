import { defineConfig } from '@playwright/test';

/**
 * E2E for /playground against a production build (`next build && next start`), plus the
 * local sandbox shell and mock CDN (scripts/sandbox-servers.ts). Run with
 * `pnpm --filter @br/web test:e2e` (builds first). Not part of `pnpm test`.
 *
 * The shell and CDN ports are the defaults baked into the build (src/lib/playground/config.ts).
 *
 * `E2E_APP_SERVER=workers` runs the same tests against the Cloudflare Workers build instead
 * (OpenNext output served by `wrangler dev`, i.e. workerd). Build it first with
 * `pnpm cf:build`; `pnpm test:e2e:cf` does both.
 */
const APP_PORT = Number(process.env['APP_PORT'] ?? 3100);
const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;
const APP_SERVER_COMMAND =
  process.env['E2E_APP_SERVER'] === 'workers'
    ? `opennextjs-cloudflare preview --port ${String(APP_PORT)}`
    : `next start -p ${String(APP_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  // The solo game needs the Supabase stack: playwright.solo.config.ts (`test:e2e:solo`).
  testIgnore: /solo.*\.spec\.ts$/,
  // One shared mock CDN and shell, and timing-sensitive watchdog checks: run serially.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: APP_ORIGIN,
    browserName: 'chromium',
    // Full Chromium (new headless), not the headless shell: only full Chromium puts the
    // cross-site preview iframe in its own process, which the watchdog test depends on
    // (see packages/runtime/README.md, "Site isolation").
    channel: 'chromium',
    headless: true,
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
      url: `${APP_ORIGIN}/playground`,
      env: { NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' },
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 60_000,
    },
  ],
});
