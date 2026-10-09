/**
 * CPU time per request of the web app (T-033, docs/08-free-tier.md §1): every route class on
 * workerd (the OpenNext build under `wrangler dev`, like `cf:preview`), in a fresh isolate
 * ("cold": the first request after workerd started) and in a warm one, cross-checked on Node
 * (`next start`). Against the Workers Free limit of 10 ms CPU per request.
 *
 *   pnpm --filter @br/web cf:build          # the Worker (and the .next build next start uses)
 *   npx -y supabase@2.119.0 start -x …      # the local stack (docs/WORKFLOW.md)
 *   pnpm --filter @br/web measure:cpu [--warm 20] [--cold 6] [--node-warm 10] [--node-cold 3]
 *                                     [--only <regex>] [--skip-node] [--skip-workers]
 *                                     [--skip-startup] [--skip-calibration]
 *                                     [--sampling-us 100] [--out cpu-results]
 *
 * Writes `cpu-results/<timestamp>/samples.jsonl` (every sample), `summary.csv` and
 * `summary.md` (median/p95 per scenario, the method check of calibrate.ts, the startup
 * profile), and prints the table. Fixtures (battles, players,
 * reports, an admin) are inserted into the local database and committed.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { calibrate, calibrationTable } from './calibrate';
import {
  Fixtures,
  adminCookie,
  type AdminTokens,
  type BattleFixture,
  type StackEnv,
} from './fixtures';
import { fmt, stats } from './profile';
import {
  NodeRuntime,
  RuntimeReloaded,
  WorkersRuntime,
  type Measurement,
  type RequestSpec,
} from './runtime';

const webDir = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const { values: argv } = parseArgs({
  options: {
    warm: { type: 'string', default: '20' },
    cold: { type: 'string', default: '6' },
    'node-warm': { type: 'string', default: '10' },
    'node-cold': { type: 'string', default: '3' },
    only: { type: 'string' },
    'skip-node': { type: 'boolean', default: false },
    'skip-workers': { type: 'boolean', default: false },
    'skip-startup': { type: 'boolean', default: false },
    'skip-calibration': { type: 'boolean', default: false },
    'sampling-us': { type: 'string', default: '100' },
    out: { type: 'string', default: 'cpu-results' },
  },
});
const WARM = Number(argv.warm);
const COLD = Number(argv.cold);
const NODE_WARM = Number(argv['node-warm']);
const NODE_COLD = Number(argv['node-cold']);
const SAMPLING_US = Number(argv['sampling-us']);
const only = argv.only ? new RegExp(argv.only) : null;

const outDir = `${webDir}${argv.out}/${new Date().toISOString().replace(/[:.]/g, '-')}`;
mkdirSync(outDir, { recursive: true });
const samplesFile = `${outDir}/samples.jsonl`;

function log(msg: string): void {
  process.stdout.write(`[measure-cpu] ${msg}\n`);
}

// ─── The local stack ────────────────────────────────────────────────────────────
function stackEnv(): StackEnv & { SERVICE_ROLE_KEY: string } {
  const out = execFileSync('npx', ['-y', 'supabase@2.119.0', 'status', '-o', 'env'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const found: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m?.[1] && m[2]) found[m[1]] = m[2];
  }
  const { API_URL, ANON_KEY, DB_URL, SERVICE_ROLE_KEY } = found;
  if (!API_URL || !ANON_KEY || !DB_URL || !SERVICE_ROLE_KEY) {
    throw new Error('The local Supabase stack is not running (see docs/WORKFLOW.md).');
  }
  return { API_URL, ANON_KEY, DB_URL, SERVICE_ROLE_KEY };
}

const env = stackEnv();
// e2e/stack.ts (used by the fixtures) reads these.
Object.assign(process.env, env);
const fx = new Fixtures(env);

// ─── Scenarios ──────────────────────────────────────────────────────────────────
type Server = Pick<WorkersRuntime, 'request'>;

interface Ctx {
  server: Server;
  runtime: 'workers' | 'node';
}

interface Scenario {
  id: string;
  /** The row of the summary table. */
  label: string;
  /** Route class, for grouping in the doc. */
  route: string;
  /**
   * The request of one sample. May prime the server (unmeasured requests); for a cold sample
   * it runs on the runtime BEFORE the restart, so the fresh isolate stays fresh.
   */
  next: (ctx: Ctx) => Promise<RequestSpec>;
  /** Accepted answers (a sample that does not match is reported and kept out of the stats). */
  expect: { status: number[]; cache?: string[] };
  /** Extra wait inside the measurement (e.g. the takedown's `after()` 10 s later). */
  holdMs?: number;
  /** Fewer samples for slow scenarios. */
  maxWarm?: number;
  maxCold?: number;
  /** Not on Node (e.g. a Workers-only header). */
  workersOnly?: boolean;
  /** After a measured sample (e.g. rotate the admin tokens from Set-Cookie). */
  after?: (m: Measurement) => void;
}

