import { defineConfig } from 'vitest/config';

// The `import-url` Edge Function's integration tests (T-051, `pnpm --filter @br/site
// test:function`): the local stack WITH the Edge Runtime (`supabase functions serve` is
// started by the test) and a static fixture server on this machine. Not part of `pnpm test`.
export default defineConfig({
  test: {
    include: ['integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
