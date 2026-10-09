/**
 * What the sandbox needs from a package CDN besides the module code (T-032, T-035), checked on
 * every URL a compatibility case requests and on every module those import from the CDN:
 *
 * - **200, no redirect.** The runtime only emits exact versions; a redirect would put a hop
 *   in the HTTP cache that expires (T-032 relies on exact URLs answering themselves).
 * - **Cached for long:** `max-age` of at least 30 days (we send a year + `immutable`), not
 *   `no-store`/`no-cache`/`private`, so a browser keeps what it loaded through an outage.
 * - **CORS:** `Access-Control-Allow-Origin` `*` (or the page's origin): module scripts and the
 *   bundler's CSS fetches are cross-origin.
 * - **Content type:** JavaScript for modules, CSS for package CSS.
 * - **Same origin:** a module may only import modules from the CDN's own origin (esm.sh's
 *   internal build paths are root-relative), since the shell's CSP allows that origin only.
 *
 * Notes (reported, not problems): `Vary` (esm.sh varies by `User-Agent` when no `?target=` is
 * given), a missing `immutable`, and imports the sandbox shell's own scan (`moduleImportUrls`,
 * which its warm-up and package checks follow) does not see. Imports are read with
 * es-module-lexer here. Requests carry the browser's User-Agent and an `Origin`, so the CDN
 * answers as it answers the browser. The fetch is injected (unit tests).
 */
import { moduleImportUrls, staticImports } from '@br/protocol';
import { init as initLexer, parse as parseModule } from 'es-module-lexer';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface ProbeRecord {
  url: string;
  kind: 'module' | 'css';
  /** 0: a URL the runtime emits; 1+: imported by a CDN module. */
  depth: number;
  /** null: no answer. */
  status: number | null;
  error: string | null;
  location: string | null;
  cacheControl: string | null;
  allowOrigin: string | null;
  vary: string | null;
  contentType: string | null;
  bytes: number;
  ms: number;
  /** Modules it imports from the CDN's origin (followed). */
  imports: string[];
  /** Modules it imports from any other http(s) origin (the shell CSP blocks them). */
  foreignImports: string[];
  /** Of `imports`, those the sandbox shell's scan finds (`moduleImportUrls`). */
  shellFinds: number;
  problems: string[];
  notes: string[];
}

export interface ProbeOptions {
  /** The page origin sent as `Origin`. */
  origin: string;
  userAgent: string;
  /** Most modules followed behind the roots (per `probeTree` call). */
  maxFollowed?: number;
  timeoutMs?: number;
}

/** Least `max-age` that keeps a package through an outage worth the name (30 days). */
export const MIN_MAX_AGE_SECONDS = 30 * 24 * 3600;

/** The problems and notes of one response (pure). */
export function contractFindings(
  r: Pick<
    ProbeRecord,
    | 'kind'
    | 'status'
    | 'error'
    | 'location'
    | 'cacheControl'
    | 'allowOrigin'
    | 'vary'
    | 'contentType'
    | 'foreignImports'
  >,
  origin: string,
): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  if (r.status === null) return { problems: [`no answer (${r.error ?? 'network error'})`], notes };
  if (r.status >= 300 && r.status < 400) {
    problems.push(
      `redirects (HTTP ${String(r.status)}) to ${r.location ?? '?'}: an exact URL must answer itself`,
    );
    return { problems, notes };
  }
  if (r.status !== 200) {
    problems.push(`HTTP ${String(r.status)}`);
    return { problems, notes };
  }
  const cc = (r.cacheControl ?? '').toLowerCase();
  const maxAge = /(?:^|[,\s])max-age=(\d+)/.exec(cc)?.[1];
  if (
    /\b(?:no-store|no-cache|private)\b/.test(cc) ||
    !maxAge ||
    Number(maxAge) < MIN_MAX_AGE_SECONDS
  ) {
    problems.push(
      `Cache-Control ${JSON.stringify(r.cacheControl ?? '')}: needs max-age ≥ 30 days to outlast a CDN outage`,
    );
  } else if (!/\bimmutable\b/.test(cc)) {
    notes.push(`Cache-Control without immutable (${r.cacheControl ?? ''})`);
  }
  if (r.allowOrigin !== '*' && r.allowOrigin !== origin) {
    problems.push(
      `no CORS for ${origin} (Access-Control-Allow-Origin: ${r.allowOrigin ?? 'none'})`,
    );
  }
  const type = (r.contentType ?? '').toLowerCase();
  if (r.kind === 'module' && !/javascript|ecmascript/.test(type)) {
    problems.push(`Content-Type ${JSON.stringify(r.contentType ?? '')} is not JavaScript`);
  }
  if (r.kind === 'css' && !type.includes('text/css')) {
    problems.push(`Content-Type ${JSON.stringify(r.contentType ?? '')} is not CSS`);
  }
  if (r.foreignImports.length > 0) {
    problems.push(
      `imports from another origin, which the shell CSP blocks: ${r.foreignImports.join(', ')}`,
    );
  }
  if (r.vary) notes.push(`Vary: ${r.vary}`);
  return { problems, notes };
}

const lexerReady = initLexer();

