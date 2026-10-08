/**
 * Telemetry settings (T-030). Everything is OFF unless configured:
 *
 * | Variable | Where | Turns on |
 * |---|---|---|
 * | `NEXT_PUBLIC_SENTRY_DSN` | build time (`cf:build`) | browser error reporting (and the server's, as a fallback) |
 * | `SENTRY_DSN` | runtime (Worker secret / `next start` env) | server error reporting |
 * | `NEXT_PUBLIC_POSTHOG_KEY` | build time | product analytics |
 * | `NEXT_PUBLIC_POSTHOG_HOST` | build time | the PostHog region (default EU: https://eu.i.posthog.com) |
 * | `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | build time | the Sentry environment (default `production`) |
 * | `BR_RELEASE` | build time | the release (default: the git commit; see next.config.ts) |
 *
 * `NEXT_PUBLIC_*` values are inlined into the bundles at build time, so an unset key leaves
 * the code paths that would send anything unreachable: no SDK chunk is loaded, no listener
 * is installed, no request is made. DEPLOY.md ("Observability") has the setup.
 */

import { usableDsn } from '@br/telemetry/dsn';

function clean(value: string | undefined): string | null {
  const v = value?.trim() ?? '';
  return v === '' ? null : v;
}

export const DEFAULT_POSTHOG_HOST = 'https://eu.i.posthog.com';

export interface TelemetryConfig {
  sentryDsn: string | null;
  sentryEnvironment: string;
  posthogKey: string | null;
  posthogHost: string;
  release: string;
}

// Each `process.env.NEXT_PUBLIC_*` is spelled out: Next only inlines literal references.
export const telemetryConfig: TelemetryConfig = {
  sentryDsn: clean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  sentryEnvironment: clean(process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT) ?? 'production',
  posthogKey: clean(process.env.NEXT_PUBLIC_POSTHOG_KEY),
  posthogHost: (clean(process.env.NEXT_PUBLIC_POSTHOG_HOST) ?? DEFAULT_POSTHOG_HOST).replace(
    /\/+$/,
    '',
  ),
  release: clean(process.env.NEXT_PUBLIC_BR_RELEASE) ?? 'dev',
};

/** The server's DSN: the runtime `SENTRY_DSN`, else the build-time public one. */
export function serverSentryDsn(
  env: Record<string, string | undefined> = process.env,
): string | null {
  return clean(env['SENTRY_DSN']) ?? telemetryConfig.sentryDsn;
}

/**
 * True when server errors are reported (a usable DSN). Light on purpose: a page or server
 * action that only asks this must not bundle the Sentry client (server.ts) into its route.
 */
export function serverReportingEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return usableDsn(serverSentryDsn(env)) !== null;
}

/** The error the /admin Health button throws (its message is how to find it in Sentry). */
export const TEST_ERROR_MESSAGE = 'Build Roulette test error (thrown from /admin on purpose)';

/** The Sentry release name for the web app. */
export function webRelease(config: TelemetryConfig = telemetryConfig): string {
  return `build-roulette-web@${config.release}`;
}
