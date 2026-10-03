/**
 * npm package name validation. Names are checked before they are used in a registry URL or a
 * filesystem path, so the rules are deliberately stricter than "whatever the registry has":
 *
 * - Follows the npm naming rules (validate-npm-package-name): at most 214 characters, no
 *   leading `.` or `_`, URL-safe, `@scope/name` for scoped packages, not `node_modules` or
 *   `favicon.ico`.
 * - New-style names (what a user can request) are lowercase `[a-z0-9._-]`.
 * - Legacy names (allowed for transitive dependencies only) may also contain uppercase
 *   letters and `~`, which a few old packages have (e.g. `JSONStream`). The punctuation that
 *   legacy names could contain (`'!()*`) is rejected.
 *
 * A valid name never contains `/` other than the scope separator, `\`, `..` or a NUL byte,
 * so it is safe to join into a cache path.
 */

const MAX_NAME_LENGTH = 214;
const NEW_PART = /^[a-z0-9-][a-z0-9._-]*$/;
const LEGACY_PART = /^[A-Za-z0-9~-][A-Za-z0-9._~-]*$/;
const BLOCKED = new Set(['node_modules', 'favicon.ico']);

export interface NameOptions {
  /** Allow legacy names (uppercase, `~`). Use for dependencies, not for user requests. */
  legacy?: boolean;
}

/** Returns null when `name` is valid, otherwise the reason it is not. */
export function validatePackageName(name: string, opts: NameOptions = {}): string | null {
  if (name.length === 0) return 'package name is empty';
  if (name.length > MAX_NAME_LENGTH) return `package name is longer than ${MAX_NAME_LENGTH}`;
  if (name.trim() !== name) return 'package name has leading or trailing whitespace';
  const part = opts.legacy ? LEGACY_PART : NEW_PART;
  let scope: string | null = null;
  let local = name;
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    if (slash === -1) return 'scoped package name must look like @scope/name';
    scope = name.slice(1, slash);
    local = name.slice(slash + 1);
    if (!part.test(scope)) return `invalid scope "${scope}"`;
  }
  if (local.includes('/')) return 'package name contains "/"';
  if (!part.test(local)) {
    if (!opts.legacy && /[A-Z]/.test(local)) return 'package name must be lowercase';
    return `package name "${name}" contains characters npm does not allow`;
  }
  if (scope === null && BLOCKED.has(local.toLowerCase())) return `"${name}" is a reserved name`;
  return null;
}

export function isValidPackageName(name: string, opts: NameOptions = {}): boolean {
  return validatePackageName(name, opts) === null;
}

/** Package name of a bare specifier (`@a/b/c` -> `@a/b`, `x/y` -> `x`). */
export function packageNameOf(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
}

/** Splits a bare specifier into package name and subpath (`''` or `/sub/path`). */
export function splitSpecifier(spec: string): { name: string; subpath: string } {
  const name = packageNameOf(spec);
  return { name, subpath: spec.slice(name.length) };
}

/** Filesystem-safe single directory name for a (validated) package name: `@a/b` -> `@a+b`. */
export function encodeNameForPath(name: string): string {
  return name.replace('/', '+');
}

/** Path segment of a registry packument URL: scoped names keep `@` and encode the `/`. */
export function registryPathFor(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

const NODE_BUILTINS = new Set(
  'assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib'.split(
    ' ',
  ),
);

/** `fs`, `node:fs`, `fs/promises`, ... */
export function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  return NODE_BUILTINS.has(spec.split('/')[0] ?? spec);
}
