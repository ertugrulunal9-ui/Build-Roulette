/**
 * Configuration of the `jobs` Edge Function (T-034) from its environment: Supabase's own
 * variables plus the function secrets (`supabase secrets set …`, apps/web/DEPLOY.md
 * "Screenshots and jobs"). Secrets are never logged; `describeFunctionConfig` is what a run
 * prints.
 *
 * Set by Supabase:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Required secrets:  JOBS_CRON_SECRET, CAPTURE_SHELL_URL, CAPTURE_HMAC_SECRET, PKG_CDN_URL,
 *                    BROWSER_RENDERING_ACCOUNT_ID, BROWSER_RENDERING_API_TOKEN
 * Optional:          see `OPTIONAL` below (defaults fit Workers Free and Supabase Free).
 */
import { CAPTURE_MIN_SECRET_LENGTH } from '@br/sandbox-shell/capture-sig';
import { JOB_LEASE_MS } from '../backend';
import {
  DEFAULT_BROWSER_BUDGET_MS,
  DEFAULT_BROWSER_RESERVE_MS,
  FREE_BROWSER_MS_PER_DAY,
} from '../budget';
import { BROWSER_RENDERING_API_URL, FREE_PLAN_MIN_INTERVAL_MS } from '../browser-rendering';
import type { CaptureConfig } from '../capture-job';
import { isLogLevel, type LogLevel } from '../log';

/** The capture viewport (the shell's CAPTURE_VIEWPORT, docs/03 §3.7). */
export const FUNCTION_VIEWPORT = { width: 1280, height: 800 } as const;
/** Shortest accepted cron secret (32 random bytes as hex are 64). */
export const CRON_SECRET_MIN_LENGTH = 32;
/** A capture job's time besides the REST call and the pacing: one 429 wait, Storage calls. */
const JOB_EXTRA_MS = 27_000;

export interface FunctionConfig {
  supabaseUrl: string;
  /** Base of the signed Storage URLs the browser fetches. */
  publicSupabaseUrl: string;
  serviceKey: string;
  cronSecret: string;
  capture: CaptureConfig;
  browserRendering: {
    apiUrl: string;
    accountId: string;
    apiToken: string;
    minIntervalMs: number;
  };
  budget: { limitMs: number; reserveMs: number };
  run: {
    /** New jobs are claimed only this long after the run started. */
    windowMs: number;
    /** Jobs still running at this point are aborted (handed back with fail_job). */
    hardStopMs: number;
    /** Per job (a capture: the REST call plus pacing, a 429 wait and the uploads). */
    jobTimeoutMs: number;
  };
  logLevel: LogLevel;
}

