/**
 * Configuration from the environment (see .env.example). Secrets are read here and never
 * logged: `describeConfig` is what the worker prints at startup.
 */
import { CAPTURE_MIN_SECRET_LENGTH } from '@br/sandbox-shell/capture-sig';
import { CAPTURE_VIEWPORT } from '@br/sandbox-shell/capture-gate';
import { JOB_LEASE_MS } from './backend';
import type { CaptureConfig } from './capture-job';
import { isLogLevel, type LogLevel } from './log';
import { DEFAULT_RUNNER_OPTIONS, type RunnerOptions } from './runner';

export interface WorkerConfig {
  supabaseUrl: string;
  serviceKey: string;
  capture: CaptureConfig;
  runner: RunnerOptions;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined>): WorkerConfig {
  const problems: string[] = [];
  const str = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) {
      problems.push(`${name} is required`);
      return '';
    }
    return v;
  };
  const url = (name: string, value: string): string => {
    if (!value) return value;
    try {
      const u = new URL(value.replaceAll('{build}', 'build'));
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
    } catch {
      problems.push(`${name} must be an http(s) URL`);
    }
    return value;
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${String(min)} and ${String(max)}`);
      return fallback;
    }
    return n;
  };

  const supabaseUrl = url('SUPABASE_URL', str('SUPABASE_URL'));
  const serviceKey = str('SUPABASE_SERVICE_ROLE_KEY');
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
  const level = env['LOG_LEVEL']?.trim() ?? 'info';
  if (!isLogLevel(level)) problems.push('LOG_LEVEL must be debug, info, warn or error');

  const jobTimeoutMs = int(
    'WORKER_JOB_TIMEOUT_MS',
    DEFAULT_RUNNER_OPTIONS.jobTimeoutMs,
    10_000,
    JOB_LEASE_MS - 15_000,
  );
  const capture: CaptureConfig = {
    shellCaptureUrl,
    hmacSecret,
    pkgCdnUrl: pkgCdnUrl.replace(/\/+$/, ''),
    signedUrlTtlSeconds: int('CAPTURE_SIGNED_URL_TTL_S', 120, 30, 600),
    captureTimeoutMs: int('CAPTURE_TIMEOUT_MS', 20_000, 8000, 60_000),
    viewport: { ...CAPTURE_VIEWPORT },
  };
  if (capture.captureTimeoutMs * 2 > jobTimeoutMs) {
    problems.push('WORKER_JOB_TIMEOUT_MS must be at least twice CAPTURE_TIMEOUT_MS');
  }
  const runner: RunnerOptions = {
    captureConcurrency: int('CAPTURE_CONCURRENCY', DEFAULT_RUNNER_OPTIONS.captureConcurrency, 1, 8),
    idleMinMs: int('WORKER_IDLE_MIN_MS', DEFAULT_RUNNER_OPTIONS.idleMinMs, 100, 60_000),
    idleMaxMs: int('WORKER_IDLE_MAX_MS', DEFAULT_RUNNER_OPTIONS.idleMaxMs, 100, 300_000),
    jobTimeoutMs,
    shutdownGraceMs: int(
      'WORKER_SHUTDOWN_GRACE_MS',
      DEFAULT_RUNNER_OPTIONS.shutdownGraceMs,
      0,
      110_000,
    ),
  };
  if (runner.idleMaxMs < runner.idleMinMs)
    problems.push('WORKER_IDLE_MAX_MS must be >= WORKER_IDLE_MIN_MS');

  if (problems.length > 0) throw new ConfigError(problems);
  return { supabaseUrl, serviceKey, capture, runner, logLevel: level as LogLevel };
}

/** The configuration without secrets, for the startup log line. */
export function describeConfig(c: WorkerConfig): Record<string, unknown> {
  return {
    supabaseUrl: c.supabaseUrl,
    shellCaptureUrl: c.capture.shellCaptureUrl,
    pkgCdnUrl: c.capture.pkgCdnUrl,
    signedUrlTtlSeconds: c.capture.signedUrlTtlSeconds,
    captureTimeoutMs: c.capture.captureTimeoutMs,
    ...c.runner,
  };
}
