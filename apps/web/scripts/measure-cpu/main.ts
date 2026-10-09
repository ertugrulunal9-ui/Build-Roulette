/**
 * CPU time per request on the local Cloudflare runtime (T-033, docs/08-free-tier.md §1),
 * against the 10 ms CPU limit of Workers Free. Since T-037 the app is a static site on
 * Cloudflare Pages; since T-038 one Pages Function runs for `/battles/*` (the link previews,
 * `out/_worker.js`, limited by `out/_routes.json`). This measures what `wrangler pages dev`
 * runs per request: the Function on its cases (a public battle with a screenshot, one whose
 * rank 1 was taken down, an unknown id, a malformed id, Supabase slow and Supabase down), and
 * a few static paths, which must not run it at all (production serves them without any
 * Worker). Each request is measured warm and in a fresh isolate (a restart of workerd), with
 * the method check on a known Worker (calibrate.ts).
 *
 *   pnpm --filter @br/web build             # the static export in out/, with the Function
 *   npx -y supabase@2.119.0 start -x …      # the local stack (docs/WORKFLOW.md)
 *   pnpm --filter @br/web measure:cpu [--warm 40] [--cold 20] [--only <regex>]
 *                                     [--skip-calibration] [--sampling-us 100] [--out cpu-results]
 *
 * The battles are inserted into the local stack (fixtures.ts). Supabase slow and down run on a
 * variant of the site whose Function points at a stand-in that hangs or refuses connections
 * (scripts/preview-variant.ts). Half of the samples are profiled (the isolate CPU), the other
 * half are not (the workerd thread's CPU, an upper bound).
 *
 * Writes `cpu-results/<timestamp>/samples.jsonl` (every sample), `summary.csv` and
 * `summary.md` (median/p95 per scenario and the method check), and prints the table.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MockSupabase, writePreviewVariant, type SupabaseOutage } from '../preview-variant';
import { calibrate, calibrationTable } from './calibrate';
import { Fixtures, type StackEnv } from './fixtures';
import { fmt, stats } from './profile';
import { RuntimeReloaded, WorkersRuntime, type Measurement, type RequestSpec } from './runtime';

const webDir = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const { values: argv } = parseArgs({
  options: {
    warm: { type: 'string', default: '40' },
    cold: { type: 'string', default: '20' },
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
  /** `site`: the build in out/. `outage`: the variant whose Supabase is down this way. */
  site: 'site' | { outage: SupabaseOutage };
  /** The request of one sample (for a cold sample it is built BEFORE the restart). */
  next: () => RequestSpec;
  /** Accepted statuses (a sample that does not match is reported and kept out of the stats). */
  expect: number[];
  /** The Function's `x-br-preview` (its case), or '' when the Function must not run. */
  preview: string;
}

if (!existsSync(`${webDir}out/index.html`) || !existsSync(`${webDir}out/_worker.js`)) {
  throw new Error('No static export with the Function: run `pnpm --filter @br/web build` first.');
}
/** A content-hashed JS chunk of the home page (an asset under /_next/static/). */
const chunk =
  /<script src="(\/_next\/static\/chunks\/[^"]+\.js)"/.exec(
    readFileSync(`${webDir}out/index.html`, 'utf8'),
  )?.[1] ?? '/_next/static/missing.js';

/** Battles inserted for the Function's scenarios (set up before measuring). */
const battles = { shot: '', removed: '' };
const NEVER_PUBLIC = '00000000-0000-4000-8000-000000000038';

const scenarios: Scenario[] = [
  {
    id: 'preview-shot',
    label: '`/battles/[id]`: settled battle, rank-1 PNG screenshot (4 builds)',
    site: 'site',
    next: () => ({ path: `/battles/${battles.shot}` }),
    expect: [200],
    preview: 'battle',
  },
  {
    id: 'preview-removed',
    label: '`/battles/[id]`: settled battle, rank 1 taken down (static card)',
    site: 'site',
    next: () => ({ path: `/battles/${battles.removed}` }),
    expect: [200],
    preview: 'battle',
  },
  {
    id: 'preview-unknown',
    label: '`/battles/<unknown id>` (404 from Supabase)',
    site: 'site',
    next: () => ({ path: `/battles/${randomUUID()}` }),
    expect: [404],
    preview: 'not-found',
  },
  {
    id: 'preview-malformed',
    label: '`/battles/<malformed id>` (404, no Supabase call)',
    site: 'site',
    next: () => ({ path: '/battles/not-a-battle-id' }),
    expect: [404],
    preview: 'malformed',
  },
  {
    id: 'preview-slow',
    label: '`/battles/[id]`, Supabase hangs (1.5 s timeout, fail open)',
    site: { outage: 'hang' },
    next: () => ({ path: `/battles/${NEVER_PUBLIC}` }),
    expect: [200],
    preview: 'fail-open; reason=timeout',
  },
  {
    id: 'preview-down',
    label: '`/battles/[id]`, Supabase refuses connections (fail open)',
    site: { outage: 'refuse' },
    next: () => ({ path: `/battles/${NEVER_PUBLIC}` }),
    expect: [200],
    preview: 'fail-open; reason=error',
  },
  {
    id: 'home',
    label: '/ (static page; no Function)',
    site: 'site',
    next: () => ({ path: '/' }),
    expect: [200],
    preview: '',
  },
  {
    id: 'room-shell',
    label: '/r/[code] (shell through `_redirects`; no Function)',
    site: 'site',
    next: () => ({ path: '/r/K7QXM' }),
    expect: [200],
    preview: '',
  },
  {
    id: 'asset',
    label: '/_next/static/… (a JS chunk; no Function)',
    site: 'site',
    next: () => ({ path: chunk }),
    expect: [200],
    preview: '',
  },
  {
    id: 'not-found',
    label: '/<unknown path> (404.html; no Function)',
    site: 'site',
    next: () => ({ path: '/nope' }),
    expect: [404],
    preview: '',
  },
];
const selected = scenarios.filter((s) => !only || only.test(s.id));

