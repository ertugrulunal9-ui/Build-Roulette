import { createBaseConfig } from '@br/config/eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  nextVitals,
  createBaseConfig({ tsconfigRootDir: import.meta.dirname }),
  // Cloudflare build output (`pnpm cf:build`) and Wrangler local state.
  globalIgnores(['.open-next/', '.wrangler/']),
);