/** Static import specifiers (and literal dynamic ones, separately) of a module body. */
function lexImports(body: string): { staticSpecs: string[]; dynamicSpecs: string[] } {
  try {
    const [imports] = parseModule(body);
    const staticSpecs: string[] = [];
    const dynamicSpecs: string[] = [];
    for (const i of imports) {
      if (i.type === 'static' || i.type === 'reexport-star') staticSpecs.push(i.specifier);
      else if (i.type === 'dynamic' && i.specifier !== undefined) dynamicSpecs.push(i.specifier);
    }
    return { staticSpecs, dynamicSpecs };
  } catch {
    // Not parseable as a module: what the shell's own scan sees.
    return { staticSpecs: staticImports(body, 1000), dynamicSpecs: [] };
  }
}

/**
 * The module imports of a body: its static imports on the CDN's own origin (followed), any
 * static or literal dynamic import on another origin, and how many of the first the sandbox
 * shell's scan finds.
 */
export async function splitImports(
  body: string,
  url: string,
): Promise<{ imports: string[]; foreignImports: string[]; shellFinds: number }> {
  await lexerReady;
  const imports = new Set<string>();
  const foreign = new Set<string>();
  const base = new URL(url);
  const { staticSpecs, dynamicSpecs } = lexImports(body);
  const resolve = (spec: string): URL | null => {
    if (!/^(?:\/|\.\.?\/|https?:\/\/)/i.test(spec)) return null; // bare: the import map's
    try {
      const resolved = new URL(spec, base);
      resolved.hash = '';
      return resolved;
    } catch {
      return null;
    }
  };
  for (const spec of staticSpecs) {
    const u = resolve(spec);
    if (u) (u.origin === base.origin ? imports : foreign).add(u.href);
  }
  for (const spec of dynamicSpecs) {
    const u = resolve(spec);
    if (u && u.origin !== base.origin) foreign.add(u.href);
  }
  const shell = new Set(moduleImportUrls(body, url, 1000));
  return {
    imports: [...imports],
    foreignImports: [...foreign],
    shellFinds: [...imports].filter((u) => shell.has(u)).length,
  };
}

/** One request, as the browser would send it (CORS `Origin`, its User-Agent, no redirects). */
export async function probeUrl(
  url: string,
  kind: ProbeRecord['kind'],
  depth: number,
  fetchFn: FetchFn,
  opts: ProbeOptions,
): Promise<ProbeRecord> {
  const started = performance.now();
  const record: ProbeRecord = {
    url,
    kind,
    depth,
    status: null,
    error: null,
    location: null,
    cacheControl: null,
    allowOrigin: null,
    vary: null,
    contentType: null,
    bytes: 0,
    ms: 0,
    imports: [],
    foreignImports: [],
    shellFinds: 0,
    problems: [],
    notes: [],
  };
  try {
    const res = await fetchFn(url, {
      redirect: 'manual',
      headers: { Origin: opts.origin, 'User-Agent': opts.userAgent },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
    const body = await res.text();
    record.status = res.status;
    record.location = res.headers.get('location');
    record.cacheControl = res.headers.get('cache-control');
    record.allowOrigin = res.headers.get('access-control-allow-origin');
    record.vary = res.headers.get('vary');
    record.contentType = res.headers.get('content-type');
    record.bytes = Buffer.byteLength(body);
    if (res.status === 200 && kind === 'module') {
      Object.assign(record, await splitImports(body, url));
    }
    if (res.status >= 400) record.error = body.trim().split('\n')[0]?.slice(0, 300) ?? null;
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
  }
  record.ms = performance.now() - started;
  Object.assign(record, contractFindings(record, opts.origin));
  if (record.shellFinds < record.imports.length) {
    record.notes.push(
      `the shell's import scan finds ${String(record.shellFinds)} of ${String(record.imports.length)} same-origin imports`,
    );
  }
  return record;
}

/**
 * Probes the roots, then every module they import from the CDN's origin, breadth first (at most
 * `maxFollowed` beyond the roots). URLs in `seen` are skipped (already probed by an earlier
 * case: the React modules every case shares), and every URL probed here is added to it.
 */
export async function probeTree(
  roots: readonly { url: string; kind: ProbeRecord['kind'] }[],
  fetchFn: FetchFn,
  opts: ProbeOptions,
  seen = new Set<string>(),
): Promise<ProbeRecord[]> {
  const out: ProbeRecord[] = [];
  let followed = 0;
  const maxFollowed = opts.maxFollowed ?? 64;
  let level = roots.filter((r) => !seen.has(r.url)).map((r) => ({ ...r, depth: 0 }));
  for (const r of level) seen.add(r.url);
  while (level.length > 0) {
    const records = await Promise.all(
      level.map((r) => probeUrl(r.url, r.kind, r.depth, fetchFn, opts)),
    );
    out.push(...records);
    const next: typeof level = [];
    for (const rec of records) {
      for (const dep of rec.imports) {
        if (seen.has(dep) || followed >= maxFollowed) continue;
        seen.add(dep);
        followed++;
        next.push({ url: dep, kind: 'module', depth: rec.depth + 1 });
      }
    }
    level = next;
  }
  return out;
}

/** The problems of a set of records, each prefixed with its short URL. */
export function treeProblems(
  records: readonly ProbeRecord[],
  short: (url: string) => string,
): string[] {
  return records.flatMap((r) => r.problems.map((p) => `${short(r.url)}: ${p}`));
}
