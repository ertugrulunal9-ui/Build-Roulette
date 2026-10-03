import { describe, expect, it } from 'vitest';
import {
  createFile,
  deleteFile,
  guessEntry,
  importFiles,
  renameFile,
  writeFile,
} from './operations';
import { createWorkspace } from './templates';
import type { Workspace } from './types';
import type { WorkspaceResult } from './limits';

function ok(r: WorkspaceResult): Workspace {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r.workspace;
}

describe('workspace operations', () => {
  it('writeFile normalizes the path and never mutates the input', () => {
    const ws = createWorkspace();
    const before = structuredClone(ws);
    const next = ok(writeFile(ws, './src/util.ts', 'export const x = 1;\n'));
    expect(next.files['src/util.ts']).toBe('export const x = 1;\n');
    expect(ws).toEqual(before);
  });

  it('writeFile enforces per-file, count and total limits', () => {
    const ws = createWorkspace();
    expect(writeFile(ws, 'src/big.ts', 'x'.repeat(256 * 1024 + 1))).toMatchObject({
      ok: false,
      errors: [{ code: 'file-too-large' }],
    });
    let full = ws;
    for (let i = Object.keys(ws.files).length; i < 50; i++) {
      full = ok(writeFile(full, `src/f${i}.ts`, ''));
    }
    expect(writeFile(full, 'src/one-more.ts', '')).toEqual({
      ok: false,
      errors: [{ code: 'too-many-files', count: 51, max: 50 }],
    });
    // Overwriting an existing file in a full workspace is fine.
    expect(writeFile(full, 'src/App.tsx', 'export {};\n').ok).toBe(true);
  });

  it('writeFile rejects bad paths', () => {
    expect(writeFile(createWorkspace(), '../x.ts', '')).toEqual({
      ok: false,
      errors: [{ code: 'invalid-path', path: '../x.ts', reason: 'parent-segment' }],
    });
  });

  it('createFile refuses to overwrite', () => {
    expect(createFile(createWorkspace(), 'src/App.tsx')).toEqual({
      ok: false,
      errors: [{ code: 'file-exists', path: 'src/App.tsx' }],
    });
    expect(ok(createFile(createWorkspace(), 'src/new.ts')).files['src/new.ts']).toBe('');
  });

  it('renameFile moves a file, keeps order and follows the entry', () => {
    const ws = createWorkspace();
    const renamed = ok(renameFile(ws, 'src/App.tsx', 'src/components/App.tsx'));
    expect(Object.keys(renamed.files)).toEqual([
      'src/main.tsx',
      'src/components/App.tsx',
      'src/styles.css',
    ]);
    expect(renamed.manifest.entry).toBe('src/main.tsx');
    const entryMoved = ok(renameFile(ws, 'src/main.tsx', 'src/index.tsx'));
    expect(entryMoved.manifest.entry).toBe('src/index.tsx');
    expect(ws.manifest.entry).toBe('src/main.tsx');
  });

  it('renameFile reports missing sources, clashes and bad targets', () => {
    const ws = createWorkspace();
    expect(renameFile(ws, 'nope.ts', 'x.ts')).toMatchObject({
      errors: [{ code: 'file-not-found' }],
    });
    expect(renameFile(ws, 'src/App.tsx', 'src/main.tsx')).toMatchObject({
      errors: [{ code: 'file-exists', path: 'src/main.tsx' }],
    });
    expect(renameFile(ws, 'src/App.tsx', '/abs.tsx')).toMatchObject({
      errors: [{ code: 'invalid-path', reason: 'absolute' }],
    });
    expect(renameFile(ws, 'src/App.tsx', 'src/App.png')).toMatchObject({
      errors: [{ code: 'image-not-data-url' }],
    });
    expect(ok(renameFile(ws, 'src/App.tsx', './src/App.tsx'))).toBe(ws);
  });

  it('deleteFile removes files but protects the entry', () => {
    const ws = createWorkspace();
    expect(Object.keys(ok(deleteFile(ws, 'src/styles.css')).files)).toEqual([
      'src/main.tsx',
      'src/App.tsx',
    ]);
    expect(deleteFile(ws, 'src/main.tsx')).toEqual({
      ok: false,
      errors: [{ code: 'cannot-delete-entry', path: 'src/main.tsx' }],
    });
    expect(deleteFile(ws, 'x')).toMatchObject({ errors: [{ code: 'file-not-found' }] });
  });

  it('guessEntry keeps a present entry and falls back to conventional names', () => {
    expect(guessEntry({ 'src/main.tsx': '' }, 'src/main.tsx')).toBe('src/main.tsx');
    expect(guessEntry({ 'src/index.ts': '', 'main.tsx': '' }, 'src/main.tsx')).toBe('src/index.ts');
    expect(guessEntry({ 'a.ts': '' }, 'src/main.tsx')).toBeNull();
  });

  it('importFiles merges or replaces and re-targets the entry', () => {
    const ws = createWorkspace();
    const merged = ok(importFiles(ws, { 'src/App.tsx': 'new', 'src/x.ts': 'x' }, 'merge'));
    expect(merged.files['src/App.tsx']).toBe('new');
    expect(merged.files['src/styles.css']).toBe(ws.files['src/styles.css']);

    const replaced = ok(importFiles(ws, { 'src/index.tsx': 'i', 'src/App.tsx': 'a' }, 'replace'));
    expect(Object.keys(replaced.files)).toEqual(['src/index.tsx', 'src/App.tsx']);
    expect(replaced.manifest.entry).toBe('src/index.tsx');

    expect(importFiles(ws, { 'src/App.tsx': 'a' }, 'replace')).toEqual({
      ok: false,
      errors: [{ code: 'entry-missing', entry: 'src/main.tsx' }],
    });
  });

  it('importFiles enforces limits on the result', () => {
    const ws = createWorkspace();
    const many: Record<string, string> = {};
    for (let i = 0; i < 48; i++) many[`src/f${i}.ts`] = '';
    expect(importFiles(ws, many, 'merge')).toMatchObject({
      ok: false,
      errors: [{ code: 'too-many-files', count: 51 }],
    });
    expect(importFiles(ws, { '../x.ts': '' }, 'merge')).toMatchObject({
      ok: false,
      errors: [{ code: 'invalid-path' }],
    });
  });
});
