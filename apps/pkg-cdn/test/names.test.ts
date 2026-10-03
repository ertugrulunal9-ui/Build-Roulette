import { describe, expect, it } from 'vitest';
import {
  encodeNameForPath,
  isNodeBuiltin,
  isValidPackageName,
  packageNameOf,
  registryPathFor,
  splitSpecifier,
  validatePackageName,
} from '../src/names';

describe('validatePackageName', () => {
  it('accepts npm names', () => {
    for (const n of [
      'react',
      'react-dom',
      'lodash.debounce',
      'chart.js',
      '@react-three/fiber',
      '@a/b',
      'a_b',
      '7zip',
      '-x',
    ]) {
      expect(validatePackageName(n), n).toBeNull();
    }
  });

  it('rejects names that are not npm names or not filesystem-safe', () => {
    const bad = [
      '',
      '.hidden',
      '_private',
      ' react',
      'React',
      'a/b',
      '@scope',
      '@scope/',
      '@/x',
      '@scope/a/b',
      '..',
      '../etc',
      'a\\b',
      'a b',
      'a%2fb',
      "a'b",
      'a!b',
      'a\0b',
      'node_modules',
      'favicon.ico',
      'x'.repeat(215),
    ];
    for (const n of bad) expect(validatePackageName(n), JSON.stringify(n)).not.toBeNull();
  });

  it('allows legacy uppercase names only in legacy mode', () => {
    expect(isValidPackageName('JSONStream')).toBe(false);
    expect(isValidPackageName('JSONStream', { legacy: true })).toBe(true);
    expect(isValidPackageName('../x', { legacy: true })).toBe(false);
    expect(isValidPackageName("a'b", { legacy: true })).toBe(false);
  });
});

describe('specifier helpers', () => {
  it('splits specifiers into name and subpath', () => {
    expect(packageNameOf('@a/b/c/d')).toBe('@a/b');
    expect(packageNameOf('three/examples/jsm/x.js')).toBe('three');
    expect(splitSpecifier('react-dom/client')).toEqual({ name: 'react-dom', subpath: '/client' });
    expect(splitSpecifier('react')).toEqual({ name: 'react', subpath: '' });
  });

  it('encodes names for paths and registry URLs', () => {
    expect(encodeNameForPath('@react-three/fiber')).toBe('@react-three+fiber');
    expect(encodeNameForPath('react')).toBe('react');
    expect(registryPathFor('@react-three/fiber')).toBe('@react-three%2Ffiber');
    expect(registryPathFor('react')).toBe('react');
  });

  it('knows Node built-ins', () => {
    expect(isNodeBuiltin('fs')).toBe(true);
    expect(isNodeBuiltin('node:path')).toBe(true);
    expect(isNodeBuiltin('fs/promises')).toBe(true);
    expect(isNodeBuiltin('react')).toBe(false);
  });
});
