/**
 * CPU time per request on the local Cloudflare runtime (T-033, docs/08-free-tier.md §1),
 * against the 10 ms CPU limit of Workers Free. Since T-037 the app is a static site on
 * Cloudflare Pages, so this measures what `wrangler pages dev` runs for each request: today
 * (no `functions/` directory) wrangler's shim Worker that hands every request to the asset
 * server, which production does not run at all (static requests invoke no Worker code); with
 * T-038's Pages Function on `/battles/*`, that Function. Each request is measured warm and in a
 * fresh isolate (a restart of workerd), with the method check on a known Worker
 * (calibrate.ts). The Next.js scenarios of T-033 (ISR, server renders, server actions, the
 * `next start` cross-check) are gone with the server; their numbers stay in docs/08 §1.
 *
 *   pnpm --filter @br/web build             # the static export in out/
 *   pnpm --filter @br/web measure:cpu [--warm 20] [--cold 6] [--only <regex>]
 *                                     [--skip-calibration] [--sampling-us 100] [--out cpu-results]
 *
 * Writes `cpu-results/<timestamp>/samples.jsonl` (every sample), `summary.csv` and
 * `summary.md` (median/p95 per scenario and the method check), and prints the table.
 * Scenarios that need data (a battle for T-038's Function) can insert it with fixtures.ts
 * (the local Supabase stack, docs/WORKFLOW.md).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { calibrate, calibrationTable } from './calibrate';
import { fmt, stats } from './profile';
import { RuntimeReloaded, WorkersRuntime, type Measurement, type RequestSpec } from './runtime';

const webDir = fileURLToPath(new URL('../../', import.meta.url));

const { values: argv } = parseArgs({
  options: {
    warm: { type: 'string', default: '20' },
    cold: { type: 'string', default: '6' },
    only: { type: 'string' },
    'skip-calibration': { type: 'boolean', default: false },
    'sampling-us': { type: 'string', default: '100' },
    out: { type: 'string', default: 'cpu-results' },
  },
});
const WARM = Number(argv.warm);
const COLD = Number(argv.cold);
const SAMPLING_US = Number(argv['sampling-us']);
const only = argv.only ? new RegExp(argv.only) : null;

const outDir = `${webDir}${argv.out}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(outDir, { recursive: true });
const samplesFile = `${outDir}/samples.jsonl`;

function log(msg: string): void {
  process.stdout.write(`[measure-cpu] ${msg}\n`);
}

// ─── Scenarios ──────────────────────────────────────────────────────────────────
interface Scenario {
  id: string;
  /** The row of the summary table. */
  label: string;
  /** The request of one sample (for a cold sample it is built BEFORE the restart). */
  next: () => Promise<RequestSpec>;
  /** Accepted statuses (a sample that does not match is reported and kept out of the stats). */
  expect: number[];
}

if (!existsSync(`${webDir}out/index.html`)) {
  throw new Error('No static export: run `pnpm --filter @br/web build` first.');
}
/** A content-hashed JS chunk of the home page (an asset under /_next/static/). */
const chunk =
  /<script src="(\/_next\/static\/chunks\/[^"]+\.js)"/.exec(
    readFileSync(`${webDir}out/index.html`, 'utf8'),
  )?.[1] ?? '/_next/static/missing.js';

const BATTLE = '00000000-0000-4000-8000-000000000037';

const scenarios: Scenario[] = [
  {
    id: 'home',
    label: '/ (static page)',
    next: () => Promise.resolve({ path: '/' }),
    expect: [200],
  },
  {
    id: 'battle-shell',
    label: '/battles/[id] (the shell, through the `_redirects` rewrite)',
    next: () => Promise.resolve({ path: `/battles/${BATTLE}` }),
    expect: [200],
  },
  {
    id: 'room-shell',
    label: '/r/[code] (the shell, through the `_redirects` rewrite)',
    next: () => Promise.resolve({ path: '/r/K7QXM' }),
    expect: [200],
  },
  {
    id: 'asset',
    label: '/_next/static/… (a JS chunk)',
    next: () => Promise.resolve({ path: chunk }),
    expect: [200],
  },
  {
    id: 'og-card',
    label: '/og-card.png (the static social card)',
    next: () => Promise.resolve({ path: '/og-card.png' }),
    expect: [200],
  },
  {
    id: 'not-found',
    label: '/<unknown path> (404.html)',
    next: () => Promise.resolve({ path: '/nope' }),
    expect: [404],
  },
];
const selected = scenarios.filter((s) => !only || only.test(s.id));

// ─── Samples ────────────────────────────────────────────────────────────────────
interface Sample {
  scenario: string;
  isolate: 'warm' | 'cold';
  profiled: boolean;
  ok: boolean;
  status: number;
  bytes: number;
  wallMs: number;
  isolateMs: number | null;
  gcMs: number | null;
  samplingUs: number | null;
  gaps: number | null;
  threadMs: number;
}

const all: Sample[] = [];
const round = (v: number) => Math.round(v * 1000) / 1000;

