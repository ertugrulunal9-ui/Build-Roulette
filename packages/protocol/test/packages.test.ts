import { describe, expect, it } from 'vitest';
import {
  describePackageFailures,
  describePackageStall,
  errorDetail,
  isPackageStall,
  leadingImports,
  moduleImportUrls,
  packageLabel,
} from '../src/index';

const CDN = 'https://pkg.example';

describe('packageLabel', () => {
  it('is the package path of a CDN URL, without the query', () => {
    expect(packageLabel(`${CDN}/zustand@5.0.15?external=react,react-dom&deps=x@1.0.0`)).toBe(
      'zustand@5.0.15',
    );
    expect(packageLabel(`${CDN}/react-dom@19.3.0/client?external=react,react-dom`)).toBe(
      'react-dom@19.3.0/client',
    );
    expect(packageLabel(`${CDN}/@react-three/fiber@9.4.0`)).toBe('@react-three/fiber@9.4.0');
    expect(packageLabel(`${CDN}/%40scope/pkg@1.0.0`)).toBe('@scope/pkg@1.0.0');
  });
  it('falls back to the input for anything else', () => {
    expect(packageLabel('not a url')).toBe('not a url');
    expect(packageLabel(`${CDN}/`)).toBe(`${CDN}/`);
    expect(packageLabel(`${CDN}/%E0%A4%A`)).toBe(`${CDN}/%E0%A4%A`);
  });
});

describe('describePackageFailures', () => {
  it('names an unreachable package and says what still works', () => {
    expect(
      describePackageFailures([
        { url: `${CDN}/zustand@5.0.15?external=react,react-dom`, kind: 'unreachable' },
      ]),
    ).toBe(
      'Package server unreachable: zustand@5.0.15\nPackages this browser loaded before keep working; a new one needs the package server.',
    );
  });

  it('lists at most three names, deduplicated, and counts the rest', () => {
    const urls = ['a@1.0.0', 'b@1.0.0', 'b@1.0.0', 'c@1.0.0', 'd@1.0.0', 'e@1.0.0'].map(
      (p, i) => `${CDN}/${p}?v=${String(i)}`,
    );
    const text = describePackageFailures(urls.map((url) => ({ url, kind: 'unreachable' })));
    expect(text?.split('\n')[0]).toBe(
      'Package server unreachable: a@1.0.0, b@1.0.0, c@1.0.0 (+2 more)',
    );
  });

  it('reports timeouts and HTTP errors with the server text, worst first', () => {
    const text = describePackageFailures([
      { url: `${CDN}/x@4.0.0`, kind: 'http', status: 404, detail: 'x@4.0.0 not available' },
      { url: `${CDN}/three@0.186.1`, kind: 'timeout' },
    ]);
    expect(text?.split('\n')).toEqual([
      'Package server not responding: three@0.186.1',
      'Package server error (HTTP 404) for x@4.0.0: x@4.0.0 not available',
      'Packages this browser loaded before keep working; a new one needs the package server.',
    ]);
    expect(describePackageFailures([{ url: `${CDN}/x@4.0.0`, kind: 'http', status: 403 }])).toBe(
      'Package server error (HTTP 403) for x@4.0.0',
    );
  });

  it('is null when nothing failed', () => {
    expect(describePackageFailures([])).toBeNull();
  });
});

describe('describePackageStall', () => {
  it('says what the preview still waits for, or nothing', () => {
    expect(describePackageStall([`${CDN}/three@0.186.1?external=react,react-dom`], 8000)).toBe(
      'Still waiting for the package server after 8 s: three@0.186.1\nThe preview starts as soon as it answers.',
    );
    expect(describePackageStall([], 8000)).toBeNull();
    expect(isPackageStall(describePackageStall([`${CDN}/a@1.0.0`], 8000) ?? '')).toBe(true);
    expect(
      isPackageStall(describePackageFailures([{ url: `${CDN}/a@1.0.0`, kind: 'timeout' }]) ?? ''),
    ).toBe(false);
  });
});

