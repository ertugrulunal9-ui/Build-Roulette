import { describe, expect, it } from 'vitest';
import {
  LIMITS,
  describeWorkspaceError,
  imageByteSize,
  totalBytes,
  validateFileContents,
  validateFiles,
  validateWorkspace,
  type WorkspaceError,
} from './limits';
import { normalizeWorkspacePath } from './paths';
import { createWorkspace } from './templates';
import type { FileMap } from './types';

const KB = 1024;

function dataUrl(bytes: number, mime = 'image/png'): string {
  return `data:${mime};base64,${Buffer.alloc(bytes, 7).toString('base64')}`;
}

describe('normalizeWorkspacePath', () => {
  it.each([
    ['src/App.tsx', 'src/App.tsx'],
    ['./src/App.tsx', 'src/App.tsx'],
    ['  src/App.tsx  ', 'src/App.tsx'],
    ['src\\components\\Card.tsx', 'src/components/Card.tsx'],
    ['src//./App.tsx', 'src/App.tsx'],
    ['.prettierrc', '.prettierrc'],
    ['src/My Component.tsx', 'src/My Component.tsx'],
  ])('accepts %j as %j', (raw, expected) => {
    expect(normalizeWorkspacePath(raw)).toEqual({ ok: true, path: expected });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['./', 'trailing-slash'],
    ['.', 'empty'],
    ['/src/App.tsx', 'absolute'],
    ['\\\\server\\share\\a.ts', 'absolute'],
    ['C:\\Users\\me\\App.tsx', 'absolute'],
    ['C:/x.ts', 'absolute'],
    ['~/App.tsx', 'absolute'],
    ['https://example.com/a.ts', 'absolute'],
    ['file:///etc/passwd', 'absolute'],
    ['../secret.ts', 'parent-segment'],
    ['src/../../x.ts', 'parent-segment'],
    ['src/', 'trailing-slash'],
    ['src/a\u0000.ts', 'invalid-character'],
    ['src/a?.ts', 'invalid-character'],
    ['src/ a.ts', 'invalid-segment'],
    [`src/${'a'.repeat(101)}.ts`, 'too-long'],
    [`${'abcdefghi/'.repeat(20)}x.ts`, 'too-deep'],
    [`${'abcdefghijklmnopqrst/'.repeat(9)}${'x'.repeat(30)}.ts`, 'too-long'],
  ])('rejects %j (%s)', (raw, reason) => {
    expect(normalizeWorkspacePath(raw)).toEqual({ ok: false, reason });
  });
});

describe('file limits', () => {
  it('limits match docs/03 §3.3', () => {
    expect(LIMITS).toEqual({
      maxFiles: 50,
      maxTotalBytes: 1024 * KB,
      maxTextFileBytes: 256 * KB,
      maxImageBytes: 200 * KB,
    });
  });

  it('accepts a text file at exactly 256 KB and rejects one byte more', () => {
    expect(validateFileContents('src/a.ts', 'x'.repeat(256 * KB))).toEqual([]);
    expect(validateFileContents('src/a.ts', 'x'.repeat(256 * KB + 1))).toEqual([
      { code: 'file-too-large', path: 'src/a.ts', bytes: 256 * KB + 1, max: 256 * KB },
    ]);
  });

  it('measures text in UTF-8 bytes, not characters', () => {
    const emoji = '😀'.repeat(64 * KB + 1); // 4 bytes each
    const errors = validateFileContents('src/a.ts', emoji);
    expect(errors[0]?.code).toBe('file-too-large');
  });

  it('rejects NUL bytes in text files', () => {
    expect(validateFileContents('src/a.ts', 'a\u0000b')).toEqual([
      { code: 'binary-content', path: 'src/a.ts' },
    ]);
  });

  it('accepts images up to 200 KB decoded and rejects bigger ones', () => {
    expect(validateFileContents('src/logo.png', dataUrl(200 * KB))).toEqual([]);
    expect(validateFileContents('src/logo.png', dataUrl(200 * KB + 1))).toEqual([
      { code: 'image-too-large', path: 'src/logo.png', bytes: 200 * KB + 1, max: 200 * KB },
    ]);
  });

  it('requires binary images to be data URLs, allows raw SVG markup', () => {
    expect(validateFileContents('a.png', '\x89PNG...')).toEqual([
      { code: 'image-not-data-url', path: 'a.png' },
    ]);
    expect(validateFileContents('a.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>')).toEqual([]);
    expect(validateFileContents('a.svg', `<svg>${'x'.repeat(200 * KB)}</svg>`)[0]?.code).toBe(
      'image-too-large',
    );
  });

  it('computes decoded image sizes for base64 and percent-encoded data URLs', () => {
    expect(imageByteSize('a.png', dataUrl(10))).toBe(10);
    expect(imageByteSize('a.png', dataUrl(11))).toBe(11);
    expect(imageByteSize('a.png', dataUrl(12))).toBe(12);
    expect(imageByteSize('a.svg', 'data:image/svg+xml,%3Csvg%2F%3E')).toBe('<svg/>'.length);
    expect(imageByteSize('a.png', 'not a data url')).toBeNull();
  });
});