function record(s: Scenario, isolate: Sample['isolate'], profiled: boolean, m: Measurement) {
  const sample: Sample = {
    scenario: s.id,
    isolate,
    profiled,
    ok: s.expect.includes(m.status),
    status: m.status,
    bytes: m.bytes,
    wallMs: round(m.wallMs),
    isolateMs: m.isolate ? round(m.isolate.cpuMs) : null,
    gcMs: m.isolate ? round(m.isolate.gcMs) : null,
    samplingUs: m.isolate ? m.isolate.intervalUs : null,
    gaps: m.isolate ? m.isolate.gaps : null,
    threadMs: round(m.threadMs),
  };
  all.push(sample);
  appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`);
  const cpu = sample.isolateMs !== null ? `isolate ${fmt(sample.isolateMs)} ms, ` : '';
  log(
    `${isolate.padEnd(4)} ${s.id.padEnd(14)} ${String(m.status)} ${cpu}thread ${fmt(sample.threadMs)} ms, wall ${fmt(sample.wallMs)} ms${sample.ok ? '' : '  (UNEXPECTED: kept out of the stats)'}`,
  );
}

// ─── Measurement ────────────────────────────────────────────────────────────────
const running: WorkersRuntime[] = [];
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all(running.map((r) => r.stop())).finally(() => process.exit(130));
  });
}

async function measurePages(): Promise<void> {
  const rt = new WorkersRuntime({
    kind: 'pages',
    port: 8797,
    inspectorPort: 9297,
    samplingUs: SAMPLING_US,
    logFile: `${outDir}/wrangler.log`,
  });
  running.push(rt);
  try {
    await rt.start();
    // Warm: one unmeasured request of the scenario first, then alternate profiled/not.
    for (const s of selected) {
      await rt.request(await s.next());
      for (let i = 0; i < WARM; i++) {
        const profiled = i % 2 === 0;
        try {
          record(s, 'warm', profiled, await rt.measure(await s.next(), profiled));
        } catch (e) {
          if (!(e instanceof RuntimeReloaded)) throw e;
          log(`workerd restarted under ${s.id}: sample dropped`);
          await rt.restart();
          i--;
        }
      }
    }
    // Cold: a fresh isolate for every sample.
    for (const s of selected) {
      for (let i = 0; i < COLD; i++) {
        const spec = await s.next();
        await rt.restart();
        const profiled = i % 2 === 0;
        try {
          record(s, 'cold', profiled, await rt.measure(spec, profiled));
        } catch (e) {
          if (!(e instanceof RuntimeReloaded)) throw e;
          log(`workerd restarted under ${s.id}: sample dropped`);
          i--;
        }
      }
    }
  } finally {
    await rt.stop();
  }
}

// ─── Summary ────────────────────────────────────────────────────────────────────
function summarize(calibration: string | null): void {
  const csv = ['scenario,label,isolate,metric,n,median_ms,p95_ms,min_ms,max_ms,unexpected'];
  const head = [
    'Request',
    'warm: isolate CPU median / p95',
    'fresh isolate: isolate CPU median / p95',
    'workerd thread warm / fresh (median, unprofiled)',
  ];
  const rows: string[][] = [];
  for (const s of selected) {
    const pick = (isolate: Sample['isolate']) =>
      all.filter((x) => x.scenario === s.id && x.isolate === isolate);
    const cell = (xs: Sample[], f: (x: Sample) => number | null) =>
      stats(
        xs
          .filter((x) => x.ok)
          .map(f)
          .filter((x): x is number => x !== null),
      );
    for (const isolate of ['warm', 'cold'] as const) {
      const xs = pick(isolate);
      const bad = xs.filter((x) => !x.ok).length;
      const metrics: [string, (x: Sample) => number | null, Sample[]][] = [
        ['isolate_cpu', (x) => x.isolateMs, xs.filter((x) => x.profiled)],
        ['thread_cpu_unprofiled', (x) => x.threadMs, xs.filter((x) => !x.profiled)],
        ['wall', (x) => x.wallMs, xs],
      ];
      for (const [metric, f, subset] of metrics) {
        const st = cell(subset, f);
        csv.push(
          [
            s.id,
            JSON.stringify(s.label),
            isolate,
            metric,
            st.n,
            fmt(st.median),
            fmt(st.p95),
            fmt(st.min),
            fmt(st.max),
            bad,
          ].join(','),
        );
      }
    }
    const iso = (isolate: Sample['isolate']) => {
      const st = cell(
        pick(isolate).filter((x) => x.profiled),
        (x) => x.isolateMs,
      );
      return st.n ? `${fmt(st.median)} / ${fmt(st.p95)} (n=${String(st.n)})` : '–';
    };
    const thr = (isolate: Sample['isolate']) =>
      fmt(
        cell(
          pick(isolate).filter((x) => !x.profiled),
          (x) => x.threadMs,
        ).median,
      );
    rows.push([s.label, iso('warm'), iso('cold'), `${thr('warm')} / ${thr('cold')}`]);
  }
  const md = [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
  writeFileSync(`${outDir}/summary.csv`, `${csv.join('\n')}\n`);
  writeFileSync(
    `${outDir}/summary.md`,
    `${md}\n\n${calibration ? `Method check:\n\n${calibration}\n` : ''}`,
  );
  if (calibration) process.stdout.write(`\nMethod check:\n\n${calibration}\n`);
  process.stdout.write(`\n${md}\n\n`);
  const unexpected = all.filter((x) => !x.ok);
  if (unexpected.length > 0) {
    log(`${String(unexpected.length)} unexpected answers (see samples.jsonl, "ok": false)`);
  }
  log(`raw samples: ${samplesFile}`);
  log(`summary:     ${outDir}/summary.csv, summary.md`);
}

// ─── Run ────────────────────────────────────────────────────────────────────────
log(`results in ${outDir}`);
let calibration: string | null = null;
if (!argv['skip-calibration']) {
  log('method check on a calibration Worker (calibrate.ts)…');
  calibration = calibrationTable(await calibrate(`${outDir}/calibration`, SAMPLING_US));
}
await measurePages();
summarize(calibration);