describe('errorDetail', () => {
  it('keeps the first line, trimmed and capped', () => {
    expect(errorDetail('  pkg-cdn: denied\nmore')).toBe('pkg-cdn: denied');
    expect(errorDetail('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(errorDetail('')).toBe('');
  });

  it('gives the message of an esm.sh error module, skipping comment lines', () => {
    expect(
      errorDetail(
        '/* esm.sh - error */\nthrow new Error("[esm.sh] Could not resolve \\"x\\" (imported by \\"y\\")");\nexport default null;\n',
      ),
    ).toBe('[esm.sh] Could not resolve "x" (imported by "y")');
    expect(errorDetail('// note\nPackage Not Found')).toBe('Package Not Found');
    expect(errorDetail('throw new Error(not json);')).toBe('throw new Error(not json);');
  });
});

describe('leadingImports', () => {
  it('reads the leading static imports and re-exports of bundler output', () => {
    // An esm.sh entry module (the shape of /react-dom@19.3.0/client).
    expect(
      leadingImports(
        '/* esm.sh - react-dom@19.3.0/client */\nimport "/scheduler@0.27.0/es2022/scheduler.mjs";\nexport * from "/react-dom@19.3.0/X-ZXJlYWN0/es2022/client.mjs";\nexport { default } from "/react-dom@19.3.0/X-ZXJlYWN0/es2022/client.mjs";\n',
      ),
    ).toEqual([
      '/scheduler@0.27.0/es2022/scheduler.mjs',
      '/react-dom@19.3.0/X-ZXJlYWN0/es2022/client.mjs',
      '/react-dom@19.3.0/X-ZXJlYWN0/es2022/client.mjs',
    ]);
    // Minified esbuild output: every clause shape, then code that only looks like imports.
    expect(
      leadingImports(
        '"use strict";import*as e from"/a.mjs";import{jsx as t,Fragment as r}from"react/jsx-runtime";import n,{b as o}from\'./b.mjs\';export*from"/c.mjs";export{default}from"/d.mjs";import"/e.css";var s=\'import x from "/no.mjs"\';import("/lazy.mjs");',
      ),
    ).toEqual(['/a.mjs', 'react/jsx-runtime', './b.mjs', '/c.mjs', '/d.mjs', '/e.css']);
  });

  it('stops at the first other statement and at `max`', () => {
    expect(leadingImports('const x = 1;\nimport "/late.mjs";')).toEqual([]);
    expect(leadingImports('export const a = "/x.mjs";')).toEqual([]);
    expect(leadingImports('import.meta.url;import "/x.mjs";')).toEqual([]);
    expect(leadingImports('importScripts("/x.js");')).toEqual([]);
    expect(leadingImports('import{fromEvent}from"rx";// c\n/* d */import"/y.mjs"')).toEqual([
      'rx',
      '/y.mjs',
    ]);
    expect(leadingImports('import "/1";import "/2";import "/3";', 2)).toEqual(['/1', '/2']);
    expect(leadingImports('')).toEqual([]);
  });
});

describe('moduleImportUrls', () => {
  it('resolves path and same-origin imports, and leaves bare and foreign ones out', () => {
    const source =
      'import "react";import "/react@19.3.0/es2022/react.mjs";import "./x.mjs?y#z";import "https://esm.sh/a@1.0.0";import "https://evil.example/b.mjs";import "/react@19.3.0/es2022/react.mjs";';
    expect(moduleImportUrls(source, 'https://esm.sh/react@19.3.0/jsx-runtime?external=react')).toEqual([
      'https://esm.sh/react@19.3.0/es2022/react.mjs',
      'https://esm.sh/react@19.3.0/x.mjs?y',
      'https://esm.sh/a@1.0.0',
    ]);
    // @br/pkg-cdn's peer URLs keep their query.
    expect(
      moduleImportUrls(
        'import*as e from"/three@0.186.1?external=react,react-dom";',
        'http://localhost:4400/@react-three/fiber@9.8.1?external=react,react-dom',
      ),
    ).toEqual(['http://localhost:4400/three@0.186.1?external=react,react-dom']);
    expect(moduleImportUrls('import "/x";', 'not a url')).toEqual([]);
  });
});
