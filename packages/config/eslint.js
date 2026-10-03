// Shared ESLint flat-config preset: ESLint recommended + typescript-eslint strict and
// stylistic rules with type information (via the TypeScript project service).
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * @param {{ tsconfigRootDir: string }} options `tsconfigRootDir` is the package directory
 *   (pass `import.meta.dirname` from the package's eslint.config.js).
 */
export function createBaseConfig({ tsconfigRootDir }) {
  return defineConfig(
    globalIgnores([
      '**/node_modules/',
      '**/dist/',
      '**/.next/',
      '**/.turbo/',
      '**/coverage/',
      '**/next-env.d.ts',
    ]),
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      linterOptions: {
        reportUnusedDisableDirectives: 'error',
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      },
    },
    {
      // Plain JS config files (eslint.config.js, postcss.config.mjs, ...) run in Node and
      // are not part of any tsconfig, so type-aware rules are switched off for them.
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: {
        globals: globals.node,
      },
    },
  );
}
