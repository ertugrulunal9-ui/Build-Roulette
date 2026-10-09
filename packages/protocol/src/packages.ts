/**
 * Package CDN failure texts (T-032), shared by the sandbox shell (a module that could not
 * load) and the bundler (package CSS that could not be fetched), so a player sees the same
 * words in the preview and in the Problems panel.
 */

/** How one package URL failed: no answer at all, an answer too late, or an HTTP error. */
export type PackageFailure =
  | { url: string; kind: 'unreachable' }
  | { url: string; kind: 'timeout' }
  | { url: string; kind: 'http'; status: number; detail?: string };

/** Most package names listed in one message; the rest are counted. */
export const PACKAGE_LABELS_MAX = 3;

/**
 * `zustand@5.0.15`, `react-dom@19.3.0/client`, `three@0.186.1/examples/jsm/x.js`: the path of
 * a package CDN URL (esm.sh shape), without the query. Falls back to the URL itself.
 */
export function packageLabel(url: string): string {
  try {
    const path = new URL(url).pathname.replace(/^\/+/, '');
    const label = decodeURIComponent(path);
    return label === '' ? url : label;
  } catch {
    return url;
  }
}

function labels(urls: readonly string[]): string {
  const names = [...new Set(urls.map(packageLabel))];
  const shown = names.slice(0, PACKAGE_LABELS_MAX).join(', ');
  const more = names.length - PACKAGE_LABELS_MAX;
  return more > 0 ? `${shown} (+${String(more)} more)` : shown;
}

/**
 * The text for packages that could not load, worst first: no answer (`unreachable`), then
 * no answer in time (`timeout`), then HTTP errors. Null when there is nothing to report.
 */
export function describePackageFailures(failures: readonly PackageFailure[]): string | null {
  const unreachable = failures.filter((f) => f.kind === 'unreachable').map((f) => f.url);
  const timeout = failures.filter((f) => f.kind === 'timeout').map((f) => f.url);
  const http = failures.filter(
    (f): f is Extract<PackageFailure, { kind: 'http' }> => f.kind === 'http',
  );
  const lines: string[] = [];
  if (unreachable.length > 0) lines.push(`Package server unreachable: ${labels(unreachable)}`);
  if (timeout.length > 0) lines.push(`Package server not responding: ${labels(timeout)}`);
  for (const f of http.slice(0, PACKAGE_LABELS_MAX)) {
    lines.push(
      `Package server error (HTTP ${String(f.status)}) for ${packageLabel(f.url)}${f.detail ? `: ${f.detail}` : ''}`,
    );
  }
  if (http.length > PACKAGE_LABELS_MAX) {
    lines.push(`(+${String(http.length - PACKAGE_LABELS_MAX)} more package errors)`);
  }
  if (lines.length === 0) return null;
  if (unreachable.length > 0 || timeout.length > 0) {
    lines.push(
      'Packages this browser loaded before keep working; a new one needs the package server.',
    );
  }
  return lines.join('\n');
}

/** How a "still waiting" note (`describePackageStall`) starts. */
export const PACKAGE_STALL_PREFIX = 'Still waiting for the package server';

/**
 * The text for a module graph that is still waiting for packages after `waitedMs`: the
 * package server neither answered nor failed for `urls` yet. It may still answer (a package
 * nobody asked for before can take a while to build), so this is not an error yet.
 */
export function describePackageStall(urls: readonly string[], waitedMs: number): string | null {
  if (urls.length === 0) return null;
  return `${PACKAGE_STALL_PREFIX} after ${String(Math.round(waitedMs / 1000))} s: ${labels(urls)}\nThe preview starts as soon as it answers.`;
}

/**
 * True for a `module-load` message that says the build is still waiting for packages rather
 * than that it failed (display only: the message comes from the sandbox).
 */
export function isPackageStall(message: string): boolean {
  return message.startsWith(PACKAGE_STALL_PREFIX);
}

/**
 * The CDN's own error text from an error body: its first line, trimmed and capped. Comment
 * lines are skipped, and a module that only throws (esm.sh answers a failed build with
 * `/* esm.sh - error *\/` + `throw new Error("[esm.sh] …")` and a 500) gives its message.
 */
export function errorDetail(body: string, max = 200): string {
  const lines = body
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !/^\/\*.*\*\/$/.test(l) && !l.startsWith('//'));
  let line = lines[0] ?? '';
  const thrown = /^throw\s+new\s+Error\(\s*("(?:[^"\\]|\\.)*")\s*\)\s*;?$/.exec(line);
  if (thrown?.[1] !== undefined) {
    try {
      const message: unknown = JSON.parse(thrown[1]);
      if (typeof message === 'string') line = message.trim();
    } catch {
      // Not a JSON string: keep the line as it is.
    }
  }
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Whitespace, block comments and line comments between a module's leading statements. */
const SKIP_RE = /(?:\s+|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*/y;
/** `"use strict";` and other directives (string-only statements) at the very top. */
const DIRECTIVE_RE = /(["'])[\w -]*\1\s*;?/y;
/**
 * One static import or re-export with a module specifier: `import x from "a"`, `import "a"`,
 * `import*as x from"a"`, `export * from "a"`, `export{default}from"a"`. The clause before
 * `from` never holds quotes, parentheses, `=` or `;`, so the match cannot run into code.
 */
const STATIC_IMPORT_RE = /(?:import|export)\s*(?:[^"'`;()=]*?\bfrom\s*)?(["'])([^"'\r\n]+)\1\s*;?/y;

/**
 * The specifiers of a module's leading static imports and re-exports, up to the first other
 * statement (at most `max`). Bundlers (esbuild, so @br/pkg-cdn and esm.sh) put every static
 * import at the top of their output, so this finds a CDN module's dependencies without a
 * parser, and text further down (strings, comments, code) is never taken for an import.
 * Dynamic `import()` is not followed: those modules load later, if at all.
 */
export function leadingImports(source: string, max = 64): string[] {
  const out: string[] = [];
  let pos = 0;
  const skip = () => {
    SKIP_RE.lastIndex = pos;
    if (SKIP_RE.exec(source)) pos = SKIP_RE.lastIndex;
  };
  skip();
  for (;;) {
    DIRECTIVE_RE.lastIndex = pos;
    if (!DIRECTIVE_RE.exec(source)) break;
    pos = DIRECTIVE_RE.lastIndex;
    skip();
  }
  while (out.length < max) {
    STATIC_IMPORT_RE.lastIndex = pos;
    const m = STATIC_IMPORT_RE.exec(source);
    if (!m?.[2]) break;
    out.push(m[2]);
    pos = STATIC_IMPORT_RE.lastIndex;
    skip();
  }
  return out;
}

/**
 * The modules a CDN module loads from its own origin: its leading imports that are URLs or
 * paths (`/react@19.3.0/es2022/react.mjs`, `./x.mjs`, `https://same.origin/…`), resolved
 * against `moduleUrl`. Bare specifiers (`react`) are the import map's; another origin is
 * not the CDN's. esm.sh answers an entry URL with a few lines that re-export such internal
 * build paths; @br/pkg-cdn's peer URLs (`/three@0.186.1?external=…`) are found the same way.
 */
export function moduleImportUrls(source: string, moduleUrl: string, max = 64): string[] {
  let base: URL;
  try {
    base = new URL(moduleUrl);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const spec of leadingImports(source, max)) {
    if (!/^(?:\/|\.\.?\/|https?:\/\/)/i.test(spec)) continue;
    let url: URL;
    try {
      url = new URL(spec, base);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;
    url.hash = '';
    out.add(url.href);
  }
  return [...out];
}
