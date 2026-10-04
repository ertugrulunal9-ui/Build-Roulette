import { defineConfig } from 'vitest/config';

// Unit tests: fakes only, no browser, no Supabase (part of `pnpm test`).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
