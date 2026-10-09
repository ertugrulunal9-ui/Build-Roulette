import { defineConfig } from '@playwright/test';

/**
 * The runtime e2e suites that depend on the package CDN's response shape, against the mock CDN
 * in its `esm.sh` layout (T-035): every entry URL answers with a re-export of an internal build
 * path, like the public esm.sh does. Production on the free plan uses esm.sh, so the render
 * path and the T-032 outage behaviour (warm-up, cache, naming the package that failed) run
 * against both shapes. Own ports, so it can run right after `playwright.config.ts`.
 */
const APP_PORT = Number(process.env['ESM_SH_APP_PORT'] ?? 4316);
const SHELL_PORT = Number(process.env['ESM_SH_SHELL_PORT'] ?? 4317);
const CDN_PORT = Number(process.env['ESM_SH_CDN_PORT'] ?? 4318);
// e2e/cdn-outage.spec.ts reads the CDN's port from CDN_PORT (workers inherit this).
process.env['CDN_PORT'] = String(CDN_PORT);

export default defineConfig({
  testDir: './e2e',
  testMatch: ['render.spec.ts', 'cdn-outage.spec.ts'],
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: 'test-results/esm-sh',
  use: {
    baseURL: `http://localhost:${String(APP_PORT)}/`,
    browserName: 'chromium',
    channel: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'tsx test-support/dev-server.ts',
    url: `http://localhost:${String(APP_PORT)}/`,
    env: {
      APP_PORT: String(APP_PORT),
      SHELL_PORT: String(SHELL_PORT),
      CDN_PORT: String(CDN_PORT),
      CDN_LAYOUT: 'esm.sh',
    },
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 60_000,
  },
});
