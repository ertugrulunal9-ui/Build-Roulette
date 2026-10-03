/**
 * Workspace path rules. Paths are relative, `/`-separated and normalized (`src/App.tsx`):
 * no leading `/` or `./`, no `.`/`..` segments, no empty segments.
 *
 * Unlike the bundler's lenient `normalizePath` (which collapses `..`), user-entered paths
 * that try to escape the workspace or are absolute are rejected, not silently fixed.
 */

export const MAX_PATH_LENGTH = 200;
export const MAX_SEGMENT_LENGTH = 100;
export const MAX_PATH_DEPTH = 10;

export type PathErrorReason =
  | 'empty'
  | 'absolute'
  | 'parent-segment'
  | 'trailing-slash'
  | 'invalid-character'
  | 'invalid-segment'
  | 'too-long'
  | 'too-deep';

export type PathResult = { ok: true; path: string } | { ok: false; reason: PathErrorReason };

const PATH_ERROR_TEXT: Record<PathErrorReason, string> = {
  empty: 'The path is empty.',
  absolute: 'Absolute paths are not allowed; use a path relative to the workspace (src/App.tsx).',
  'parent-segment': 'Paths cannot contain "..".',
  'trailing-slash': 'The path names a folder, not a file.',
  'invalid-character': 'The path contains a character that is not allowed (control, <>:"|?*).',
  'invalid-segment': 'A path segment cannot start or end with a space.',
  'too-long': `Paths are limited to ${MAX_PATH_LENGTH} characters (${MAX_SEGMENT_LENGTH} per segment).`,
  'too-deep': `Paths are limited to ${MAX_PATH_DEPTH} levels.`,
};

export function describePathError(reason: PathErrorReason): string {
  return PATH_ERROR_TEXT[reason];
}

// Control characters plus characters that are invalid in Windows file names (a shipped
// source.json may be downloaded and unpacked anywhere).
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const INVALID_CHARS = /[\u0000-\u001f\u007f<>:"|?*]/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Validates and normalizes a user-supplied workspace path. Pure. */
export function normalizeWorkspacePath(raw: string): PathResult {
  let p = raw.trim().replace(/\\/g, '/');
  if (p === '') return { ok: false, reason: 'empty' };
  if (p.startsWith('/') || p.startsWith('~') || URL_SCHEME.test(p)) {
    // `C:/x`, `file:///x`, `https://...` all count as absolute.
    return { ok: false, reason: 'absolute' };
  }
  if (p.endsWith('/')) return { ok: false, reason: 'trailing-slash' };
  if (INVALID_CHARS.test(p)) return { ok: false, reason: 'invalid-character' };
  const segments: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return { ok: false, reason: 'parent-segment' };
    if (seg.trim() !== seg) return { ok: false, reason: 'invalid-segment' };
    if (seg.length > MAX_SEGMENT_LENGTH) return { ok: false, reason: 'too-long' };
    segments.push(seg);
  }
  if (segments.length === 0) return { ok: false, reason: 'empty' };
  if (segments.length > MAX_PATH_DEPTH) return { ok: false, reason: 'too-deep' };
  p = segments.join('/');
  if (p.length > MAX_PATH_LENGTH) return { ok: false, reason: 'too-long' };
  return { ok: true, path: p };
}

/** Lower-cased extension including the dot (`.tsx`), or '' when there is none. */
export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}
