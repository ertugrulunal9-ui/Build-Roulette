/**
 * `detectBareImports`: which npm packages does the code use? Feeds the "Add `zustand`?"
 * chip (docs/03 §3.3). No version resolution happens here.
 *
 * This is a lightweight scanner, not a parser: comments are skipped and string literals are
 * tracked, so `// import x from 'y'` and `"import x from 'y'"` are not counted. Regex
 * literals that contain `//` or quotes can still confuse it; the bundler remains the source
 * of truth (it reports undeclared packages as diagnostics).
 */
import { extname } from './paths';
import type { FileMap } from './types';

export interface BareImport {
  /** Package name: `pkg` or `@scope/pkg`. Node built-ins drop the `node:` prefix. */
  name: string;
  /** Distinct specifiers as written (`pkg`, `pkg/sub/path`), sorted. */
  specifiers: string[];
  /** Files that import it, sorted. */
  files: string[];
  /** Node built-in (`fs`, `node:path`): never available in the browser sandbox. */
  builtin: boolean;
}

const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

const NODE_BUILTINS = new Set(
  'assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib'.split(
    ' ',
  ),
);

/**
 * Replaces comments with whitespace and string literals with `"\0<n>"` placeholders, so the
 * import regexes only see code. Returns the masked code and the literal values.
 */
function maskSource(src: string): { code: string; strings: string[] } {
  const strings: string[] = [];
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') {
          value += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (c !== '`' && src[j] === '\n') break; // unterminated string
        value += src.charAt(j);
        j++;
      }
      if (c === '`')
        out += '`\u0000`'; // template literals never count as specifiers
      else {
        out += `${c}\u0000${String(strings.length)}${c}`;
        strings.push(value);
      }
      i = j + 1;
      continue;
    }
    out += src.charAt(i);
    i++;
  }
  return { code: out, strings };
}

const S = `(['"])\\u0000(\\d+)\\1`;
const IMPORT_PATTERNS = [
  // import x from 'y' / import { a } from 'y' / export * from 'y' / export { a } from 'y'
  // (not `import type` / `export type`, which esbuild erases)
  new RegExp(`\\b(?:import|export)\\s+(?!type\\s)[^;'"\`]*?\\bfrom\\s*${S}`, 'g'),
  // import 'y'
  new RegExp(`\\bimport\\s*${S}`, 'g'),
  // import('y')
  new RegExp(`\\bimport\\s*\\(\\s*${S}\\s*[,)]`, 'g'),
  // require('y')
  new RegExp(`\\brequire\\s*\\(\\s*${S}\\s*\\)`, 'g'),
];

/** Specifiers imported by one source file, in order of appearance (duplicates removed). */
export function importSpecifiers(source: string): string[] {
  const { code, strings } = maskSource(source);
  const found: { at: number; spec: string }[] = [];
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      const spec = strings[Number(m[2])];
      if (spec !== undefined) found.push({ at: m.index, spec });
    }
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.spec))];
}

/** Package name of a bare specifier, or null when it is relative, a URL or not a valid name. */
export function packageNameOf(spec: string): { name: string; builtin: boolean } | null {
  if (spec.startsWith('node:')) return { name: spec.slice(5).split('/')[0] ?? spec, builtin: true };
  // `~/x` and `@/x` are path-alias conventions, not packages.
  if (spec === '' || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~')) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return null; // https:, data:, blob:
  const parts = spec.split('/');
  const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
  if (!PACKAGE_NAME.test(name)) return null; // e.g. the `@/components` path alias
  return { name, builtin: NODE_BUILTINS.has(name) };
}

/** Bare package imports across all script files, sorted by package name. */
export function detectBareImports(files: FileMap): BareImport[] {
  const byName = new Map<
    string,
    { specifiers: Set<string>; files: Set<string>; builtin: boolean }
  >();
  for (const [path, source] of Object.entries(files)) {
    if (!SCRIPT_EXTENSIONS.has(extname(path))) continue;
    for (const spec of importSpecifiers(source)) {
      const pkg = packageNameOf(spec);
      if (!pkg) continue;
      let entry = byName.get(pkg.name);
      if (!entry) {
        entry = { specifiers: new Set(), files: new Set(), builtin: pkg.builtin };
        byName.set(pkg.name, entry);
      }
      entry.specifiers.add(spec);
      entry.files.add(path);
    }
  }
  return [...byName.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, e]) => ({
      name,
      specifiers: [...e.specifiers].sort(),
      files: [...e.files].sort(),
      builtin: e.builtin,
    }));
}

/** Packages the code imports that `dependencies` does not declare (built-ins excluded). */
export function missingDependencies(
  files: FileMap,
  dependencies: Readonly<Record<string, string>>,
): string[] {
  return detectBareImports(files)
    .filter((b) => !b.builtin && !Object.prototype.hasOwnProperty.call(dependencies, b.name))
    .map((b) => b.name);
}
