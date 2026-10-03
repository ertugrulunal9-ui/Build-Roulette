import { describe, expect, it } from 'vitest';
import {
  detectBareImports,
  importSpecifiers,
  missingDependencies,
  packageNameOf,
} from './bare-imports';

describe('importSpecifiers', () => {
  it('finds static, side-effect, re-export, dynamic and require imports', () => {
    const src = `
import React, { useState } from 'react';
import * as THREE from "three";
import {
  a,
  b,
} from 'multi-line';
import './styles.css';
import 'animate.css/animate.min.css';
export { x } from 'reexport';
export * from 'reexport-all';
const lazy = await import('lazy-pkg');
const cjs = require('cjs-pkg');
const opts = import('with-opts', { with: { type: 'json' } });
`;
    expect(importSpecifiers(src)).toEqual([
      'react',
      'three',
      'multi-line',
      './styles.css',
      'animate.css/animate.min.css',
      'reexport',
      'reexport-all',
      'lazy-pkg',
      'cjs-pkg',
      'with-opts',
    ]);
  });

  it('ignores comments, strings and type-only imports', () => {
    const src = `
// import nope from 'line-comment';
/* import nope from 'block-comment'; */
/**
 * import nope from 'jsdoc';
 */
const s = "import nope from 'in-a-string'";
const t = \`import('in-a-template')\`;
import type { Foo } from 'types-only';
export type { Bar } from 'types-only-2';
import { real } from 'real';
`;
    expect(importSpecifiers(src)).toEqual(['real']);
  });

  it('handles escaped quotes inside strings', () => {
    const src = `const a = 'it\\'s import x from "nope"'; import y from 'yes';`;
    expect(importSpecifiers(src)).toEqual(['yes']);
  });
});

describe('packageNameOf', () => {
  it.each([
    ['react', { name: 'react', builtin: false }],
    ['react-dom/client', { name: 'react-dom', builtin: false }],
    ['@react-three/fiber', { name: '@react-three/fiber', builtin: false }],
    ['@react-three/drei/core/Text', { name: '@react-three/drei', builtin: false }],
    ['three/examples/jsm/controls/OrbitControls.js', { name: 'three', builtin: false }],
    ['fs', { name: 'fs', builtin: true }],
    ['node:path', { name: 'path', builtin: true }],
    ['node:fs/promises', { name: 'fs', builtin: true }],
  ])('%s', (spec, expected) => {
    expect(packageNameOf(spec)).toEqual(expected);
  });

  it.each([
    './App',
    '../x',
    '/src/x',
    'https://esm.sh/react',
    'data:text/js,1',
    '@/components/ui',
    '~/x',
    'UPPER',
    '',
  ])('is null for %j', (spec) => {
    expect(packageNameOf(spec)).toBeNull();
  });
});

describe('detectBareImports', () => {
  const files = {
    'src/main.tsx': `import { createRoot } from 'react-dom/client';\nimport { App } from './App';\nimport './styles.css';`,
    'src/App.tsx': `import { useState } from 'react';\nimport { create } from 'zustand';\nimport confetti from 'canvas-confetti';\nimport { Button } from '@/components/ui/button';`,
    'src/store.ts': `import { create } from 'zustand';\nimport { persist } from 'zustand/middleware';\nimport fs from 'node:fs';`,
    'src/styles.css': `@import 'should-not-count';`,
    'README.md': "import nope from 'markdown';",
  };

  it('groups specifiers by package across script files', () => {
    expect(detectBareImports(files)).toEqual([
      {
        name: 'canvas-confetti',
        specifiers: ['canvas-confetti'],
        files: ['src/App.tsx'],
        builtin: false,
      },
      { name: 'fs', specifiers: ['node:fs'], files: ['src/store.ts'], builtin: true },
      { name: 'react', specifiers: ['react'], files: ['src/App.tsx'], builtin: false },
      {
        name: 'react-dom',
        specifiers: ['react-dom/client'],
        files: ['src/main.tsx'],
        builtin: false,
      },
      {
        name: 'zustand',
        specifiers: ['zustand', 'zustand/middleware'],
        files: ['src/App.tsx', 'src/store.ts'],
        builtin: false,
      },
    ]);
  });

  it('missingDependencies lists undeclared packages, never built-ins', () => {
    expect(missingDependencies(files, { react: '19.3.0', 'react-dom': '19.3.0' })).toEqual([
      'canvas-confetti',
      'zustand',
    ]);
  });
});
