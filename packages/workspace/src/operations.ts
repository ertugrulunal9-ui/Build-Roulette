/**
 * Pure workspace edits that enforce the limits. Each returns a new workspace or typed
 * errors; the input is never mutated.
 */
import {
  LIMITS,
  totalBytes,
  validateFileContents,
  type WorkspaceError,
  type WorkspaceResult,
} from './limits';
import { normalizeWorkspacePath } from './paths';
import type { FileMap, Workspace } from './types';

function has(files: FileMap, path: string): boolean {
  return Object.prototype.hasOwnProperty.call(files, path);
}

/** Count and total-size checks for a candidate file map. */
function checkTotals(files: FileMap): WorkspaceError[] {
  const errors: WorkspaceError[] = [];
  const count = Object.keys(files).length;
  if (count > LIMITS.maxFiles) {
    errors.push({ code: 'too-many-files', count, max: LIMITS.maxFiles });
  }
  const bytes = totalBytes(files);
  if (bytes > LIMITS.maxTotalBytes) {
    errors.push({ code: 'total-too-large', bytes, max: LIMITS.maxTotalBytes });
  }
  return errors;
}

function result(ws: Workspace, files: FileMap, errors: WorkspaceError[]): WorkspaceResult {
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, workspace: { files, manifest: ws.manifest } };
}

/** Creates or overwrites a file. */
export function writeFile(ws: Workspace, path: string, contents: string): WorkspaceResult {
  const n = normalizeWorkspacePath(path);
  if (!n.ok) return { ok: false, errors: [{ code: 'invalid-path', path, reason: n.reason }] };
  const fileErrors = validateFileContents(n.path, contents);
  if (fileErrors.length > 0) return { ok: false, errors: fileErrors };
  const files = { ...ws.files, [n.path]: contents };
  return result(ws, files, checkTotals(files));
}

/** Creates a new file; fails if it already exists. */
export function createFile(ws: Workspace, path: string, contents = ''): WorkspaceResult {
  const n = normalizeWorkspacePath(path);
  if (!n.ok) return { ok: false, errors: [{ code: 'invalid-path', path, reason: n.reason }] };
  if (has(ws.files, n.path)) return { ok: false, errors: [{ code: 'file-exists', path: n.path }] };
  return writeFile(ws, n.path, contents);
}

/**
 * Renames (moves) a file, keeping its position in the map. Renaming the entry file updates
 * `manifest.entry`.
 */
export function renameFile(ws: Workspace, from: string, to: string): WorkspaceResult {
  if (!has(ws.files, from)) return { ok: false, errors: [{ code: 'file-not-found', path: from }] };
  const n = normalizeWorkspacePath(to);
  if (!n.ok) return { ok: false, errors: [{ code: 'invalid-path', path: to, reason: n.reason }] };
  if (n.path === from) return { ok: true, workspace: ws };
  if (has(ws.files, n.path)) return { ok: false, errors: [{ code: 'file-exists', path: n.path }] };
  const contents = ws.files[from] ?? '';
  // An image renamed to a text extension (or the reverse) changes which limit applies.
  const fileErrors = validateFileContents(n.path, contents);
  if (fileErrors.length > 0) return { ok: false, errors: fileErrors };
  const files: FileMap = {};
  for (const [p, c] of Object.entries(ws.files)) files[p === from ? n.path : p] = c;
  const manifest = ws.manifest.entry === from ? { ...ws.manifest, entry: n.path } : ws.manifest;
  return { ok: true, workspace: { files, manifest } };
}

/** Deletes a file. The entry file cannot be deleted (rename it or change the entry first). */
export function deleteFile(ws: Workspace, path: string): WorkspaceResult {
  if (!has(ws.files, path)) return { ok: false, errors: [{ code: 'file-not-found', path }] };
  if (path === ws.manifest.entry)
    return { ok: false, errors: [{ code: 'cannot-delete-entry', path }] };
  const files: FileMap = {};
  for (const [p, c] of Object.entries(ws.files)) if (p !== path) files[p] = c;
  return { ok: true, workspace: { files, manifest: ws.manifest } };
}

/** Entry files tried, in order, when a workspace's entry is missing (e.g. after an import). */
export const ENTRY_CANDIDATES: readonly string[] = [
  'src/main.tsx',
  'src/main.ts',
  'src/index.tsx',
  'src/index.ts',
  'src/main.jsx',
  'src/main.js',
  'src/index.jsx',
  'src/index.js',
  'main.tsx',
  'main.ts',
  'index.tsx',
  'index.ts',
  'main.js',
  'index.js',
];

/** The entry to use for `files`: `current` if it exists, else the first candidate present. */
export function guessEntry(files: FileMap, current: string): string | null {
  if (has(files, current)) return current;
  return ENTRY_CANDIDATES.find((c) => has(files, c)) ?? null;
}

export type ImportMode = 'merge' | 'replace';

/**
 * Applies a set of imported files (paste-import). `merge` overwrites same-named files and
 * keeps the rest; `replace` drops every existing file. Paths must already be normalized
 * (paste-import output is). When the entry is missing afterwards, a conventional entry
 * file is picked if one exists.
 */
export function importFiles(ws: Workspace, incoming: FileMap, mode: ImportMode): WorkspaceResult {
  const errors: WorkspaceError[] = [];
  for (const [path, contents] of Object.entries(incoming)) {
    const n = normalizeWorkspacePath(path);
    if (!n.ok) errors.push({ code: 'invalid-path', path, reason: n.reason });
    else if (n.path !== path)
      errors.push({ code: 'path-not-normalized', path, normalized: n.path });
    else errors.push(...validateFileContents(path, contents));
  }
  const files: FileMap = mode === 'replace' ? { ...incoming } : { ...ws.files, ...incoming };
  errors.push(...checkTotals(files));
  const entry = guessEntry(files, ws.manifest.entry);
  if (entry === null) errors.push({ code: 'entry-missing', entry: ws.manifest.entry });
  if (errors.length > 0 || entry === null) return { ok: false, errors };
  const manifest = entry === ws.manifest.entry ? ws.manifest : { ...ws.manifest, entry };
  return { ok: true, workspace: { files, manifest } };
}
