import { createBaseConfig } from '@br/config/eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  nextVitals,
  createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  // Cloudflare build output (`pnpm cf:build`) and Wrangler local state; Playwright output
  // (a failed e2e run leaves the trace viewer's bundled JS in playwright-report/); the CPU
  // measurement's results (`pnpm measure:cpu` writes a calibration Worker there).
  globalIgnores([
    '.open-next/',
    '.wrangler/',
    'playwright-report/',
    'test-results/',
    'cpu-results/',
  ]),
);
