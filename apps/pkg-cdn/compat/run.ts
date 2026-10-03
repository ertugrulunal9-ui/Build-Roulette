/**
 * R1 package compatibility suite (docs/02-risks.md R1).
 *
 * For each curated package: a tiny React app that imports it, uses it, and renders a known
 * marker. Each app goes through the real pipeline: `@br/runtime` (esbuild-wasm worker,
 * cdn-rewrite, import map) -> sandbox shell (cross-site iframe, CSP) -> @br/pkg-cdn
 * (npm registry) in Chromium. A case passes when the marker shows the expected text and no
 * runtime error was reported.
 *
 * Needs network access to the npm registry, so it is not part of `pnpm test`.
 *
 *   pnpm --filter @br/pkg-cdn compat [--only zustand,three] [--keep-cache] [--no-write]
 *
 * Writes compat/RESULTS.md (committed) and node_modules/.cache/pkg-cdn-compat/results.json.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { cdnModuleUrl, resolveBareImport } from '@br/runtime/bundler';
import { APP_DIR, loadConfig } from '../src/config';
import type { CompatApi, CompatRunReport, CompatState } from './harness/page';
import { startHarness } from './harness/server';
import { CASES, MAIN_TSX, REACT_VERSION, type CompatCase } from './packages';
import { renderResults, type CaseResult, type CdnTiming } from './report';

declare global {
  interface Window {
    __compat: CompatApi;
  }
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const only = option('--only')
  ?.split(',')
  .map((s) => s.trim());
const keepCache = flag('--keep-cache');
const write = !flag('--no-write');
const verbose = flag('--verbose');
const CASE_TIMEOUT_MS = 30_000;

const outDir = path.join(APP_DIR, 'node_modules', '.cache', 'pkg-cdn-compat');
const cacheDir = option('--cache-dir') ?? path.join(outDir, `cdn-${Date.now().toString()}`);

function manifestFor(c: CompatCase) {
  return {
    entry: 'src/main.tsx',
    dependencies: {
      react: REACT_VERSION,
      'react-dom': REACT_VERSION,
      [c.name]: c.version,
      ...(c.deps ?? {}),
    },
  };
}

/** Bare imports of the smoke app (to warm and time the CDN like the runtime will request them). */
function importsOf(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(
    /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g,
  )) {
    const spec = m[1] ?? m[2];
    if (spec && !spec.startsWith('.') && !spec.startsWith('/')) out.add(spec);
  }
  const pragma = /@jsxImportSource\s+(\S+)/.exec(source);
  if (pragma?.[1]) out.add(`${pragma[1]}/jsx-runtime`);
  return [...out];
}

async function timedFetch(
  url: string,
): Promise<{ ms: number; status: number; bytes: number; body: string; cache: string }> {
  const started = performance.now();
  const res = await fetch(url);
  const body = await res.text();
  return {
    ms: performance.now() - started,
    status: res.status,
    bytes: Buffer.byteLength(body),
    body,
    cache:
      res.headers.get('x-cache') ?? (res.headers.get('content-type')?.includes('css') ? 'RAW' : ''),
  };
}

/** Requests every CDN URL a case needs twice: cold (empty cache) and warm. */
async function warmCase(c: CompatCase, cdnUrl: string): Promise<CdnTiming> {
  const deps = manifestFor(c).dependencies;
  const timing: CdnTiming = { coldMs: 0, warmMs: 0, bytes: 0, urls: [], error: null };
  for (const spec of importsOf(c.app)) {
    const r = resolveBareImport(spec, deps, cdnUrl);
    if (r.kind === 'import-map') continue;
    if (r.kind === 'error') {
      timing.error = `runtime rejects import "${spec}": ${r.message}`;
      return timing;
    }
    timing.urls.push(r.url.slice(cdnUrl.length));
    const cold = await timedFetch(r.url);
    if (cold.status !== 200) {
      timing.error = `CDN ${cold.status.toString()} for ${r.url.slice(cdnUrl.length)}: ${cold.body.trim().slice(0, 400)}`;
      return timing;
    }
    const warm = await timedFetch(r.url);
    timing.coldMs += cold.ms;
    timing.warmMs += warm.ms;
    timing.bytes += cold.bytes;
  }
  return timing;
}

async function runCase(
  page: Page,
  c: CompatCase,
): Promise<{ report: CompatRunReport; state: CompatState; markerText: string | null }> {
  const files = { 'src/main.tsx': MAIN_TSX, 'src/App.tsx': c.app };
  const report = await page.evaluate(
    ({ files, manifest, timeout }) => window.__compat.run(files, manifest, timeout),
    { files, manifest: manifestFor(c), timeout: CASE_TIMEOUT_MS },
  );
  let markerText: string | null = null;
  if (report.ok) {
    const marker = page.frameLocator('#preview').frameLocator('iframe').getByTestId('marker');
    const deadline = Date.now() + (c.timeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      markerText = await marker.textContent({ timeout: 1000 }).catch(() => null);
      if (markerText === c.expected) break;
      const st = await page.evaluate(() => window.__compat.state());
      if (st.runtimeErrors.length > 0 && markerText === null) break;
      await page.waitForTimeout(150);
    }
    // Let late errors (effects, timers, rejected promises) surface.
    await page.waitForTimeout(500);
  }
  const state = await page.evaluate(() => window.__compat.state());
  return { report, state, markerText };
}

