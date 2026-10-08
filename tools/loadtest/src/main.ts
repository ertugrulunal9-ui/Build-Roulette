/**
 * The load test coordinator (T-025):
 *
 *   pnpm --filter @br/loadtest smoke                 # 3 rooms × 4 players, a few minutes
 *   pnpm --filter @br/loadtest loadtest --profile full
 *   pnpm --filter @br/loadtest loadtest --rooms 20 --players 8 --battles-per-room 2
 *
 * Needs the local Supabase stack WITH Realtime (see supabase/README.md), Docker (for
 * docker stats), Playwright Chromium (the capture worker) and `pnpm install`. Writes
 * `<out-dir>/<run id>/report.{json,md}` (default out-dir: tools/loadtest/loadtest-results).
 *
 * Steps: Realtime tenant quotas (optional) → capture services → samplers (DB every 5 s,
 * docker stats, load average) → N forked generator processes → drain the capture/destroy
 * queues → event timestamps, rows, pg_stat_statements → report.
 */
import { fork } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { HELP, parseArgs, UsageError, type LoadConfig } from './config';
import {
  captureOutcomes,
  databaseSize,
  eventTimes,
  openDb,
  resetStatements,
  rowsPerBattle,
  sampleDb,
  screenshotBytes,
  topStatements,
  type DbSample,
} from './db';
import { DockerSampler } from './docker';
import { raiseGatewayConnections } from './gateway';
import { adminDbUrl, loadStackEnv } from './env';
import type { RawMetrics } from './metrics';
import { sleep } from './player';
import { PLAN_LIMITS, RealtimeTenant, type TenantLimits } from './realtime-tenant';
import { buildReport, renderMarkdown } from './report';
import { CaptureServices } from './services';
import type { ShardMessage, ShardTask } from './worker';

/** Host CPU counters from /proc/stat (Linux): idle includes iowait. */
function procStat(): { idle: number; total: number } | null {
  try {
    const line = readFileSync('/proc/stat', 'utf8').split('\n')[0] ?? '';
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    const total = n.reduce((a, b) => a + b, 0);
    return { idle: (n[3] ?? 0) + (n[4] ?? 0), total };
  } catch {
    return null;
  }
}

