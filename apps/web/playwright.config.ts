import { defineConfig } from '@playwright/test';
import { APP_SERVER_ENV, appServerCommand } from './e2e/app-server';

/**
 * E2E for /playground against the static export served like Cloudflare Pages serves it
 * (`wrangler pages dev out/`, e2e/app-server.ts), plus the local sandbox shell and mock CDN
 * (scripts/sandbox-servers.ts). Run with `pnpm --filter @br/web test:e2e` (builds first).
 * Not part of `pnpm test`.
 *
 * The shell and CDN ports are the defaults baked into the build (src/lib/playground/config.ts).
 */
const APP_PORT = Number(process.env['APP_PORT'] ?? 3100);
const APP_ORIGIN = `http://localhost:${String(APP_PORT)}`;

export default defineConfig({
  testDir: './e2e',
  // The solo game and the rooms need the Supabase stack: playwright.solo.config.ts
  // (`test:e2e:solo`), playwright.multi.config.ts (`test:e2e:multi`) and
  // playwright.chaos.config.ts (`test:e2e:chaos`); moderation and the link previews:
  // playwright.moderation.config.ts (`test:e2e:moderation`); error reporting and analytics:
  // playwright.telemetry.config.ts (`test:e2e:telemetry`).
  testIgnore: /(solo|multiplayer|chaos|moderation|link-preview|telemetry).*\.spec\.ts$/,
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
      command: appServerCommand(APP_PORT),
      url: `${APP_ORIGIN}/playground`,
      env: APP_SERVER_ENV,
      reuseExistingServer: false,
      stdout: 'pipe',
      timeout: 60_000,
    },
  ],
});