function failureReason(
  c: CompatCase,
  report: CompatRunReport,
  state: CompatState,
  markerText: string | null,
): string | null {
  if (!report.ok) {
    if (report.phase === 'build')
      return `bundle failed: ${report.diagnostics.join(' | ').slice(0, 500)}`;
    return `${report.phase} failed`;
  }
  if (state.runtimeErrors.length > 0)
    return `runtime error: ${state.runtimeErrors.join(' | ').slice(0, 500)}`;
  if (markerText !== c.expected) {
    return markerText === null
      ? 'marker never rendered'
      : `marker text was "${markerText.slice(0, 120)}", expected "${c.expected}"`;
  }
  return null;
}

async function main(): Promise<void> {
  const cases = only ? CASES.filter((c) => only.includes(c.name) || only.includes(c.id)) : CASES;
  if (cases.length === 0) throw new Error('no cases selected');
  mkdirSync(outDir, { recursive: true });
  const config = { ...loadConfig({}), cacheDir };
  const harness = await startHarness(
    config,
    verbose
      ? (l) => {
          console.log(`  [cdn] ${l}`);
        }
      : undefined,
  );
  const cdnUrl = harness.cdn.url;
  console.log(`compat: ${cases.length.toString()} cases, CDN ${cdnUrl}, cache ${cacheDir}`);

  // React for the import map (shared by every case): timed separately.
  const reactUrls = [
    cdnModuleUrl(cdnUrl, 'react', REACT_VERSION, '', false),
    cdnModuleUrl(cdnUrl, 'react', REACT_VERSION, '/jsx-runtime'),
    cdnModuleUrl(cdnUrl, 'react-dom', REACT_VERSION, ''),
    cdnModuleUrl(cdnUrl, 'react-dom', REACT_VERSION, '/client'),
  ];
  const react: CdnTiming = { coldMs: 0, warmMs: 0, bytes: 0, urls: [], error: null };
  for (const u of reactUrls) {
    const cold = await timedFetch(u);
    if (cold.status !== 200)
      throw new Error(`React from the CDN failed: ${cold.status.toString()} ${cold.body}`);
    const warm = await timedFetch(u);
    react.coldMs += cold.ms;
    react.warmMs += warm.ms;
    react.bytes += cold.bytes;
    react.urls.push(u.slice(cdnUrl.length));
  }
  console.log(
    `React import map modules: cold ${react.coldMs.toFixed(0)} ms, warm ${react.warmMs.toFixed(0)} ms`,
  );

  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    // WebGL in headless Chromium without a GPU (three, pixi, kaplay, phaser, fiber).
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const results: CaseResult[] = [];
  let bootMs = 0;
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(harness.appUrl);
    bootMs = (await page.evaluate(() => window.__compat.boot)).coldStartMs;

    for (const c of cases) {
      const cdn = await warmCase(c, cdnUrl);
      let result: CaseResult;
      if (cdn.error !== null) {
        result = {
          case: c,
          pass: false,
          reason: cdn.error,
          cdn,
          buildMs: 0,
          readyMs: 0,
          consoleErrors: [],
        };
      } else {
        try {
          const { report, state, markerText } = await runCase(page, c);
          const reason = failureReason(c, report, state, markerText);
          result = {
            case: c,
            pass: reason === null,
            reason,
            cdn,
            buildMs: report.buildMs,
            readyMs: report.readyMs,
            consoleErrors: state.consoleErrors,
          };
        } catch (e) {
          result = {
            case: c,
            pass: false,
            reason: `harness error: ${e instanceof Error ? e.message : String(e)}`,
            cdn,
            buildMs: 0,
            readyMs: 0,
            consoleErrors: [],
          };
        }
      }
      results.push(result);
      const t = `cold ${cdn.coldMs.toFixed(0)} ms / warm ${cdn.warmMs.toFixed(1)} ms`;
      console.log(
        `${result.pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(28)} ${t}${result.reason ? `\n     ${result.reason}` : ''}`,
      );
    }
    if (pageErrors.length > 0) console.log(`harness page errors: ${pageErrors.join(' | ')}`);
  } finally {
    await browser.close();
    await harness.close();
    if (!keepCache && option('--cache-dir') === undefined)
      rmSync(cacheDir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(
    `\n${passed.toString()}/${results.length.toString()} passed (${((100 * passed) / results.length).toFixed(1)}%)`,
  );
  writeFileSync(
    path.join(outDir, 'results.json'),
    JSON.stringify({ react, bootMs, results }, null, 2),
  );
  if (write && !only) {
    writeFileSync(
      path.join(APP_DIR, 'compat', 'RESULTS.md'),
      renderResults({ results, react, bootMs }),
    );
    console.log('wrote compat/RESULTS.md');
  }
  // Fail the process (and a CI job) when the R1 exit criterion is not met.
  if (passed / results.length < 0.9) process.exitCode = 1;
}

await main();
