import { defineConfig } from 'vitest/config';

// The `jobs` Edge Function's integration tests (T-034, `pnpm --filter @br/capture-worker
// test:function`): the local stack WITH the Edge Runtime (`supabase functions serve` is
// started by the test), the Browser Rendering stand-in on Playwright Chromium, the shell's
// capture page and Storage. Not part of `pnpm test`.
export default defineConfig({
  test: {
    include: ['integration/function.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
