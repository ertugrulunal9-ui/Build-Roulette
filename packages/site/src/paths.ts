import { SITE_LIMITS } from './limits';

/**
 * A path inside a site: relative, `/`-separated, no empty, `.` or `..` segment, no
 * backslash, no control character, at most `SITE_LIMITS.maxPathChars` characters.
 * (`index.html`, `assets/index-abc.js`.)
 */
export function isValidSitePath(path: string): boolean {
  if (path.length === 0 || path.length > SITE_LIMITS.maxPathChars) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/**
 * Normalizes a path as a browser or a zip reports it (`dist\\index.html`, `/my-app/x`,
 * `./a/b`): backslashes become `/`, leading `/` and `./` go. Returns null when the result is
 * not a valid relative path (`..`, empty segments, control characters).
 */
export function normalizeInputPath(raw: string): string | null {
  let p = raw.replace(/\\/g, '/');
  while (p.startsWith('/') || p.startsWith('./')) p = p.startsWith('/') ? p.slice(1) : p.slice(2);
  if (p.length === 0) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return null;
  const segments = p.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return p;
}

/** The folder of a path, with a trailing `/` (`''` for a top-level file). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i + 1);
}

/** The last segment of a path. */
export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
