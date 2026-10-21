/**
 * Runs after `next build` (`pnpm build`; T-037, T-043): turns `out/` (the static export) into
 * what the Cloudflare Worker with static assets deploys (apps/web/wrangler.jsonc), and checks
 * it. (The name is from T-037, when the host was Cloudflare Pages; the files are the same.)
 *
 * - Writes `out/_redirects` (moved paths, the shells' rewrites) and `out/_headers` (security
 *   headers with a CSP built from this build's `NEXT_PUBLIC_*` values and the hashes of its
 *   inline scripts; a year's cache for `/_next/static/*`): src/lib/hosting/pages-config.ts.
 * - Writes the link-preview Worker (T-038): `dist/worker.js`, bundled with this build's
 *   `NEXT_PUBLIC_*` values and the `/*` headers (scripts/preview-worker.ts). It stays outside
 *   `out/`, so it is never uploaded as a static file; wrangler.jsonc's `run_worker_first`
 *   limits it to `/battles/*`.
 * - Fails the build when: a page the host needs is missing (`404.html`, every shell), a file
 *   holds a Supabase key that is not the public anon key (a service-role or user JWT, an
 *   `sb_secret_` key, or the value of `SUPABASE_SERVICE_ROLE_KEY` / `SERVICE_ROLE_KEY` /
 *   `SUPABASE_SECRET_KEY` from this environment; the worker is checked too), a host limit is
 *   exceeded (header lines, rules, redirects, file count and size), `out/` holds a
 *   `_worker.js` (wrangler refuses to upload one as an asset), or the link import's test-only
 *   origins leak: `NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS` is set for a Supabase that is not
 *   local or lists a host that is not a local test host, or a build without it still holds
 *   the test fixture host (`host.docker.internal`; src/lib/site/link-config.ts).
 * - Prints the export's size and the worker's.
 *
 *   tsx scripts/pages-config.ts [outDir]     (default: out; the worker goes to dist/worker.js)
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  PAGES_LIMITS,
  checkHeaders,
  contentSecurityPolicy,
  headerRules,
  headersFile,
  inlineScriptHashes,
  secretKeysIn,
} from '../src/lib/hosting/pages-config';
import { REDIRECTS, SHELLS, pagesRedirects } from '../src/lib/hosting/shells';
import { previewConfig } from '../src/lib/preview/config';
import { linkTestOrigins } from '../src/lib/site/link-config';
import { supabaseConfig } from '../src/lib/supabase/config';
import { turnstileSiteKey } from '../src/lib/supabase/turnstile';
import { errorReportingEnabled, telemetryConfig } from '../src/lib/telemetry/config';
import { PREVIEW_ROUTES, WORKER_FILE, bundlePreviewWorker } from './preview-worker';

const webDir = fileURLToPath(new URL('../', import.meta.url));
const outDir = join(webDir, process.argv[2] ?? 'out');
const workerPath = join(webDir, WORKER_FILE);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)],
  );
}

const problems: string[] = [];
const exported = files(outDir);
const rel = (f: string) => relative(outDir, f);

// ─── _headers and _redirects ─────────────────────────────────────────────────────
const scriptHashes = exported
  .filter((f) => f.endsWith('.html'))
  .flatMap((f) => inlineScriptHashes(readFileSync(f, 'utf8')));
const csp = contentSecurityPolicy({
  supabaseUrl: supabaseConfig.url,
  shellUrl: previewConfig.shellUrl,
  sentryDsn: errorReportingEnabled() ? telemetryConfig.sentryDsn : null,
  posthogHost: telemetryConfig.posthogKey ? telemetryConfig.posthogHost : null,
  turnstile: turnstileSiteKey() !== null,
  scriptHashes,
});
const rules = headerRules(csp);
problems.push(...checkHeaders(rules));
writeFileSync(join(outDir, '_headers'), headersFile(rules));
writeFileSync(join(outDir, '_redirects'), pagesRedirects());
if (SHELLS.length > PAGES_LIMITS.dynamicRedirects) problems.push('too many dynamic redirects');
if (REDIRECTS.length > PAGES_LIMITS.staticRedirects) problems.push('too many static redirects');

// ─── The link-preview Worker (T-038, T-043) ──────────────────────────────────────
const everyPath = rules.find((r) => r.path === '/*');
const worker = await bundlePreviewWorker({
  env: process.env,
  headers: Object.fromEntries(everyPath?.headers ?? []),
});
mkdirSync(dirname(workerPath), { recursive: true });
writeFileSync(workerPath, worker);
// Pages' files from before T-043, if an older build left them: not part of a Workers upload.
for (const stale of ['_worker.js', '_routes.json']) rmSync(join(outDir, stale), { force: true });

const all = files(outDir);

// ─── The pages the host needs ────────────────────────────────────────────────────
// A top-level 404.html is what `not_found_handling: "404-page"` serves for an unknown path,
// with a 404 (and without it an unknown path would invoke the Worker).
for (const page of [
  '404.html',
  'index.html',
  ...SHELLS.map((s) => `${s.destination.slice(1)}.html`),
]) {
  if (!all.some((f) => rel(f) === page)) problems.push(`missing ${page}`);
}

// ─── No secret keys ──────────────────────────────────────────────────────────────
const secrets = ['SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']
  .map((k) => process.env[k]?.trim() ?? '')
  .filter((v) => v.length >= 20);
const textual = /\.(html|js|txt|json|css|map|svg|xml|webmanifest)$/;
for (const f of [...all, workerPath]) {
  if (!textual.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  const name = f === workerPath ? WORKER_FILE : rel(f);
  for (const found of secretKeysIn(text)) problems.push(`${name} contains ${found}`);
  for (const s of secrets)
    if (text.includes(s)) problems.push(`${name} contains a secret key from the environment`);
}

// ─── The link import's test-only origins (e2e builds only) ───────────────────────
// The e2e serves fixture sites to the `import-url` function at this host (the function runs in
// Docker); the stack suites' builds list it in NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS.
const TEST_FIXTURE_HOST = 'host.docker.internal';
const LOCAL_HOSTS = new Set([TEST_FIXTURE_HOST, 'localhost', '127.0.0.1']);
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
};
if (linkTestOrigins.length > 0) {
  if (!LOCAL_HOSTS.has(hostOf(supabaseConfig.url))) {
    problems.push(
      `NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS is for local test builds only, but Supabase is ${supabaseConfig.url}`,
    );
  }
  for (const o of linkTestOrigins) {
    if (!LOCAL_HOSTS.has(hostOf(o))) {
      problems.push(
        `NEXT_PUBLIC_IMPORT_URL_TEST_ORIGINS lists ${o}, which is not a local test host`,
      );
    }
  }
  console.log(`pages-config: TEST build, link import also accepts ${linkTestOrigins.join(', ')}`);
} else {
  for (const f of all) {
    if (!textual.test(f)) continue;
    if (readFileSync(f, 'utf8').includes(TEST_FIXTURE_HOST)) {
      problems.push(`${rel(f)} contains the link import's test-only host ${TEST_FIXTURE_HOST}`);
    }
  }
}

// ─── Size ────────────────────────────────────────────────────────────────────────
// The files the assets serve (`_headers` and `_redirects` are configuration: wrangler does
// not upload them as assets).
const HOST_FILES = ['_headers', '_redirects'];
// wrangler refuses to upload a `_worker.js` (Pages' advanced mode) as an asset.
if (all.some((f) => rel(f) === '_worker.js')) problems.push('out/_worker.js must not exist');
const sizes = all
  .filter((f) => !HOST_FILES.includes(rel(f)))
  .map((f) => ({ f, bytes: statSync(f).size }));
if (sizes.length > PAGES_LIMITS.files) problems.push(`${String(sizes.length)} files`);
for (const { f, bytes } of sizes) {
  if (bytes > PAGES_LIMITS.fileBytes)
    problems.push(`${rel(f)} is ${String(bytes)} bytes (over 25 MiB)`);
}
const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const total = sizes.reduce((n, s) => n + s.bytes, 0);
const js = sizes.filter((s) => s.f.endsWith('.js'));
const jsGzip = js.reduce((n, s) => n + gzipSync(readFileSync(s.f)).length, 0);
const largest = [...sizes].sort((a, b) => b.bytes - a.bytes)[0];
console.log(
  [
    `pages-config: ${rel(join(outDir, '_headers'))}, _redirects written (CSP ${String(csp.length)} chars, ${String(new Set(scriptHashes).size)} inline script hashes)`,
    `export: ${String(sizes.length)} files, ${kib(total)} (JS ${String(js.length)} files, ${kib(js.reduce((n, s) => n + s.bytes, 0))}, ${kib(jsGzip)} gzip; largest ${largest ? `${rel(largest.f)} ${kib(largest.bytes)}` : '–'})`,
    `preview Worker: ${WORKER_FILE} ${kib(Buffer.byteLength(worker))} (${kib(gzipSync(worker).length)} gzip), run first for ${PREVIEW_ROUTES.join(', ')}`,
  ].join('\n'),
);

if (problems.length > 0) {
  console.error(`pages-config: the export is not deployable:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