describe('validateFiles / validateWorkspace', () => {
  it('accepts every template', () => {
    expect(validateWorkspace(createWorkspace('react-ts'))).toEqual([]);
    expect(validateWorkspace(createWorkspace('vanilla-ts'))).toEqual([]);
  });

  it('allows 50 files and rejects 51', () => {
    const files: FileMap = {};
    for (let i = 0; i < 50; i++) files[`src/f${i}.ts`] = 'export {};\n';
    expect(validateFiles(files)).toEqual([]);
    files['src/f50.ts'] = '';
    expect(validateFiles(files)).toEqual([{ code: 'too-many-files', count: 51, max: 50 }]);
  });

  it('rejects more than 1 MB in total', () => {
    const files: FileMap = {};
    for (let i = 0; i < 4; i++) files[`src/f${i}.ts`] = 'x'.repeat(256 * KB);
    expect(totalBytes(files)).toBe(1024 * KB);
    expect(validateFiles(files)).toEqual([]);
    files['src/extra.ts'] = 'y';
    expect(validateFiles(files)).toEqual([
      { code: 'total-too-large', bytes: 1024 * KB + 1, max: 1024 * KB },
    ]);
  });

  it('reports bad and non-normalized stored paths', () => {
    expect(validateFiles({ '../x.ts': '', './src/a.ts': '' })).toEqual([
      { code: 'invalid-path', path: '../x.ts', reason: 'parent-segment' },
      { code: 'path-not-normalized', path: './src/a.ts', normalized: 'src/a.ts' },
    ]);
  });

  it('reports a missing entry file', () => {
    const ws = createWorkspace();
    ws.manifest.entry = 'src/nope.tsx';
    expect(validateWorkspace(ws)).toEqual([{ code: 'entry-missing', entry: 'src/nope.tsx' }]);
  });

  it('has a description for every error code', () => {
    const errors: WorkspaceError[] = [
      { code: 'invalid-path', path: '/a', reason: 'absolute' },
      { code: 'path-not-normalized', path: './a', normalized: 'a' },
      { code: 'too-many-files', count: 51, max: 50 },
      { code: 'file-too-large', path: 'a', bytes: 300 * KB, max: 256 * KB },
      { code: 'image-too-large', path: 'a.png', bytes: 300 * KB, max: 200 * KB },
      { code: 'image-not-data-url', path: 'a.png' },
      { code: 'binary-content', path: 'a' },
      { code: 'total-too-large', bytes: 2000 * KB, max: 1024 * KB },
      { code: 'file-exists', path: 'a' },
      { code: 'file-not-found', path: 'a' },
      { code: 'entry-missing', entry: 'a' },
      { code: 'cannot-delete-entry', path: 'a' },
    ];
    for (const e of errors) expect(describeWorkspaceError(e)).toMatch(/\S/);
    expect(
      describeWorkspaceError({ code: 'file-too-large', path: 'a', bytes: 300 * KB, max: 256 * KB }),
    ).toBe('"a" is 300 KB; text files are limited to 256 KB.');
  });
});
