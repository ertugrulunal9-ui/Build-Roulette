/**
 * R1 package compatibility suite (docs/02-risks.md R1).
 *
 * For each curated package: a tiny React app that imports it, uses it, and renders a known
 * marker. Each app goes through the real pipeline: `@br/runtime` (esbuild-wasm worker,
 * cdn-rewrite, import map) -> sandbox shell (cross-site iframe, CSP) -> the package CDN in
 * Chromium. A case passes when the marker shows the expected text and no runtime error was
 * reported.
 *
 * The CDN is @br/pkg-cdn (started here, resolving from the npm registry), or any
 * esm.sh-compatible CDN given with `--cdn <baseUrl>` / `COMPAT_CDN` (T-035: production on the
 * free plan uses https://esm.sh). Every URL a case requests, and every module those import from
 * the CDN, is also checked against what the sandbox needs from a CDN (compat/contract.ts): 200
 * without a redirect, a long cache lifetime, CORS, the content type, same-origin imports. Each
 * case also probes the import-map URL of every package of its manifest (T-040: what a CDN
 * module's bare import of it loads), and the short cache of a dependency the manifest does not
 * list (esm.sh: a range URL) is a note, not a problem (`caseFindings`).
 *
 * Cases with a `knownFailure` still run and count; the report lists them apart (T-040).
 *
 * Needs network access (the npm registry, or the external CDN), so it is not part of
 * `pnpm test`.
 *
 *   pnpm --filter @br/pkg-cdn compat [--cdn https://esm.sh] [--only zustand,three] [--no-write]
 *
 * Writes compat/RESULTS.md (our CDN; committed) or compat/RESULTS-<host>.md (another CDN), and
 * node_modules/.cache/pkg-cdn-compat/results.json. Exit code 1 when fewer than 90% of the
 * cases pass, or when the React import-map URLs break the CDN contract.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { APP_DIR, loadConfig } from '../src/config';
import {
  caseFindings,
  probeTree,
  treeProblems,
  type FetchFn,
  type ProbeOptions,
  type ProbeRecord,
} from './contract';
import type { CompatApi, CompatRunReport, CompatState } from './harness/page';
import { startHarness } from './harness/server';
import { CompatUsageError, parseCompatArgs, resultsFileName } from './options';
import { CASES, MAIN_TSX, knownFailureOn, type CompatCase } from './packages';
import { renderResults, type CaseResult, type CdnInfo, type CdnTiming } from './report';
import {
  caseMapUrls,
  caseUrls,
  manifestFor,
  manifestNames,
  moduleUrlsOf,
  reactImportMap,
  shortUrl,
} from './urls';

declare global {
  interface Window {
    __compat: CompatApi;
  }
}

let options: ReturnType<typeof parseCompatArgs>;
try {
  options = parseCompatArgs(process.argv.slice(2), process.env);
} catch (e) {
  if (!(e instanceof CompatUsageError)) throw e;
  console.error(`compat: ${e.message}`);
  process.exit(2);
}
const { only, keepCache, write, verbose } = options;
const CASE_TIMEOUT_MS = 30_000;
/**
 * Modules followed behind a case's URLs. Deep enough for the largest graph in the list
 * (pixi.js on esm.sh: about 130 modules), so an external CDN builds every module before the
 * browser loads the case (T-040: esm.sh builds on first request; CI run 60's pixi.js case timed
 * out while it did, and the next case with the same URLs passed).
 */
const CASE_MAX_FOLLOWED = 512;

const outDir = path.join(APP_DIR, 'node_modules', '.cache', 'pkg-cdn-compat');
const cacheDir = options.cacheDir ?? path.join(outDir, `cdn-${Date.now().toString()}`);

const fetchFn: FetchFn = (url, init) => fetch(url, init);

/** The probed records of `roots` and of every module behind them. */
function reachable(
  roots: readonly string[],
  probed: ReadonlyMap<string, ProbeRecord>,
): ProbeRecord[] {
  const out: ProbeRecord[] = [];
  const seen = new Set<string>();
  const queue = [...roots];
  for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
    const rec = probed.get(url);
    if (seen.has(url) || !rec) continue;
    seen.add(url);
    out.push(rec);
    queue.push(...rec.imports);
  }
  return out;
}

