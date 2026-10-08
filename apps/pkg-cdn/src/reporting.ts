/**
 * Error reporting for the package CDN (T-030): off unless `SENTRY_DSN` is set.
 *
 * Reported: the CDN's own failures, i.e. a request that ended in 500 (an unexpected
 * exception, or a bundling failure that is not the package's fault) or 502 (the npm registry
 * failed us: the signal of a registry outage). Not reported: 4xx (bad names, denied or broken
 * packages: the package's problem, answered to the client), 503 (load shedding, by design),
 * 504 (a slow cold build, retried by the client) and 499 (the client went away).
 *
 * Each report carries the request path without its query string (a package name and
 * version, public data), the method, the status and the CDN's error code; the message is
 * scrubbed by @br/telemetry. A process crash is reported too (main.ts).
 */
import { createServerReporter, type ErrorReporter } from '@br/telemetry';
import { CdnError } from './errors';

export const REPORTED_STATUSES: ReadonlySet<number> = new Set([500, 502]);

export function cdnReporter(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): ErrorReporter {
  const release = env['SENTRY_RELEASE']?.trim();
  const environment = env['SENTRY_ENVIRONMENT']?.trim();
  return createServerReporter({
    dsn: env['SENTRY_DSN'],
    service: 'pkg-cdn',
    release: release ? `pkg-cdn@${release}` : undefined,
    environment: environment === undefined || environment === '' ? 'production' : environment,
    runtime: { name: 'node', version: process.version },
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/** The handler's `onServerError` (server.ts). */
export function reportServerErrors(
  reporter: ErrorReporter,
): (error: unknown, status: number, request: { method: string; url: string }) => void {
  return (error, status, request) => {
    if (!reporter.enabled || !REPORTED_STATUSES.has(status)) return;
    const code = error instanceof CdnError ? error.code : 'internal';
    reporter.captureException(error, {
      url: request.url,
      method: request.method,
      tags: { status, code },
    });
  };
}
