/**
 * The `jobs` Edge Function's request handler (T-034). Fetch API only, so it runs in Deno
 * (supabase/functions/jobs/index.ts imports the bundle of this file) and in Node for the
 * unit tests.
 *
 *   POST /functions/v1/jobs          x-br-cron-secret: <JOBS_CRON_SECRET>
 *     → 202 {"accepted": true, "run": "<id>"}: the run continues in the background
 *       (EdgeRuntime.waitUntil), so pg_net's request (5 s timeout) never waits for it.
 *   POST /functions/v1/jobs?wait=1   same secret
 *     → 200 with the run's summary when it is over (tests, manual runs).
 *
 * Anything else: 405 (not POST), 401 (no or wrong secret, compared in constant time),
 * 500 (configuration problems: their names, never values). The secret is a capability to
 * start a run, nothing more: a run only processes jobs that are due anyway, so a leaked
 * secret costs function invocations, not data. That is why pg_cron sends it rather than the
 * service role key (supabase/migrations/…_jobs_function.sql).
 */
import { DailyBrowserBudget } from '../budget';
import { BrowserRenderingRenderer } from '../browser-rendering';
import { webpImaging } from '../imaging';
import { createLogger, errorMessage, type Logger } from '../log';
import { WorkerRunner } from '../runner';
import { SupabaseBackend } from '../supabase';
import {
  FunctionConfigError,
  describeFunctionConfig,
  loadFunctionConfig,
  type FunctionConfig,
} from './config';
import { runJobs, type RunSummary } from './run';

export const CRON_SECRET_HEADER = 'x-br-cron-secret';

export interface JobsHandlerOptions {
  env: Record<string, string | undefined>;
  /** `EdgeRuntime.waitUntil`; without it every run is inline. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** One log line (JSON) at a time; default console.log. */
  write?: (line: string) => void;
  fetch?: typeof fetch;
  /** e.g. `deno 2.1.4`, logged with each run. */
  runtime?: string;
}

/** Constant-time comparison of two strings (UTF-8 bytes). */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function runId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** One run with everything it needs (a fresh renderer, so pacing is per run). */
export async function executeRun(
  config: FunctionConfig,
  log: Logger,
  fetchImpl: typeof fetch | undefined,
): Promise<RunSummary> {
  const backend = new SupabaseBackend({
    url: config.supabaseUrl,
    publicUrl: config.publicSupabaseUrl,
    serviceKey: config.serviceKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const renderer = new BrowserRenderingRenderer({
    ...config.browserRendering,
    log,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  const budget = new DailyBrowserBudget(backend, config.budget, log);
  const runner = new WorkerRunner(
    { backend, renderer, imaging: webpImaging, budget, capture: config.capture, log },
    { jobTimeoutMs: config.run.jobTimeoutMs },
  );
  return runJobs(
    { backend, runner, log },
    { windowMs: config.run.windowMs, hardStopMs: config.run.hardStopMs },
  );
}

export function createJobsHandler(opts: JobsHandlerOptions): (req: Request) => Promise<Response> {
  const write =
    opts.write ??
    ((line: string) => {
      console.log(line);
    });
  let loaded: { config: FunctionConfig } | { error: string[] } | null = null;
  const load = () => {
    if (loaded) return loaded;
    try {
      loaded = { config: loadFunctionConfig(opts.env) };
    } catch (e) {
      loaded = { error: e instanceof FunctionConfigError ? e.problems : [errorMessage(e)] };
    }
    return loaded;
  };

  return async (req: Request): Promise<Response> => {
    const bootLog = createLogger({ write, base: { svc: 'jobs-function' } });
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const cfg = load();
    const expected = 'config' in cfg ? cfg.config.cronSecret : (opts.env['JOBS_CRON_SECRET'] ?? '');
    const given = req.headers.get(CRON_SECRET_HEADER) ?? '';
    if (!expected || !sameSecret(given, expected)) {
      bootLog.warn('run.unauthorized');
      return json(401, { error: 'unauthorized' });
    }
    if ('error' in cfg) {
      bootLog.error('run.bad_config', { problems: cfg.error });
      return json(500, { error: 'configuration', problems: cfg.error });
    }
    const config = cfg.config;
    const id = runId();
    const log = createLogger({
      level: config.logLevel,
      write,
      base: { svc: 'jobs-function', run: id },
    });
    const inline = new URL(req.url).searchParams.get('wait') === '1' || !opts.waitUntil;
    const work = (async () => {
      log.info('run.start', {
        ...describeFunctionConfig(config),
        mode: inline ? 'inline' : 'background',
        ...(opts.runtime ? { runtime: opts.runtime } : {}),
      });
      try {
        const summary = await executeRun(config, log, opts.fetch);
        log.info('run.end', {
          ms: summary.ms,
          stoppedBy: summary.stoppedBy,
          hardStopped: summary.hardStopped,
          jobs: summary.jobs.length,
          results: summary.jobs.map((j) => `${j.kind}:${j.result}`),
        });
        return summary;
      } catch (e) {
        log.error('run.crashed', { error: errorMessage(e) });
        throw e;
      }
    })();
    if (inline) {
      try {
        return json(200, { run: id, ...(await work) });
      } catch (e) {
        return json(500, { run: id, error: errorMessage(e) });
      }
    }
    opts.waitUntil?.(work.catch(() => undefined));
    return json(202, { accepted: true, run: id });
  };
}
