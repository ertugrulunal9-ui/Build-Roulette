import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // scripts/: the CPU measurement's estimator (scripts/measure-cpu, T-033).
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
  },
});