const ADMIN_EMAIL = `cpu-${String(Date.now())}@measure.local`;
const ADMIN_PASSWORD = `pw-${randomUUID().slice(0, 12)}-Aa1`;
let tokens: AdminTokens | null = null;
const adminHeaders = () => {
  if (!tokens) throw new Error('admin not signed in');
  return { cookie: adminCookie(tokens) };
};

/** A settled battle cached (HIT) on the current server. */
async function primed(ctx: Ctx, path: string, headers: Record<string, string> = {}) {
  for (let i = 0; i < 20; i++) {
    const r = await ctx.server.request({ path, headers });
    if (r.cache === 'HIT') return;
    await sleep(250);
  }
  throw new Error(`${path} never became a cache HIT`);
}

let shared: {
  hit: BattleFixture;
  user: string;
  lookup: BattleFixture;
  partner: string[];
} | null = null;

async function sharedFixtures() {
  if (shared) return shared;
  const partner = fx.players(1);
  const user = fx.players(1)[0] ?? '';
  // A history page of 10 battles (one page).
  for (let i = 0; i < 10; i++) await fx.battle({ users: [user, ...partner] });
  shared = {
    hit: await fx.battle({ players: 4, screenshot: 'png' }),
    user,
    lookup: await fx.battle({ players: 4 }),
    partner,
  };
  return shared;
}

/**
 * The server actions of a page by the test id of a control in their form
 * (`$ACTION_ID_<id>` inputs; e.g. `admin-dismiss`, `admin-take-down-confirm`).
 */
function actionIds(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const form of html.matchAll(/<form[^>]*>([\s\S]*?)<\/form>/g)) {
    const inner = form[1] ?? '';
    const id = /\$ACTION_ID_([0-9a-f]+)/.exec(inner)?.[1];
    if (!id) continue;
    for (const t of inner.matchAll(/data-testid="([^"]+)"/g)) if (t[1]) out.set(t[1], id);
  }
  return out;
}

/** The router state tree a hydrated page sends with an action (as Chromium sent it). */
function stateTree(segments: string[]): string {
  let node: unknown = ['__PAGE__', {}, null, null, 4096];
  for (const seg of [...segments].reverse()) node = [seg, { children: node }, null, null, 4096];
  return encodeURIComponent(JSON.stringify(['', { children: node }, null, null, 4112]));
}

/**
 * A server action call as React sends it from a hydrated page (captured from Chromium): the
 * `Next-Action` header, the form's fields as `_1_<name>` and `0` = a reference to them.
 */
function actionRequest(
  path: string,
  id: string,
  fields: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): RequestSpec {
  const body = new FormData();
  body.set(`_1_$ACTION_ID_${id}`, '');
  for (const [k, v] of Object.entries(fields)) body.set(`_1_${k}`, v);
  body.set('0', '["$K1"]');
  return {
    path,
    method: 'POST',
    headers: {
      'next-action': id,
      accept: 'text/x-component',
      origin: 'self',
      'next-router-state-tree': stateTree(path.split('/').filter(Boolean)),
      ...extraHeaders,
    },
    body,
  };
}

const actionCache = new Map<string, string>();
/** The id of one action, read from the rendered page (`testId`: a control in its form). */
async function action(ctx: Ctx, testId: string): Promise<string> {
  const cacheKey = `${ctx.runtime}:${testId}`;
  const known = actionCache.get(cacheKey);
  if (known) return known;
  const s = await sharedFixtures();
  const pages =
    testId === 'admin-sign-in-submit'
      ? [{ path: '/admin/sign-in' }]
      : [
          { path: '/admin', headers: adminHeaders() },
          { path: `/admin?q=${s.lookup.battle}`, headers: adminHeaders() },
        ];
  for (const page of pages) {
    const id = actionIds((await ctx.server.request(page)).text).get(testId);
    if (id) {
      actionCache.set(cacheKey, id);
      return id;
    }
  }
  throw new Error(`no action with a ${testId} control`);
}