export class FunctionConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration: ${problems.join('; ')}`);
    this.name = 'FunctionConfigError';
  }
}

/** The optional settings and their defaults (also listed in apps/web/DEPLOY.md). */
export const OPTIONAL = {
  BROWSER_RENDERING_API_URL,
  BROWSER_RENDERING_MIN_INTERVAL_MS: FREE_PLAN_MIN_INTERVAL_MS,
  BROWSER_BUDGET_MS_PER_DAY: DEFAULT_BROWSER_BUDGET_MS,
  BROWSER_RESERVE_MS: DEFAULT_BROWSER_RESERVE_MS,
  CAPTURE_TIMEOUT_MS: 35_000,
  CAPTURE_SIGNED_URL_TTL_S: 120,
  JOBS_RUN_WINDOW_MS: 50_000,
  JOBS_RUN_HARD_STOP_MS: 140_000,
} as const;

export function loadFunctionConfig(env: Record<string, string | undefined>): FunctionConfig {
  const problems: string[] = [];
  const get = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v === undefined || v === '' ? undefined : v;
  };
  const str = (name: string): string => {
    const v = get(name);
    if (v === undefined) problems.push(`${name} is required`);
    return v ?? '';
  };
  const url = (name: string, value: string): string => {
    if (!value) return value;
    try {
      const u = new URL(value.replaceAll('{build}', 'build'));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
    } catch {
      problems.push(`${name} must be an http(s) URL`);
    }
    return value.replace(/\/+$/, '');
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${String(min)} and ${String(max)}`);
      return fallback;
    }
    return n;
  };

  const supabaseUrl = url('SUPABASE_URL', str('SUPABASE_URL'));
  const publicSupabaseUrl = url(
    'JOBS_PUBLIC_SUPABASE_URL',
    get('JOBS_PUBLIC_SUPABASE_URL') ?? supabaseUrl,
  );
  const serviceKey = str('SUPABASE_SERVICE_ROLE_KEY');
  const cronSecret = str('JOBS_CRON_SECRET');
  if (cronSecret && cronSecret.length < CRON_SECRET_MIN_LENGTH) {
    problems.push(`JOBS_CRON_SECRET must be at least ${String(CRON_SECRET_MIN_LENGTH)} characters`);
  }
  const shellCaptureUrl = url('CAPTURE_SHELL_URL', str('CAPTURE_SHELL_URL'));
  if (shellCaptureUrl && URL.canParse(shellCaptureUrl.replaceAll('{build}', 'b'))) {
    const u = new URL(shellCaptureUrl.replaceAll('{build}', 'b'));
    if (!u.pathname.endsWith('/capture') || u.search || u.hash) {
      problems.push('CAPTURE_SHELL_URL must be the capture page URL (…/v1/capture, no query)');
    }
  }
  const hmacSecret = str('CAPTURE_HMAC_SECRET');
  if (hmacSecret && hmacSecret.length < CAPTURE_MIN_SECRET_LENGTH) {
    problems.push(
      `CAPTURE_HMAC_SECRET must be at least ${String(CAPTURE_MIN_SECRET_LENGTH)} characters`,
    );
  }
  const pkgCdnUrl = url('PKG_CDN_URL', str('PKG_CDN_URL'));
  const accountId = str('BROWSER_RENDERING_ACCOUNT_ID');
  if (accountId && !/^[0-9A-Za-z_-]{1,64}$/.test(accountId)) {
    problems.push('BROWSER_RENDERING_ACCOUNT_ID is not an account id');
  }
  const apiToken = str('BROWSER_RENDERING_API_TOKEN');
  const apiUrl = url(
    'BROWSER_RENDERING_API_URL',
    get('BROWSER_RENDERING_API_URL') ?? OPTIONAL.BROWSER_RENDERING_API_URL,
  );
  const level = get('LOG_LEVEL') ?? 'info';
  if (!isLogLevel(level)) problems.push('LOG_LEVEL must be debug, info, warn or error');

  const captureTimeoutMs = int('CAPTURE_TIMEOUT_MS', OPTIONAL.CAPTURE_TIMEOUT_MS, 10_000, 60_000);
  const minIntervalMs = int(
    'BROWSER_RENDERING_MIN_INTERVAL_MS',
    OPTIONAL.BROWSER_RENDERING_MIN_INTERVAL_MS,
    0,
    60_000,
  );
  // The REST call, the pacing before it, one short 429 wait, and the Storage calls.
  const jobTimeoutMs = captureTimeoutMs + minIntervalMs + JOB_EXTRA_MS;
  if (jobTimeoutMs > JOB_LEASE_MS - 10_000) {
    problems.push(
      `CAPTURE_TIMEOUT_MS + BROWSER_RENDERING_MIN_INTERVAL_MS must be at most ${String(JOB_LEASE_MS - 10_000 - JOB_EXTRA_MS)} (the job must end inside its 2-minute lease)`,
    );
  }
  const windowMs = int('JOBS_RUN_WINDOW_MS', OPTIONAL.JOBS_RUN_WINDOW_MS, 1_000, 300_000);
  const hardStopMs = int('JOBS_RUN_HARD_STOP_MS', OPTIONAL.JOBS_RUN_HARD_STOP_MS, 5_000, 390_000);
  if (hardStopMs < windowMs) problems.push('JOBS_RUN_HARD_STOP_MS must be >= JOBS_RUN_WINDOW_MS');
  const signedUrlTtlSeconds = int(
    'CAPTURE_SIGNED_URL_TTL_S',
    OPTIONAL.CAPTURE_SIGNED_URL_TTL_S,
    30,
    600,
  );
  const budget = {
    limitMs: int('BROWSER_BUDGET_MS_PER_DAY', OPTIONAL.BROWSER_BUDGET_MS_PER_DAY, 0, 86_400_000),
    reserveMs: int('BROWSER_RESERVE_MS', OPTIONAL.BROWSER_RESERVE_MS, 1_000, 120_000),
  };

  if (problems.length > 0) throw new FunctionConfigError(problems);
  return {
    supabaseUrl,
    publicSupabaseUrl,
    serviceKey,
    cronSecret,
    capture: {
      shellCaptureUrl,
      hmacSecret,
      pkgCdnUrl,
      signedUrlTtlSeconds,
      captureTimeoutMs,
      viewport: { ...FUNCTION_VIEWPORT },
    },
    browserRendering: { apiUrl, accountId, apiToken, minIntervalMs },
    budget,
    run: { windowMs, hardStopMs, jobTimeoutMs },
    logLevel: level as LogLevel,
  };
}

/** The configuration without secrets, for the log. */
export function describeFunctionConfig(c: FunctionConfig): Record<string, unknown> {
  return {
    supabaseUrl: c.supabaseUrl,
    publicSupabaseUrl: c.publicSupabaseUrl,
    shellCaptureUrl: c.capture.shellCaptureUrl,
    pkgCdnUrl: c.capture.pkgCdnUrl,
    browserRendering: c.browserRendering.apiUrl,
    minIntervalMs: c.browserRendering.minIntervalMs,
    budgetMsPerDay: c.budget.limitMs,
    freeBrowserMsPerDay: FREE_BROWSER_MS_PER_DAY,
    captureTimeoutMs: c.capture.captureTimeoutMs,
    ...c.run,
  };
}
