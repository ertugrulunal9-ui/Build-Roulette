import { defineConfig } from '@playwright/test';

const APP_PORT = Number(process.env['APP_PORT'] ?? 4310);
const SHELL_PORT = Number(process.env['SHELL_PORT'] ?? 4311);
const OTHER_PORT = Number(process.env['OTHER_PORT'] ?? 4312);

export default defineConfig({
  testDir: './e2e',
  // Timing measurements and one shared sandbox origin (one site worker): run serially.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${String(APP_PORT)}/`,
    browserName: 'chromium',
    // Full Chromium (new headless), not the default headless shell: the headless shell does
    // not enable site isolation, so a cross-site iframe would share the app's renderer
    // thread and an infinite loop would freeze the app too. Desktop Chrome isolates sites.
    channel: 'chromium',
    headless: true,
  },
  webServer: {
    command: 'tsx test-support/dev-server.ts',
    url: `http://localhost:${String(APP_PORT)}/`,
    env: {
      APP_PORT: String(APP_PORT),
      SHELL_PORT: String(SHELL_PORT),
      OTHER_PORT: String(OTHER_PORT),
    },
    reuseExistingServer: false,
    stdout: 'pipe',
    timeout: 60_000,
  },
});
