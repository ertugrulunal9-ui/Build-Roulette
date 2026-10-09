/**
 * Runs after `next build` (`pnpm build`; T-037): turns `out/` (the static export) into what
 * Cloudflare Pages deploys, and checks it.
 *
 * - Writes `out/_redirects` (the shells' rewrites) and `out/_headers` (security headers with
 *   a CSP built from this build's `NEXT_PUBLIC_*` values and the hashes of its inline
 *   scripts; a year's cache for `/_next/static/*`): src/lib/hosting/pages-config.ts.
 * - Writes the link-preview Function (T-038): `out/_worker.js` (Pages advanced mode, bundled
 *   with this build's `NEXT_PUBLIC_*` values and the `/*` headers) and `out/_routes.json`,
 *   which limits it to `/battles/*` (scripts/preview-worker.ts).
 * - Fails the build when: a page the host needs is missing (`404.html`, every shell), a file
 *   holds a Supabase key that is not the public anon key (a service-role or user JWT, an
 *   `sb_secret_` key, or the value of `SUPABASE_SERVICE_ROLE_KEY` / `SERVICE_ROLE_KEY` /
 *   `SUPABASE_SECRET_KEY` from this environment; the worker is checked too), or a Pages
 *   limit is exceeded (header lines, rules, redirects, file count and size).
 * - Prints the export's size and the worker's.
 *
 *   tsx scripts/pages-config.ts [outDir]     (default: out)
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
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
import { SHELLS, pagesRedirects } from '../src/lib/hosting/shells';
import { playgroundConfig } from '../src/lib/playground/config';
import { supabaseConfig } from '../src/lib/supabase/config';
import { turnstileSiteKey } from '../src/lib/supabase/turnstile';
import { errorReportingEnabled, telemetryConfig } from '../src/lib/telemetry/config';
import { bundlePreviewWorker, previewRoutesJson } from './preview-worker';

const webDir = fileURLToPath(new URL('../', import.meta.url));
const outDir = join(webDir, process.argv[2] ?? 'out');

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
  shellUrl: playgroundConfig.shellUrl,
  cdnUrl: playgroundConfig.cdnBaseUrl,
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

// ─── The link-preview Function (T-038) ───────────────────────────────────────────
const everyPath = rules.find((r) => r.path === '/*');
const worker = await bundlePreviewWorker({
  env: process.env,
  headers: Object.fromEntries(everyPath?.headers ?? []),
});
writeFileSync(join(outDir, '_worker.js'), worker);
writeFileSync(join(outDir, '_routes.json'), previewRoutesJson());

const all = files(outDir);

// ─── The pages the host needs ────────────────────────────────────────────────────
// A top-level 404.html also keeps Pages out of its single-page-app mode (every unknown path
// answered with index.html and a 200).
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
for (const f of all) {
  if (!textual.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  for (const found of secretKeysIn(text)) problems.push(`${rel(f)} contains ${found}`);
  for (const s of secrets)
    if (text.includes(s)) problems.push(`${rel(f)} contains a secret key from the environment`);
}

// ─── Size ────────────────────────────────────────────────────────────────────────
// The files Pages serves (its own files are configuration, not assets).
const PAGES_FILES = ['_headers', '_redirects', '_worker.js', '_routes.json'];
const sizes = all
  .filter((f) => !PAGES_FILES.includes(rel(f)))
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
    `preview Function: _worker.js ${kib(Buffer.byteLength(worker))} (${kib(gzipSync(worker).length)} gzip), _routes.json ${previewRoutesJson().trim().replace(/\s+/g, ' ')}`,
  ].join('\n'),
);

if (problems.length > 0) {
  console.error(`pages-config: the export is not deployable:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
