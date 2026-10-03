/**
 * Workspace limits (docs/03 §3.3) and validation with typed errors.
 *
 * - at most 50 files;
 * - at most 1 MB in total, counted as the UTF-8 size of everything that is stored
 *   (images count with their stored `data:` URL), because that is what IndexedDB, autosave
 *   and `source.json` hold;
 * - at most 256 KB per text file;
 * - images (`.png .jpg .jpeg .gif .webp .avif .ico .bmp`, and `.svg`) at most 200 KB each,
 *   measured as decoded bytes (the same rule the bundler's `assets` plugin applies).
 *   Binary images must be stored as `data:` URLs; SVG may also be raw markup.
 */
import { extname, normalizeWorkspacePath, type PathErrorReason, describePathError } from './paths';
import type { FileMap, Workspace } from './types';

export const LIMITS = {
  maxFiles: 50,
  maxTotalBytes: 1024 * 1024,
  maxTextFileBytes: 256 * 1024,
  maxImageBytes: 200 * 1024,
} as const;

export const BINARY_IMAGE_EXTENSIONS: readonly string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.bmp',
];

export type WorkspaceError =
  | { code: 'invalid-path'; path: string; reason: PathErrorReason }
  | { code: 'path-not-normalized'; path: string; normalized: string }
  | { code: 'too-many-files'; count: number; max: number }
  | { code: 'file-too-large'; path: string; bytes: number; max: number }
  | { code: 'image-too-large'; path: string; bytes: number; max: number }
  | { code: 'image-not-data-url'; path: string }
  | { code: 'binary-content'; path: string }
  | { code: 'total-too-large'; bytes: number; max: number }
  | { code: 'file-exists'; path: string }
  | { code: 'file-not-found'; path: string }
  | { code: 'entry-missing'; entry: string }
  | { code: 'cannot-delete-entry'; path: string };

export type WorkspaceResult =
  { ok: true; workspace: Workspace } | { ok: false; errors: WorkspaceError[] };

function kb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

/** Human-readable text for an error (UI). */
export function describeWorkspaceError(e: WorkspaceError): string {
  switch (e.code) {
    case 'invalid-path':
      return `"${e.path}": ${describePathError(e.reason)}`;
    case 'path-not-normalized':
      return `"${e.path}" should be written as "${e.normalized}".`;
    case 'too-many-files':
      return `Too many files: ${e.count} (the limit is ${e.max}).`;
    case 'file-too-large':
      return `"${e.path}" is ${kb(e.bytes)}; text files are limited to ${kb(e.max)}.`;
    case 'image-too-large':
      return `Image "${e.path}" is ${kb(e.bytes)}; images are limited to ${kb(e.max)}.`;
    case 'image-not-data-url':
      return `Image "${e.path}" must be stored as a data: URL.`;
    case 'binary-content':
      return `"${e.path}" looks like a binary file; only text files and images are supported.`;
    case 'total-too-large':
      return `The workspace would be ${kb(e.bytes)}; the limit is ${kb(e.max)} in total.`;
    case 'file-exists':
      return `"${e.path}" already exists.`;
    case 'file-not-found':
      return `"${e.path}" does not exist.`;
    case 'entry-missing':
      return `The entry file "${e.entry}" is missing.`;
    case 'cannot-delete-entry':
      return `"${e.path}" is the entry file and cannot be deleted.`;
  }
}

const encoder = new TextEncoder();

/** UTF-8 size of a string. */
export function byteLength(s: string): number {
  return encoder.encode(s).byteLength;
}

export function isImagePath(path: string): boolean {
  const ext = extname(path);
  return ext === '.svg' || BINARY_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Decoded size of an image file's contents, or null when a binary image is not a `data:`
 * URL. Raw SVG markup counts with its UTF-8 size.
 */
export function imageByteSize(path: string, contents: string): number | null {
  const m = /^data:([^,]*),/.exec(contents);
  if (!m) return extname(path) === '.svg' ? byteLength(contents) : null;
  const payload = contents.slice(m[0].length);
  if ((m[1] ?? '').split(';').includes('base64')) {
    const clean = payload.replace(/\s/g, '');
    const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  }
  try {
    return byteLength(decodeURIComponent(payload));
  } catch {
    return byteLength(payload);
  }
}

/** Errors for one file's contents (size, type). The path must already be normalized. */
export function validateFileContents(path: string, contents: string): WorkspaceError[] {
  if (isImagePath(path)) {
    const size = imageByteSize(path, contents);
    if (size === null) return [{ code: 'image-not-data-url', path }];
    if (size > LIMITS.maxImageBytes) {
      return [{ code: 'image-too-large', path, bytes: size, max: LIMITS.maxImageBytes }];
    }
    return [];
  }
  if (contents.includes('\u0000')) return [{ code: 'binary-content', path }];
  const bytes = byteLength(contents);
  if (bytes > LIMITS.maxTextFileBytes) {
    return [{ code: 'file-too-large', path, bytes, max: LIMITS.maxTextFileBytes }];
  }
  return [];
}

/** Total stored size of a file map's contents in bytes (UTF-8). */
export function totalBytes(files: FileMap): number {
  let total = 0;
  for (const contents of Object.values(files)) total += byteLength(contents);
  return total;
}

export interface WorkspaceUsage {
  files: number;
  bytes: number;
}

export function workspaceUsage(files: FileMap): WorkspaceUsage {
  return { files: Object.keys(files).length, bytes: totalBytes(files) };
}

/** Validates a whole file map: paths, per-file limits, count and total size. */
export function validateFiles(files: FileMap): WorkspaceError[] {
  const errors: WorkspaceError[] = [];
  const entries = Object.entries(files);
  for (const [path, contents] of entries) {
    const n = normalizeWorkspacePath(path);
    if (!n.ok) {
      errors.push({ code: 'invalid-path', path, reason: n.reason });
      continue;
    }
    if (n.path !== path) {
      errors.push({ code: 'path-not-normalized', path, normalized: n.path });
      continue;
    }
    errors.push(...validateFileContents(path, contents));
  }
  if (entries.length > LIMITS.maxFiles) {
    errors.push({ code: 'too-many-files', count: entries.length, max: LIMITS.maxFiles });
  }
  const bytes = totalBytes(files);
  if (bytes > LIMITS.maxTotalBytes) {
    errors.push({ code: 'total-too-large', bytes, max: LIMITS.maxTotalBytes });
  }
  return errors;
}

/** Validates files plus the manifest's entry. */
export function validateWorkspace(ws: Workspace): WorkspaceError[] {
  const errors = validateFiles(ws.files);
  if (!Object.prototype.hasOwnProperty.call(ws.files, ws.manifest.entry)) {
    errors.push({ code: 'entry-missing', entry: ws.manifest.entry });
  }
  return errors;
}
