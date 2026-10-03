import { createBaseConfig } from '@br/config/eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
import { defineConfig } from 'eslint/config';

export default defineConfig(nextVitals, createBaseConfig({ tsconfigRootDir: import.meta.dirname }));
