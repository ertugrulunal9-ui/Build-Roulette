/**
 * Command-line options of the compatibility suite (compat/run.ts), parsed without side effects
 * so they are unit tested (test/compat-options.test.ts).
 *
 *   --only a,b          run these cases (ids or package names); RESULTS*.md is not written
 *   --cdn <baseUrl>     run against that CDN (e.g. https://esm.sh) instead of starting
 *                       @br/pkg-cdn; also COMPAT_CDN (the flag wins). Empty, `own` or `pkg-cdn`
 *                       mean our own CDN.
 *   --keep-cache        keep our CDN's cache directory afterwards
 *   --cache-dir <dir>   our CDN's cache directory (kept)
 *   --no-write          do not write RESULTS*.md
 *   --verbose           log our CDN's requests
 */

export interface CompatOptions {
  only: string[] | null;
  /** Base URL of an external CDN, without a trailing slash; null: start @br/pkg-cdn. */
  cdn: string | null;
  keepCache: boolean;
  cacheDir: string | null;
  write: boolean;
  verbose: boolean;
}

const VALUE_OPTIONS = ['--only', '--cdn', '--cache-dir'] as const;
const FLAGS = ['--keep-cache', '--no-write', '--verbose'] as const;
const OWN_CDN = new Set(['', 'own', 'pkg-cdn']);

export class CompatUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompatUsageError';
  }
}

/**
 * A CDN base URL as the runtime uses it (`cdnModuleUrl` appends `/<name>@<version>`): http(s),
 * no credentials, query or fragment, no trailing slash. Null for our own CDN.
 */
export function parseCdnBaseUrl(value: string): string | null {
  const text = value.trim();
  if (OWN_CDN.has(text.toLowerCase())) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CompatUsageError(
      `--cdn must be a URL such as https://esm.sh, got ${JSON.stringify(value)}`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CompatUsageError(`--cdn must be an http(s) URL, got ${JSON.stringify(value)}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CompatUsageError(
      '--cdn must be a plain base URL (no credentials, query or fragment)',
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function parseCompatArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): CompatOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  // `pnpm --filter … compat -- --cdn x` may pass the separator through.
  const args = argv.filter((a) => a !== '--');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if ((VALUE_OPTIONS as readonly string[]).includes(name)) {
      const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
      if (value === undefined || (eq === -1 && value.startsWith('--'))) {
        throw new CompatUsageError(`${name} needs a value`);
      }
      values.set(name, value);
    } else if ((FLAGS as readonly string[]).includes(arg)) {
      flags.add(arg);
    } else {
      throw new CompatUsageError(
        `unknown option ${JSON.stringify(arg)} (options: ${[...VALUE_OPTIONS, ...FLAGS].join(', ')})`,
      );
    }
  }
  const only = values.has('--only')
    ? (values.get('--only') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
  if (only?.length === 0) throw new CompatUsageError('--only needs at least one case');
  const cdnText = values.get('--cdn') ?? env['COMPAT_CDN'] ?? '';
  return {
    only,
    cdn: parseCdnBaseUrl(cdnText),
    keepCache: flags.has('--keep-cache'),
    cacheDir: values.get('--cache-dir') ?? null,
    write: !flags.has('--no-write'),
    verbose: flags.has('--verbose'),
  };
}

/**
 * Where a full run writes its Markdown report: `compat/RESULTS.md` for our own CDN (committed,
 * as before), `compat/RESULTS-<host>.md` for another one (`RESULTS-esm.sh.md`).
 */
export function resultsFileName(cdn: string | null): string {
  if (cdn === null) return 'RESULTS.md';
  const host = new URL(cdn).host.replace(/[^a-z0-9.-]+/gi, '_');
  return `RESULTS-${host}.md`;
}