// ─── Data ───────────────────────────────────────────────────────────────────────
/** API_URL, ANON_KEY, DB_URL from the environment or `supabase status -o env`. */
function stackEnv(): StackEnv {
  const env: Record<string, string> = {};
  const out = execFileSync('npx', ['-y', 'supabase@2.119.0', 'status', '-o', 'env'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m?.[1] && m[2]) env[m[1]] = m[2];
  }
  const pick = (k: keyof StackEnv) => {
    const v = process.env[k] ?? env[k];
    if (!v) throw new Error(`${k} not found: is the local Supabase stack running?`);
    return v;
  };
  return { API_URL: pick('API_URL'), ANON_KEY: pick('ANON_KEY'), DB_URL: pick('DB_URL') };
}

async function insertBattles(): Promise<void> {
  if (!selected.some((s) => s.id === 'preview-shot' || s.id === 'preview-removed')) return;
  const fx = new Fixtures(stackEnv());
  battles.shot = (await fx.battle({ players: 4, screenshot: 'png' })).battle;
  const removed = await fx.battle({ players: 4, screenshot: 'png' });
  const top = removed.builds[0];
  if (!top) throw new Error('fixture without builds');
  fx.takeDown(top.build);
  battles.removed = removed.battle;
  log(`battles: with a screenshot ${battles.shot}, rank 1 taken down ${battles.removed}`);
}

// ─── Samples ────────────────────────────────────────────────────────────────────
interface Sample {
  scenario: string;
  isolate: 'warm' | 'cold';
  profiled: boolean;
  ok: boolean;
  status: number;
  preview: string;
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
    ok: s.expect.includes(m.status) && m.preview === s.preview,
    status: m.status,
    preview: m.preview,
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
    `${isolate.padEnd(4)} ${s.id.padEnd(17)} ${String(m.status)} ${cpu}thread ${fmt(sample.threadMs)} ms, wall ${fmt(sample.wallMs)} ms${sample.ok ? '' : `  (UNEXPECTED: x-br-preview "${m.preview}"; kept out of the stats)`}`,
  );
}

// ─── Measurement ────────────────────────────────────────────────────────────────
const running: WorkersRuntime[] = [];
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all(running.map((r) => r.stop())).finally(() => process.exit(130));
  });
}

async function measure(rt: WorkersRuntime, list: Scenario[]): Promise<void> {
  running.push(rt);
  try {
    await rt.start();
    // Warm: one unmeasured request of the scenario first, then alternate profiled/not.
    for (const s of list) {
      await rt.request(s.next());
      for (let i = 0; i < WARM; i++) {
        const profiled = i % 2 === 0;
        try {
          record(s, 'warm', profiled, await rt.measure(s.next(), profiled));
        } catch (e) {
          if (!(e instanceof RuntimeReloaded)) throw e;
          log(`workerd restarted under ${s.id}: sample dropped`);
          await rt.restart();
          i--;
        }
      }
    }
    // Cold: a fresh isolate for every sample.
    for (const s of list) {
      for (let i = 0; i < COLD; i++) {
        const spec = s.next();
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

async function measureSite(): Promise<void> {
  const list = selected.filter((s) => s.site === 'site');
  if (list.length === 0) return;
  await measure(
    new WorkersRuntime({
      kind: 'pages',
      port: 8797,
      inspectorPort: 9297,
      samplingUs: SAMPLING_US,
      logFile: `${outDir}/wrangler.log`,
    }),
    list,
  );
}

async function measureOutages(): Promise<void> {
  const list = selected.filter((s) => s.site !== 'site');
  if (list.length === 0) return;
  const mock = new MockSupabase();
  await mock.start();
  const dir = `${outDir}/site-outage`;
  await writePreviewVariant(dir, mock.url);
  log(`outage variant in ${dir}, Supabase stand-in ${mock.url}`);
  try {
    for (const s of list) {
      if (s.site === 'site') continue;
      await mock.setMode(s.site.outage);
      await measure(
        new WorkersRuntime({
          kind: 'pages',
          dir,
          port: 8796,
          inspectorPort: 9296,
          samplingUs: SAMPLING_US,
          logFile: `${outDir}/wrangler-outage.log`,
        }),
        [s],
      );
    }
  } finally {
    await mock.stop();
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
    'wall warm (median)',
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
    const wall = fmt(cell(pick('warm'), (x) => x.wallMs).median);
    rows.push([s.label, iso('warm'), iso('cold'), `${thr('warm')} / ${thr('cold')}`, wall]);
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
    process.exitCode = 1;
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
await insertBattles();
await measureSite();
await measureOutages();
summarize(calibration);
