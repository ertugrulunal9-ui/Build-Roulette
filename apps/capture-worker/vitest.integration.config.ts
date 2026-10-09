import { defineConfig } from 'vitest/config';

// Integration tests (`pnpm --filter @br/capture-worker test:integration`): real Chromium
// (Playwright, /opt/pw-browsers or the Playwright cache) and, for stack.test.ts, the real
// local Supabase stack. Not part of `pnpm test`. Files run one after another: they share
// the stack's job queue.
export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    // The Edge Function's tests have their own config (vitest.function.config.ts).
    exclude: ['integration/function.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
