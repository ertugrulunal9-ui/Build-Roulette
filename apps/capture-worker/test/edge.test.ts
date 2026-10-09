/**
 * The `jobs` Edge Function's own code (T-034): configuration, the run loop and the request
 * handler, in Node with fakes. The function in the real Edge Runtime is
 * integration/function.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Job, JobKind } from '../src/backend';
import {
  FunctionConfigError,
  OPTIONAL,
  describeFunctionConfig,
  loadFunctionConfig,
} from '../src/edge/config';
import { CRON_SECRET_HEADER, createJobsHandler, sameSecret } from '../src/edge/handler';
import { runJobs } from '../src/edge/run';
import { createLogger, silentLogger } from '../src/log';
import type { JobOutcome } from '../src/runner';
import { urlOf } from './fakes';

const ENV = {
  SUPABASE_URL: 'http://kong:8000',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJ.service.key',
  JOBS_CRON_SECRET: 'cron-secret-0123456789abcdef0123456789abcdef',
  CAPTURE_SHELL_URL: 'https://{build}.usercontent.example/v1/capture',
  CAPTURE_HMAC_SECRET: 'hmac-secret-0123456789abcdef0123456789abcdef',
  PKG_CDN_URL: 'https://esm.sh/',
  BROWSER_RENDERING_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  BROWSER_RENDERING_API_TOKEN: 'cf-token-value',
};

describe('loadFunctionConfig', () => {
  it('reads the secrets and fills the free-plan defaults', () => {
    const c = loadFunctionConfig(ENV);
    expect(c.publicSupabaseUrl).toBe('http://kong:8000');
    expect(c.capture).toMatchObject({
      pkgCdnUrl: 'https://esm.sh',
      captureTimeoutMs: 35_000,
      signedUrlTtlSeconds: 120,
      viewport: { width: 1280, height: 800 },
    });
    expect(c.browserRendering).toEqual({
      apiUrl: 'https://api.cloudflare.com/client/v4',
      accountId: ENV.BROWSER_RENDERING_ACCOUNT_ID,
      apiToken: 'cf-token-value',
      minIntervalMs: 10_000,
    });
    expect(c.budget).toEqual({ limitMs: 570_000, reserveMs: 20_000 });
    // The job ends inside the 2-minute lease; the run ends under the 150 s wall clock.
    expect(c.run).toEqual({ windowMs: 50_000, hardStopMs: 140_000, jobTimeoutMs: 72_000 });
    expect(c.run.jobTimeoutMs).toBeLessThan(120_000);
    expect(OPTIONAL.JOBS_RUN_HARD_STOP_MS).toBeLessThan(150_000);
  });

  it('names every missing or bad setting, never a value', () => {
    let err: unknown;
    try {
      loadFunctionConfig({
        SUPABASE_URL: 'ftp://x',
        JOBS_CRON_SECRET: 'short',
        CAPTURE_SHELL_URL: 'https://x.test/v1/capture?x=1',
        CAPTURE_HMAC_SECRET: 'tiny',
        BROWSER_RENDERING_ACCOUNT_ID: 'not an id!',
        BROWSER_BUDGET_MS_PER_DAY: '-1',
        CAPTURE_TIMEOUT_MS: '60000',
        BROWSER_RENDERING_MIN_INTERVAL_MS: '60000',
        JOBS_RUN_WINDOW_MS: '90000',
        JOBS_RUN_HARD_STOP_MS: '60000',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FunctionConfigError);
    const problems = (err as FunctionConfigError).problems.join('\n');
    for (const name of [
      'SUPABASE_URL must be an http(s) URL',
      'SUPABASE_SERVICE_ROLE_KEY is required',
      'JOBS_CRON_SECRET must be at least 32',
      'CAPTURE_SHELL_URL must be the capture page URL',
      'CAPTURE_HMAC_SECRET must be at least 32',
      'PKG_CDN_URL is required',
      'BROWSER_RENDERING_ACCOUNT_ID is not an account id',
      'BROWSER_RENDERING_API_TOKEN is required',
      'BROWSER_BUDGET_MS_PER_DAY must be an integer',
      'the job must end inside its 2-minute lease',
      'JOBS_RUN_HARD_STOP_MS must be >= JOBS_RUN_WINDOW_MS',
    ]) {
      expect(problems).toContain(name);
    }
    expect(problems).not.toContain('short');
    expect(problems).not.toContain('tiny');
  });

  it('describes itself without secrets', () => {
    const text = JSON.stringify(describeFunctionConfig(loadFunctionConfig(ENV)));
    for (const secret of [
      ENV.JOBS_CRON_SECRET,
      ENV.CAPTURE_HMAC_SECRET,
      ENV.SUPABASE_SERVICE_ROLE_KEY,
      ENV.BROWSER_RENDERING_API_TOKEN,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

function job(id: number, kind: JobKind): Job {
  return {
    id,
    kind,
    ref_id: `ref-${String(id)}`,
    status: 'running',
    attempts: 1,
    run_after: '',
    last_error: null,
  };
}

describe('runJobs', () => {
  it('takes one job of each kind per round until the queue is empty', async () => {
    const queue: Record<JobKind, Job[]> = {
      capture: [job(1, 'capture'), job(2, 'capture'), job(3, 'capture')],
      destroy: [job(4, 'destroy')],
      takedown: [job(5, 'takedown')],
    };
    const order: number[] = [];
    const summary = await runJobs(
      {
        backend: { claimJob: (k) => Promise.resolve(queue[k].shift() ?? null) },
        runner: {
          runJob: (j) => {
            order.push(j.id);
            return Promise.resolve({ result: 'destroyed', deleted: 0 } as JobOutcome);
          },
          abortInflight: () => undefined,
        },
        log: silentLogger,
      },
      { windowMs: 60_000, hardStopMs: 120_000 },
    );
    expect(order).toEqual([1, 4, 5, 2, 3]);
    expect(summary).toMatchObject({ stoppedBy: 'empty', hardStopped: false });
    expect(summary.jobs.map((j) => j.id)).toEqual([1, 4, 5, 2, 3]);
  });

  it('claims nothing new after the window', async () => {
    let t = 0;
    let claims = 0;
    const summary = await runJobs(
      {
        backend: {
          claimJob: (k) => {
            claims++;
            return Promise.resolve(job(claims, k));
          },
        },
        runner: {
          runJob: () => {
            t += 20_000; // each job takes 20 s
            return Promise.resolve({ result: 'destroyed', deleted: 0 } as JobOutcome);
          },
          abortInflight: () => undefined,
        },
        log: silentLogger,
        now: () => t,
      },
      { windowMs: 50_000, hardStopMs: 140_000 },
    );
    expect(summary.stoppedBy).toBe('window');
    expect(summary.jobs).toHaveLength(3); // started at 0, 20 and 40 s
  });

  it('stops on a claim error (the database is down) and says so', async () => {
    const lines: string[] = [];
    const summary = await runJobs(
      {
        backend: { claimJob: () => Promise.reject(new Error('PostgREST down')) },
        runner: {
          runJob: () => Promise.reject(new Error('not called')),
          abortInflight: () => undefined,
        },
        log: createLogger({ write: (l) => lines.push(l) }),
      },
      { windowMs: 50_000, hardStopMs: 140_000 },
    );
    expect(summary.stoppedBy).toBe('claim-error');
    expect(lines.some((l) => l.includes('claim.failed') && l.includes('"level":"error"'))).toBe(
      true,
    );
  });

  it('at the hard stop, aborts the jobs in flight', async () => {
    const aborted: string[] = [];
    let release: (() => void) | undefined;
    const summary = await runJobs(
      {
        backend: { claimJob: (k) => Promise.resolve(k === 'capture' ? job(1, k) : null) },
        runner: {
          runJob: () =>
            new Promise<JobOutcome>((resolve) => {
              release = () => {
                resolve({ result: 'retry', reason: 'aborted', attempts: 1 });
              };
            }),
          abortInflight: (reason) => {
            aborted.push(reason);
            release?.();
          },
        },
        log: silentLogger,
      },
      { windowMs: 10, hardStopMs: 30 },
    );
    expect(aborted).toEqual(['the function run reached its time limit']);
    expect(summary).toMatchObject({ hardStopped: true, stoppedBy: 'window' });
    expect(summary.jobs[0]?.result).toBe('retry');
  });
});

describe('the request handler', () => {
  function supabaseFake() {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      calls.push(urlOf(input));
      // claim_job: nothing to do (PostgREST's all-null row).
      return Promise.resolve(new Response(JSON.stringify({ id: null })));
    };
    return { calls, fetchImpl };
  }

  it('only POST, only with the cron secret', async () => {
    const lines: string[] = [];
    const handler = createJobsHandler({ env: ENV, write: (l) => lines.push(l) });
    expect((await handler(new Request('http://fn/jobs'))).status).toBe(405);
    expect((await handler(new Request('http://fn/jobs', { method: 'POST' }))).status).toBe(401);
    const wrong = new Request('http://fn/jobs', {
      method: 'POST',
      headers: { [CRON_SECRET_HEADER]: `${ENV.JOBS_CRON_SECRET}x` },
    });
    expect((await handler(wrong)).status).toBe(401);
    expect(lines.join('\n')).not.toContain(ENV.JOBS_CRON_SECRET);
  });

  it('?wait=1 runs inline and answers with the summary', async () => {
    const { calls, fetchImpl } = supabaseFake();
    const handler = createJobsHandler({ env: ENV, write: () => undefined, fetch: fetchImpl });
    const res = await handler(
      new Request('http://fn/jobs?wait=1', {
        method: 'POST',
        headers: { [CRON_SECRET_HEADER]: ENV.JOBS_CRON_SECRET },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stoppedBy: 'empty', jobs: [] });
    expect(calls).toEqual([
      'http://kong:8000/rest/v1/rpc/claim_job',
      'http://kong:8000/rest/v1/rpc/claim_job',
      'http://kong:8000/rest/v1/rpc/claim_job',
    ]);
  });

  it('without ?wait answers 202 at once and hands the run to waitUntil', async () => {
    const { fetchImpl } = supabaseFake();
    const background: Promise<unknown>[] = [];
    const handler = createJobsHandler({
      env: ENV,
      write: () => undefined,
      fetch: fetchImpl,
      waitUntil: (p) => background.push(p),
    });
    const res = await handler(
      new Request('http://fn/jobs', {
        method: 'POST',
        headers: { [CRON_SECRET_HEADER]: ENV.JOBS_CRON_SECRET },
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ accepted: true });
    expect(background).toHaveLength(1);
    await background[0];
  });

  it('a configuration problem is a 500 with the names (after the secret check)', async () => {
    const env = { ...ENV, BROWSER_RENDERING_API_TOKEN: '' };
    const lines: string[] = [];
    const handler = createJobsHandler({ env, write: (l) => lines.push(l) });
    expect((await handler(new Request('http://fn/jobs', { method: 'POST' }))).status).toBe(401);
    const res = await handler(
      new Request('http://fn/jobs', {
        method: 'POST',
        headers: { [CRON_SECRET_HEADER]: ENV.JOBS_CRON_SECRET },
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'configuration',
      problems: ['BROWSER_RENDERING_API_TOKEN is required'],
    });
    expect(lines.some((l) => l.includes('run.bad_config'))).toBe(true);
  });

  it('compares secrets in full', () => {
    expect(sameSecret('abc', 'abc')).toBe(true);
    expect(sameSecret('abc', 'abd')).toBe(false);
    expect(sameSecret('abc', 'abcd')).toBe(false);
    expect(sameSecret('', 'a')).toBe(false);
  });
});
