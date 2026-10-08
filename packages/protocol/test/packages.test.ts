import { describe, expect, it } from 'vitest';
import {
  describePackageFailures,
  describePackageStall,
  errorDetail,
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
    expect(text?.split('\n')[0]).toBe('Package server unreachable: a@1.0.0, b@1.0.0, c@1.0.0 (+2 more)');
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
    expect(
      describePackageFailures([{ url: `${CDN}/x@4.0.0`, kind: 'http', status: 403 }]),
    ).toBe('Package server error (HTTP 403) for x@4.0.0');
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
  });
});

describe('errorDetail', () => {
  it('keeps the first line, trimmed and capped', () => {
    expect(errorDetail('  pkg-cdn: denied\nmore')).toBe('pkg-cdn: denied');
    expect(errorDetail('x'.repeat(300), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(errorDetail('')).toBe('');
  });
});