/** A battle with an open report on its rank-1 build. */
async function reported(): Promise<BattleFixture> {
  const b = await fx.battle({ players: 2 });
  const [top, other] = b.builds;
  if (!top || !other) throw new Error('battle without builds');
  fx.report(top.build, other.user);
  return b;
}

const scenarios: Scenario[] = [
  // Prerendered at build time: cache interception answers from R2 before Next loads.
  {
    id: 'home',
    label: '/ (prerendered)',
    route: '/',
    next: () => Promise.resolve({ path: '/' }),
    expect: { status: [200], cache: ['HIT'] },
  },
  {
    id: 'play',
    label: '/play (prerendered)',
    route: '/play',
    next: () => Promise.resolve({ path: '/play' }),
    expect: { status: [200], cache: ['HIT'] },
  },
  {
    id: 'playground',
    label: '/playground (prerendered)',
    route: '/playground',
    next: () => Promise.resolve({ path: '/playground' }),
    expect: { status: [200], cache: ['HIT'] },
  },
  {
    id: 'icon',
    label: '/icon.svg (static route)',
    route: '/icon.svg',
    next: () => Promise.resolve({ path: '/icon.svg' }),
    expect: { status: [200] },
  },
  // /battles/[id]: ISR.
  {
    id: 'battle-miss',
    label: '/battles/[id] MISS (render, 4 builds)',
    route: '/battles/[id]',
    next: async () => ({
      path: `/battles/${(await fx.battle({ players: 4, screenshot: 'png' })).battle}`,
    }),
    expect: { status: [200], cache: ['MISS'] },
  },
  {
    id: 'battle-miss-8',
    label: '/battles/[id] MISS (render, 8 builds)',
    route: '/battles/[id]',
    next: async () => ({
      path: `/battles/${(await fx.battle({ players: 8, screenshot: 'png' })).battle}`,
    }),
    expect: { status: [200], cache: ['MISS'] },
  },
  {
    id: 'battle-hit',
    label: '/battles/[id] HIT',
    route: '/battles/[id]',
    next: async (ctx) => {
      const path = `/battles/${(await sharedFixtures()).hit.battle}`;
      await primed(ctx, path);
      return { path };
    },
    expect: { status: [200], cache: ['HIT'] },
  },
  {
    id: 'battle-stale',
    label: '/battles/[id] STALE (+ background regeneration)',
    route: '/battles/[id]',
    next: async (ctx) => {
      const path = `/battles/${(await fx.battle({ players: 4, state: 'live' })).battle}`;
      await primed(ctx, path);
      await sleep(5_500);
      return { path };
    },
    expect: { status: [200], cache: ['STALE'] },
    maxWarm: 8,
    maxCold: 4,
  },
  {
    id: 'battle-rsc',
    label: '/battles/[id] RSC (client navigation, cached page)',
    route: '/battles/[id]',
    next: async (ctx) => {
      const path = `/battles/${(await sharedFixtures()).hit.battle}`;
      await primed(ctx, path);
      return { path: `${path}?_rsc=probe`, headers: { rsc: '1' } };
    },
    expect: { status: [200] },
    // next start answers a made-up `_rsc` value with a redirect to the right one.
    workersOnly: true,
  },
  {
    id: 'battle-prefetch',
    label: '/battles/[id] RSC prefetch (a <Link> in view)',
    route: '/battles/[id]',
    next: async (ctx) => {
      const path = `/battles/${(await sharedFixtures()).hit.battle}`;
      await primed(ctx, path);
      return { path: `${path}?_rsc=probe2`, headers: { rsc: '1', 'next-router-prefetch': '1' } };
    },
    expect: { status: [200] },
    workersOnly: true,
  },
  {
    id: 'battle-404',
    label: '/battles/<unknown id> (404, cached 5 s)',
    route: '/battles/[id]',
    next: () => Promise.resolve({ path: `/battles/${randomUUID()}` }),
    expect: { status: [404] },
  },
  {
    id: 'battle-malformed',
    label: '/battles/<malformed id> (404, cached 1 h)',
    route: '/battles/[id]',
    next: async (ctx) => {
      await ctx.server.request({ path: '/battles/not-a-battle' });
      return { path: '/battles/not-a-battle' };
    },
    expect: { status: [404] },
  },
  // The social image: a static asset since T-033 (before: /battles/[id]/opengraph-image,
  // drawn per battle by satori + resvg, ~300 ms; docs/08-free-tier.md §1). In production
  // Cloudflare serves assets without running the Worker; locally they pass the asset router.
  {
    id: 'og-card',
    label: '/og-card.png (static asset)',
    route: 'static assets',
    next: () => Promise.resolve({ path: '/og-card.png' }),
    expect: { status: [200] },
  },
  // /u/[id]: dynamic, its data cached ('use cache').
  {
    id: 'user-miss',
    label: '/u/[id] (10 battles, data MISS)',
    route: '/u/[id]',
    next: async () => {
      const s = await sharedFixtures();
      const user = fx.players(1)[0] ?? '';
      for (let i = 0; i < 10; i++) await fx.battle({ users: [user, ...s.partner] });
      return { path: `/u/${user}` };
    },
    expect: { status: [200] },
    maxWarm: 10,
    maxCold: 4,
  },
  {
    id: 'user-hit',
    label: '/u/[id] (10 battles, data HIT)',
    route: '/u/[id]',
    next: async (ctx) => {
      const path = `/u/${(await sharedFixtures()).user}`;
      await ctx.server.request({ path });
      return { path };
    },
    expect: { status: [200] },
  },
  {
    id: 'user-404',
    label: '/u/<unknown id> (404)',
    route: '/u/[id]',
    next: () => Promise.resolve({ path: `/u/${randomUUID()}` }),
    expect: { status: [404] },
  },
  // Dynamic pages without data.
  // One prerendered page for every room since T-033 (a rewrite to /r).
  {
    id: 'room',
    label: '/r/[code] (prerendered, rewritten to /r)',
    route: '/r/[code]',
    next: () => Promise.resolve({ path: '/r/ABCDE' }),
    expect: { status: [200], cache: ['HIT'] },
  },
  {
    id: 'notfound',
    label: '/<unknown path> (404)',
    route: '404',
    next: () => Promise.resolve({ path: `/no-such-page-${randomUUID().slice(0, 8)}` }),
    expect: { status: [404] },
  },
  // /admin
  {
    id: 'admin-signin',
    label: '/admin/sign-in',
    route: '/admin',
    next: () => Promise.resolve({ path: '/admin/sign-in' }),
    expect: { status: [200] },
  },
  {
    id: 'admin-anon',
    label: '/admin, not signed in (404)',
    route: '/admin',
    next: () => Promise.resolve({ path: '/admin' }),
    expect: { status: [404] },
  },
  {
    id: 'admin-queue',
    label: '/admin (report queue)',
    route: '/admin',
    next: () => Promise.resolve({ path: '/admin', headers: adminHeaders() }),
    expect: { status: [200] },
  },
  {
    id: 'admin-lookup',
    label: '/admin?q=<battle> (event log)',
    route: '/admin',
    next: async () => ({
      path: `/admin?q=${(await sharedFixtures()).lookup.battle}`,
      headers: adminHeaders(),
    }),
    expect: { status: [200] },
  },
  {
    id: 'action-signin',
    label: 'action: sign in',
    route: '/admin actions',
    next: async (ctx) =>
      actionRequest('/admin/sign-in', await action(ctx, 'admin-sign-in-submit'), {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    expect: { status: [200, 303] },
  },
  {
    id: 'action-dismiss',
    label: 'action: dismiss reports',
    route: '/admin actions',
    next: async (ctx) => {
      const id = await action(ctx, 'admin-dismiss');
      const b = await reported();
      return actionRequest(
        '/admin',
        id,
        { build_id: b.builds[0]?.build ?? '', view: 'open', note: '' },
        adminHeaders(),
      );
    },
    expect: { status: [200, 303] },
  },
  {
    id: 'action-takedown',
    label: 'action: take a build down (incl. the re-expiry 10 s later)',
    route: '/admin actions',
    next: async (ctx) => {
      const id = await action(ctx, 'admin-take-down-confirm');
      const b = await reported();
      return actionRequest(
        '/admin',
        id,
        { build_id: b.builds[0]?.build ?? '', view: 'open', note: 'cpu' },
        adminHeaders(),
      );
    },
    expect: { status: [200, 303] },
    holdMs: 10_500,
    maxWarm: 6,
    maxCold: 4,
  },
  {
    id: 'action-refresh',
    label: 'action: refresh public copies',
    route: '/admin actions',
    next: async (ctx) => {
      const id = await action(ctx, 'admin-refresh-copies');
      const s = await sharedFixtures();
      return actionRequest('/admin', id, { battle_id: s.lookup.battle }, adminHeaders());
    },
    expect: { status: [200, 303] },
    holdMs: 10_500,
    maxWarm: 6,
    maxCold: 4,
  },
  {
    id: 'admin-session',
    label: '/admin/session (route handler: token refresh)',
    route: '/admin',
    next: async () => {
      // Each refresh rotates the refresh token: sign in afresh for every sample.
      tokens = await fx.signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
      return { path: '/admin/session?next=/admin', headers: adminHeaders() };
    },
    expect: { status: [303] },
  },
];

const selected = scenarios.filter((s) => !only || only.test(s.id));

// ─── Samples ────────────────────────────────────────────────────────────────────
interface Sample {
  scenario: string;
  runtime: 'workers' | 'node';
  isolate: 'cold' | 'warm';
  profiled: boolean;
  ok: boolean;
  status: number;
  cache: string;
  bytes: number;
  wallMs: number;
  /** Workers: the app isolate's CPU (profile). */
  isolateMs: number | null;
  gcMs: number | null;
  samplingUs: number | null;
  gaps: number | null;
  /** Workers: workerd main thread. Node: main thread to settled. */
  threadMs: number;
  /** Node: main thread until the response finished. */
  toFinishMs: number | null;
  /** Workers, cold: the main thread's CPU while workerd started (global scope + local runtime). */
  startupThreadMs: number | null;
}

const all: Sample[] = [];

function record(
  s: Scenario,
  runtime: Sample['runtime'],
  isolate: Sample['isolate'],
  profiled: boolean,
  m: Measurement,
  startupThreadMs: number | null,
): void {
  const ok =
    s.expect.status.includes(m.status) &&
    (runtime === 'node' || !s.expect.cache || s.expect.cache.includes(m.cache));
  const sample: Sample = {
    scenario: s.id,
    runtime,
    isolate,
    profiled,
    ok,
    status: m.status,
    cache: m.cache,
    bytes: m.bytes,
    wallMs: round(m.wallMs),
    isolateMs: m.isolate ? round(m.isolate.cpuMs) : null,
    gcMs: m.isolate ? round(m.isolate.gcMs) : null,
    samplingUs: m.isolate ? m.isolate.intervalUs : null,
    gaps: m.isolate ? m.isolate.gaps : null,
    threadMs: round(m.threadMs),
    toFinishMs: m.toFinishMs === null ? null : round(m.toFinishMs),
    startupThreadMs: startupThreadMs === null ? null : round(startupThreadMs),
  };
  all.push(sample);
  appendFileSync(samplesFile, `${JSON.stringify(sample)}\n`);
  const cpu = sample.isolateMs !== null ? `isolate ${fmt(sample.isolateMs)} ms, ` : '';
  log(
    `${runtime} ${isolate.padEnd(4)} ${s.id.padEnd(16)} ${String(m.status)} ${m.cache.padEnd(5)} ${cpu}thread ${fmt(sample.threadMs)} ms, wall ${fmt(sample.wallMs)} ms${ok ? '' : '  (UNEXPECTED: kept out of the stats)'}`,
  );
  s.after?.(m);
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

async function hold(s: Scenario): Promise<void> {
  if (s.holdMs) await sleep(s.holdMs);
}

// ─── Workers ────────────────────────────────────────────────────────────────────
async function measureWorkers(): Promise<void> {
  if (!existsSync(`${webDir}.open-next/worker.js`)) {
    throw new Error('No OpenNext build: run `pnpm --filter @br/web cf:build` first.');
  }
  log('populating the local incremental cache (prerendered pages)…');
  execFileSync(
    process.execPath,
    ['node_modules/@opennextjs/cloudflare/dist/cli/index.js', 'populateCache', 'local'],
    { cwd: webDir, stdio: 'ignore', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  const rt = new WorkersRuntime({
    port: 8797,
    inspectorPort: 9297,
    samplingUs: SAMPLING_US,
    logFile: `${outDir}/wrangler.log`,
  });
  const ctx: Ctx = { server: rt, runtime: 'workers' };
  running.push(rt);
  try {
    await rt.start();
    // Warm: one unmeasured request of the scenario first, then alternate profiled/not.
    for (const s of selected) {
      const n = Math.min(WARM, s.maxWarm ?? WARM);
      await rt.request(await s.next(ctx));
      await hold(s);
      for (let i = 0; i < n; i++) {
        const spec = await s.next(ctx);
        const profiled = i % 2 === 0;
        try {
          const m = await measureHeld(rt, spec, profiled, s);
          record(s, 'workers', 'warm', profiled, m, null);
        } catch (e) {
          if (!(e instanceof RuntimeReloaded)) throw e;
          log(`workerd restarted under ${s.id} (a watched file changed): sample dropped`);
          await rt.restart();
          await rt.request(await s.next(ctx));
          i--;
        }
      }
    }
    // Cold: a fresh isolate for every sample.
    for (const s of selected) {
      const n = Math.min(COLD, s.maxCold ?? COLD);
      for (let i = 0; i < n; i++) {
        const spec = await s.next(ctx);
        await rt.restart();
        const profiled = i % 2 === 0;
        try {
          const m = await measureHeld(rt, spec, profiled, s);
          record(s, 'workers', 'cold', profiled, m, rt.startupThreadMs);
        } catch (e) {
          if (!(e instanceof RuntimeReloaded)) throw e;
          log(`workerd restarted under ${s.id} (a watched file changed): sample dropped`);
          i--;
        }
      }
    }
  } finally {
    await rt.stop();
  }
}

function measureHeld(
  rt: WorkersRuntime,
  spec: RequestSpec,
  profiled: boolean,
  s: Scenario,
): Promise<Measurement> {
  return rt.measure(spec, profiled, s.holdMs ?? 0);
}

// ─── Node ───────────────────────────────────────────────────────────────────────
async function measureNode(): Promise<void> {
  if (!existsSync(`${webDir}.next/BUILD_ID`)) {
    throw new Error('No Next build: run `pnpm --filter @br/web cf:build` (or build) first.');
  }
  const rt = new NodeRuntime({ port: 3197, probePort: 3198, logFile: `${outDir}/next.log` });
  const ctx: Ctx = { server: rt, runtime: 'node' };
  const nodeScenarios = selected.filter((s) => !s.workersOnly);
  running.push(rt);
  try {
    await rt.start();
    for (const s of nodeScenarios) {
      const n = Math.min(NODE_WARM, s.maxWarm ?? NODE_WARM);
      await rt.request(await s.next(ctx));
      await hold(s);
      for (let i = 0; i < n; i++) {
        const m = await rt.measure(await s.next(ctx), s.holdMs ?? 0);
        record(s, 'node', 'warm', false, m, null);
      }
    }
    for (const s of nodeScenarios) {
      const n = Math.min(NODE_COLD, s.maxCold ?? NODE_COLD);
      for (let i = 0; i < n; i++) {
        const spec = await s.next(ctx);
        await rt.restart();
        const m = await rt.measure(spec, s.holdMs ?? 0);
        record(s, 'node', 'cold', false, m, null);
      }
    }
  } finally {
    await rt.stop();
  }
}

// ─── Startup (global scope) ─────────────────────────────────────────────────────
function measureStartup(): string {
  log('wrangler check startup (CPU profile of the global scope)…');
  const out = execFileSync(
    process.execPath,
    [
      'node_modules/wrangler/bin/wrangler.js',
      'check',
      'startup',
      '--outfile',
      `${outDir}/startup.cpuprofile`,
    ],
    { cwd: webDir, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } },
  );
  writeFileSync(`${outDir}/startup.txt`, out);
  return out;
}

// ─── Summary ────────────────────────────────────────────────────────────────────
function summarize(startup: string | null, calibration: string | null): void {
  const rows: string[][] = [];
  const csv: string[] = [
    'scenario,label,route,runtime,isolate,metric,n,median_ms,p95_ms,min_ms,max_ms,unexpected',
  ];
  const head = [
    'Scenario',
    'Workers warm: isolate CPU median / p95',
    'Workers cold: isolate CPU median / p95',
    'workerd thread warm / cold (median, unprofiled)',
    'Node warm / cold (median)',
  ];
  for (const s of selected) {
    const pick = (runtime: Sample['runtime'], isolate: Sample['isolate']) =>
      all.filter((x) => x.scenario === s.id && x.runtime === runtime && x.isolate === isolate);
    const cell = (xs: Sample[], f: (x: Sample) => number | null) => {
      const v = xs
        .filter((x) => x.ok)
        .map(f)
        .filter((x): x is number => x !== null);
      return stats(v);
    };
    const groups: [Sample['runtime'], Sample['isolate']][] = [
      ['workers', 'warm'],
      ['workers', 'cold'],
      ['node', 'warm'],
      ['node', 'cold'],
    ];
    for (const [runtime, isolate] of groups) {
      const xs = pick(runtime, isolate);
      if (xs.length === 0) continue;
      const bad = xs.filter((x) => !x.ok).length;
      const metrics: [string, (x: Sample) => number | null, Sample[]][] =
        runtime === 'workers'
          ? [
              ['isolate_cpu', (x) => x.isolateMs, xs.filter((x) => x.profiled)],
              ['thread_cpu_unprofiled', (x) => x.threadMs, xs.filter((x) => !x.profiled)],
              ['thread_cpu_profiled', (x) => x.threadMs, xs.filter((x) => x.profiled)],
              ['wall', (x) => x.wallMs, xs],
            ]
          : [
              ['thread_cpu_settled', (x) => x.threadMs, xs],
              ['thread_cpu_to_finish', (x) => x.toFinishMs, xs],
              ['wall', (x) => x.wallMs, xs],
            ];
      for (const [metric, f, subset] of metrics) {
        const st = cell(subset, f);
        csv.push(
          [
            s.id,
            JSON.stringify(s.label),
            JSON.stringify(s.route),
            runtime,
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
        pick('workers', isolate).filter((x) => x.profiled),
        (x) => x.isolateMs,
      );
      return st.n ? `${fmt(st.median)} / ${fmt(st.p95)} (n=${String(st.n)})` : '–';
    };
    const thr = (isolate: Sample['isolate']) =>
      fmt(
        cell(
          pick('workers', isolate).filter((x) => !x.profiled),
          (x) => x.threadMs,
        ).median,
      );
    const node = (isolate: Sample['isolate']) =>
      fmt(cell(pick('node', isolate), (x) => x.threadMs).median);
    rows.push([
      s.label,
      iso('warm'),
      iso('cold'),
      `${thr('warm')} / ${thr('cold')}`,
      `${node('warm')} / ${node('cold')}`,
    ]);
  }
  const md = [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
  writeFileSync(`${outDir}/summary.csv`, `${csv.join('\n')}\n`);
  writeFileSync(
    `${outDir}/summary.md`,
    `${md}\n\n${calibration ? `Method check:\n\n${calibration}\n\n` : ''}${startup ?? ''}`,
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
// Stop the servers (their own process groups) on Ctrl+C.
const running: { stop: () => Promise<void> }[] = [];
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void Promise.all(running.map((r) => r.stop())).finally(() => process.exit(130));
  });
}

log(`results in ${outDir}`);
log('fixtures: an admin, battles, players…');
tokens = await fx.admin(ADMIN_EMAIL, ADMIN_PASSWORD);
// The report queue holds this run's reports only (earlier runs' are dismissed).
fx.clearReports();
await sharedFixtures();
for (let i = 0; i < 3; i++) await reported();

const startup = argv['skip-startup'] ? null : measureStartup();
let calibration: string | null = null;
if (!argv['skip-calibration']) {
  log('method check on a calibration Worker (calibrate.ts)…');
  calibration = calibrationTable(await calibrate(`${outDir}/calibration`, SAMPLING_US));
}
if (!argv['skip-workers']) await measureWorkers();
if (!argv['skip-node']) await measureNode();
summarize(startup, calibration);