async function timedGet(url: string, userAgent: string): Promise<number> {
  const started = performance.now();
  const res = await fetch(url, {
    headers: { 'User-Agent': userAgent },
    signal: AbortSignal.timeout(90_000),
  });
  await res.arrayBuffer();
  return performance.now() - started;
}

/**
 * Requests every CDN URL a case needs twice (first: cold on an empty cache for our CDN,
 * whatever the external CDN holds otherwise; second: warm), and checks the contract on them
 * and on the modules behind them.
 */
async function probeCase(
  c: CompatCase,
  cdnUrl: string,
  probe: ProbeOptions,
  probed: Map<string, ProbeRecord>,
): Promise<{ timing: CdnTiming; contract: CaseResult['contract'] }> {
  const timing: CdnTiming = { coldMs: 0, warmMs: 0, bytes: 0, urls: [], error: null };
  const contract: CaseResult['contract'] = { checked: 0, problems: [], notes: [] };
  const { urls, error } = caseUrls(c, cdnUrl);
  if (error !== null) {
    timing.error = error;
    return { timing, contract };
  }
  // The case's own imports, then the import-map URLs of its other packages (T-040).
  const own = new Set(urls.map((u) => u.url));
  const roots = [...urls, ...caseMapUrls(c, cdnUrl).filter((u) => !own.has(u.url))];
  // URLs an earlier case already probed (the same package and manifest) are not requested again.
  const fresh = await probeTree(
    roots,
    fetchFn,
    { ...probe, maxFollowed: CASE_MAX_FOLLOWED },
    new Set(probed.keys()),
  );
  for (const r of fresh) probed.set(r.url, r);
  const records = reachable(
    roots.map((u) => u.url),
    probed,
  );
  const short = (u: string) => shortUrl(u, cdnUrl);
  for (const u of urls) {
    timing.urls.push(short(u.url));
    const rec = probed.get(u.url);
    if (!rec) continue;
    if (rec.status !== 200) {
      timing.error = `CDN ${rec.status === null ? 'no answer' : String(rec.status)} for ${short(u.url)}: ${(rec.error ?? rec.location ?? '').slice(0, 400)}`;
      break;
    }
    timing.coldMs += rec.ms;
    timing.bytes += rec.bytes;
    timing.warmMs += await timedGet(u.url, probe.userAgent);
  }
  contract.checked = records.length;
  const findings = caseFindings(records, manifestNames(c), short);
  contract.problems = findings.problems;
  contract.notes = findings.notes;
  return { timing, contract };
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
  const harness = await startHarness(
    options.cdn === null
      ? { config: { ...loadConfig({}), cacheDir } }
      : { externalUrl: options.cdn },
    verbose
      ? (l) => {
          console.log(`  [cdn] ${l}`);
        }
      : undefined,
  );
  const cdnUrl = harness.cdnUrl;
  const cdn: CdnInfo = { url: cdnUrl, own: harness.cdn !== null };
  console.log(
    `compat: ${cases.length.toString()} cases, CDN ${cdnUrl}${cdn.own ? ` (@br/pkg-cdn, cache ${cacheDir})` : ' (external)'}`,
  );

  const browser = await chromium.launch({
    channel: 'chromium',
    headless: true,
    // WebGL in headless Chromium without a GPU (three, pixi, kaplay, phaser, fiber).
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const results: CaseResult[] = [];
  let bootMs = 0;
  const react: CdnTiming = { coldMs: 0, warmMs: 0, bytes: 0, urls: [], error: null };
  let reactProbe: ProbeRecord[] = [];
  const probed = new Map<string, ProbeRecord>();
  try {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.goto(harness.appUrl);
    // The CDN answers these requests as it answers this browser (esm.sh picks its build
    // target from the User-Agent).
    const probe: ProbeOptions = {
      origin: new URL(harness.appUrl).origin,
      userAgent: await page.evaluate(() => navigator.userAgent),
    };

    // React for the import map (shared by every case), with the modules behind it: React,
    // React DOM and React DOM's pinned scheduler (T-040), not the prefix entries.
    const reactUrls = moduleUrlsOf(reactImportMap(cdnUrl));
    reactProbe = await probeTree(
      reactUrls.map((url) => ({ url, kind: 'module' as const })),
      fetchFn,
      probe,
    );
    for (const r of reactProbe) probed.set(r.url, r);
    for (const u of reactUrls) {
      const rec = reactProbe.find((r) => r.url === u);
      if (rec?.status !== 200) {
        throw new Error(
          `React from the CDN failed: ${String(rec?.status ?? 'no answer')} for ${u}: ${rec?.error ?? rec?.location ?? ''}`,
        );
      }
      react.coldMs += rec.ms;
      react.bytes += rec.bytes;
      react.warmMs += await timedGet(u, probe.userAgent);
      react.urls.push(shortUrl(u, cdnUrl));
    }
    console.log(
      `React import map modules: first ${react.coldMs.toFixed(0)} ms, second ${react.warmMs.toFixed(0)} ms, ${String(reactProbe.length)} URLs checked`,
    );
    for (const p of treeProblems(reactProbe, (u) => shortUrl(u, cdnUrl))) {
      console.log(`CONTRACT (React) ${p}`);
    }
    bootMs = (await page.evaluate(() => window.__compat.boot)).coldStartMs;

    for (const c of cases) {
      const { timing, contract } = await probeCase(c, cdnUrl, probe, probed);
      let result: CaseResult;
      if (timing.error !== null) {
        result = {
          case: c,
          pass: false,
          reason: timing.error,
          known: knownFailureOn(c, cdnUrl),
          cdn: timing,
          contract,
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
            known: reason === null ? null : knownFailureOn(c, cdnUrl),
            cdn: timing,
            contract,
            buildMs: report.buildMs,
            readyMs: report.readyMs,
            consoleErrors: state.consoleErrors,
          };
        } catch (e) {
          result = {
            case: c,
            pass: false,
            reason: `harness error: ${e instanceof Error ? e.message : String(e)}`,
            known: knownFailureOn(c, cdnUrl),
            cdn: timing,
            contract,
            buildMs: 0,
            readyMs: 0,
            consoleErrors: [],
          };
        }
      }
      results.push(result);
      const t = `first ${timing.coldMs.toFixed(0)} ms / second ${timing.warmMs.toFixed(1)} ms`;
      const contractText =
        contract.problems.length > 0
          ? `\n     contract: ${contract.problems.slice(0, 3).join(' | ')}`
          : '';
      const verdict = result.pass ? 'PASS' : result.known !== null ? 'FAIL (known)' : 'FAIL';
      const known = result.known !== null ? `\n     known: ${result.known}` : '';
      console.log(
        `${verdict} ${c.id.padEnd(36)} ${t}, ${String(contract.checked)} URLs checked${result.reason ? `\n     ${result.reason}` : ''}${known}${contractText}`,
      );
    }
    if (pageErrors.length > 0) console.log(`harness page errors: ${pageErrors.join(' | ')}`);
  } finally {
    await browser.close();
    await harness.close();
    if (cdn.own && !keepCache && options.cacheDir === null)
      rmSync(cacheDir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.pass).length;
  const reactProblems = treeProblems(reactProbe, (u) => shortUrl(u, cdnUrl));
  const caseProblems = results.filter((r) => r.contract.problems.length > 0).length;
  const known = results.filter((r) => !r.pass && r.known !== null).length;
  console.log(
    `\n${passed.toString()}/${results.length.toString()} passed (${((100 * passed) / results.length).toFixed(1)}%) against ${cdnUrl}; failures: ${String(results.length - passed - known)} unexpected, ${String(known)} known`,
  );
  console.log(
    `CDN contract: React import map ${reactProblems.length === 0 ? 'ok' : `${String(reactProblems.length)} problems`} (${String(reactProbe.length)} URLs); cases with problems: ${String(caseProblems)}/${String(results.length)}`,
  );
  writeFileSync(
    path.join(outDir, 'results.json'),
    JSON.stringify(
      { cdn, react, reactProbe, probed: [...probed.values()], bootMs, results },
      null,
      2,
    ),
  );
  if (write && !only) {
    const file = resultsFileName(cdn.own ? null : cdnUrl);
    writeFileSync(
      path.join(APP_DIR, 'compat', file),
      renderResults({ cdn, results, react, reactProbe, probedUrls: probed.size, bootMs }),
    );
    console.log(`wrote compat/${file}`);
  }
  // Fail the process (and a CI job) when the R1 exit criterion is not met, or when the
  // import map's React modules would not survive a CDN outage in the browser (T-032).
  if (passed / results.length < 0.9 || reactProblems.length > 0) process.exitCode = 1;
}

await main();