const log = (msg: string) => {
  process.stdout.write(`[loadtest ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
};

function runShardProcess(task: ShardTask): Promise<RawMetrics> {
  const workerPath = fileURLToPath(new URL('./worker.ts', import.meta.url));
  const child = fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  return new Promise((resolvePromise, reject) => {
    let done = false;
    child.on('message', (m: ShardMessage) => {
      if (m.type === 'log')
        process.stdout.write(`[loadtest ${new Date().toISOString().slice(11, 19)}] ${m.msg}\n`);
      else if (m.type === 'done') {
        done = true;
        resolvePromise(m.metrics);
      } else {
        done = true;
        reject(new Error(`generator process ${String(task.proc)} failed: ${m.error}`));
      }
    });
    child.on('exit', (code) => {
      if (!done)
        reject(new Error(`generator process ${String(task.proc)} exited (${String(code)})`));
    });
    child.send(task);
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  if (argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  let cfg: LoadConfig;
  try {
    cfg = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${HELP}`);
      return 2;
    }
    throw e;
  }
  const env = loadStackEnv();
  const runId =
    `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${cfg.profile}`.toLowerCase();
  const outDir = resolve(cfg.outDir, runId);
  mkdirSync(outDir, { recursive: true });
  const notes: string[] = [];
  log(
    `run ${runId}: ${String(cfg.rooms)} rooms × ${String(cfg.players)} players × ${String(cfg.battlesPerRoom)} battles, ${String(cfg.procs)} process(es) → ${outDir}`,
  );

  const ping = await fetch(`${env.API_URL}/realtime/v1/api/ping`).then(
    (r) => r.ok,
    () => false,
  );
  if (!ping) throw new Error('Realtime is not running: start the stack WITH realtime');

  if (cfg.gatewayConnections > 0) {
    try {
      const note = await raiseGatewayConnections(cfg.gatewayConnections);
      notes.push(note);
      log(note);
    } catch (e) {
      notes.push(`Could not raise the gateway's worker_connections: ${(e as Error).message}`);
    }
  }

  // Realtime tenant quotas.
  const tenant = new RealtimeTenant(env.API_URL, env.JWT_SECRET);
  let before: TenantLimits | null = null;
  let applied: TenantLimits | null = null;
  try {
    before = await tenant.get();
    if (cfg.realtimeLimits !== 'keep') {
      applied = PLAN_LIMITS[cfg.realtimeLimits];
      await tenant.set(applied);
      log(`Realtime tenant quotas set to "${cfg.realtimeLimits}": ${JSON.stringify(applied)}`);
      await sleep(2000);
    } else {
      applied = before;
    }
    if (cfg.realtimeDbPool > 0) {
      await tenant.setDbPool(cfg.realtimeDbPool);
      const note = `Realtime authorization pool (db_pool) set to ${String(cfg.realtimeDbPool)} for this run (local default: 1).`;
      notes.push(note);
      log(note);
      await sleep(2000);
    }
  } catch (e) {
    notes.push(`Realtime tenant API unavailable (${(e as Error).message}); quotas unchanged.`);
  }

  const adminDb = openDb(adminDbUrl(env.DB_URL), 3);
  const startedAt = Date.now();
  const since = new Date(startedAt - 1000);
  const sizeBefore = await databaseSize(adminDb);
  const statementsReset = await resetStatements(adminDb);

  let capture: CaptureServices | null = null;
  if (cfg.capture) {
    capture = new CaptureServices(env, cfg.captureConcurrency, outDir);
    log(`starting capture services (concurrency ${String(cfg.captureConcurrency)})…`);
    await capture.start();
    log('capture worker started');
  }

  const docker = new DockerSampler();
  if (cfg.dockerStats) docker.start();
  const dbSamples: DbSample[] = [];
  const load: number[][] = [];
  const busy: number[] = [];
  let lastStat = procStat();
  const sampler = setInterval(() => {
    load.push(loadavg());
    const stat = procStat();
    if (stat && lastStat && stat.total > lastStat.total) {
      busy.push(
        Math.round((1 - (stat.idle - lastStat.idle) / (stat.total - lastStat.total)) * 1000) / 10,
      );
    }
    lastStat = stat;
    sampleDb(adminDb, since).then(
      (s) => dbSamples.push(s),
      () => undefined,
    );
  }, 5000);
  const progress = setInterval(() => {
    const last = dbSamples[dbSamples.length - 1];
    if (!last) return;
    const q = (last.jobs['capture:queued'] ?? 0) + (last.jobs['capture:running'] ?? 0);
    log(
      `phases ${JSON.stringify(last.phases)} · capture backlog ${String(q)} · load ${loadavg()[0]?.toFixed(2) ?? ''}`,
    );
  }, 15_000);

  // Generator processes: rooms dealt round-robin.
  const t0 = Date.now() + 2000;
  const tasks: ShardTask[] = Array.from({ length: cfg.procs }, (_, p) => ({
    cfg,
    env,
    runId,
    proc: p,
    rooms: Array.from({ length: cfg.rooms }, (_, i) => i).filter((i) => i % cfg.procs === p),
    t0,
  }));
  let shards: RawMetrics[] = [];
  try {
    shards = await Promise.all(tasks.map(runShardProcess));
  } finally {
    clearInterval(progress);
  }
  const roomsDoneAt = Date.now();
  log(`all rooms finished after ${String(Math.round((roomsDoneAt - startedAt) / 1000))} s`);

  // Drain: the capture and destroy jobs of the run.
  // Without the worker nothing drains them.
  const drainUntil = Date.now() + cfg.drainTimeoutS * 1000;
  while (cfg.capture) {
    const s = await sampleDb(adminDb, since);
    const pending = Object.entries(s.jobs)
      .filter(([k]) => k.endsWith(':queued') || k.endsWith(':running'))
      .reduce((a, [, n]) => a + n, 0);
    if (pending === 0) break;
    if (Date.now() > drainUntil) {
      notes.push(
        `Queues not drained after ${String(cfg.drainTimeoutS)} s: ${JSON.stringify(s.jobs)}`,
      );
      break;
    }
    await sleep(2000);
  }
  clearInterval(sampler);
  dbSamples.push(await sampleDb(adminDb, since));
  await docker.stop();

  const battles = shards.flatMap((s) => s.battles);
  const battleIds = battles.map((b) => b.battleId);
  const roomIds = [...new Set(battles.map((b) => b.roomId))];
  const events = await eventTimes(adminDb, battleIds, roomIds);
  const rows = await rowsPerBattle(adminDb, battleIds, roomIds);
  const shots = await screenshotBytes(adminDb, battleIds);
  const outcomes = await captureOutcomes(adminDb, battleIds);
  const statements = await topStatements(adminDb, 20);
  const sizeAfter = await databaseSize(adminDb);
  await adminDb.end();
  if (capture) await capture.stop();
  if (cfg.realtimeDbPool > 0) {
    await tenant.setDbPool(1).catch(() => {
      notes.push('Could not restore the Realtime db_pool.');
    });
  }
  if (before && cfg.realtimeLimits !== 'keep') {
    await tenant.set(before).catch(() => {
      notes.push('Could not restore the Realtime tenant quotas.');
    });
  }
  notes.push(
    'Everything ran on one machine: the generator, the Supabase containers and the capture worker share the host clock (no offset correction applied; the measured client − server offset is reported) and its CPUs.',
  );

  const endedAt = Date.now();
  const report = buildReport({
    runId,
    cfg,
    startedAt,
    endedAt,
    shards,
    events,
    dbSamples,
    docker: docker.samples,
    dockerAvailable: cfg.dockerStats && docker.available && docker.samples.length > 0,
    capture: capture?.parsed ?? null,
    captureOutcomes: outcomes,
    rowsPerBattle: rows,
    screenshotBytes: shots,
    dbSizeBytes: { before: sizeBefore, after: sizeAfter },
    statements,
    statementsReset,
    realtimeLimits: { before, applied },
    host: {
      cpus: cpus().length,
      memGiB: totalmem() / 2 ** 30,
      node: process.version,
      loadAvg: load,
      cpuBusyPct: busy,
    },
    notes,
  });
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 1));
  // The raw receipts and event times, to re-analyse propagation without a new run.
  writeFileSync(
    join(outDir, 'receipts.json.gz'),
    gzipSync(JSON.stringify({ events, receipts: shards.map((s) => s.receipts) })),
  );
  writeFileSync(join(outDir, 'report.md'), renderMarkdown(report));
  const v = report.propagation.verdict;
  log(`report: ${join(outDir, 'report.md')}`);
  log(
    `battles ${JSON.stringify(report.battles.byOutcome)} · phase propagation p50 ${String(report.propagation.battlePhaseMs.p50)} ms, p95 ${String(v.p95Ms)} ms → M5 criterion ${v.met ? 'MET' : 'NOT MET'} · deliveries ${String(report.propagation.deliveries.ratio * 100)} % · errors ${JSON.stringify(report.errors.byCall)}`,
  );
  const ok = battles.length > 0 && battles.every((b) => b.outcome === 'destroyed');
  if (!ok) log('FAIL: not every battle reached DESTROYED');
  return ok ? 0 : 1;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (e: unknown) => {
    process.stderr.write(`loadtest: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  },
);
