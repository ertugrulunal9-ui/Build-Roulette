/**
 * Server-side error reporting for the web app (T-030), called from `onRequestError` in
 * src/instrumentation.ts: every error Next.js catches while rendering a page, running a
 * route handler or a server action, on `next start` (Node) and on Cloudflare Workers
 * (OpenNext loads the instrumentation hook in workerd too).
 *
 * Off unless `SENTRY_DSN` (runtime) or `NEXT_PUBLIC_SENTRY_DSN` (build time) is set; the
 * client is created on the first error that is reported, with the DSN of that moment.
 *
 * Sent: the error (scrubbed by @br/telemetry), the route template and route type, the
 * request path without its query string, the method, the `digest` (Next shows it to the
 * visitor in place of the message, so a report can be found by it), the battle id of a
 * `/battles/[id]` request, the runtime and the release. Not sent: headers, cookies, bodies,
 * search params.
 *
 * On Workers the send runs under the request's `waitUntil` (so the isolate is not stopped
 * before it finishes); on Node it runs in the background. Either way the error response is
 * not held up.
 */
import { isUuid } from '@br/telemetry/scrub';
import { createServerReporter, disabledReporter, type ErrorReporter } from '@br/telemetry/server';
import { serverSentryDsn, telemetryConfig, webRelease } from './config';

/** Next's control-flow "errors" (notFound, redirect, dynamic bail-outs): never reported. */
const CONTROL_FLOW_DIGEST = /^(NEXT_|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/;

let reporter: ErrorReporter | null = null;

/** workerd identifies itself as `Cloudflare-Workers`. */
export function serverRuntime(): 'workerd' | 'node' {
  const ua = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent;
  return ua === 'Cloudflare-Workers' ? 'workerd' : 'node';
}

function getReporter(env: Record<string, string | undefined>): ErrorReporter {
  if (reporter) return reporter;
  const dsn = serverSentryDsn(env);
  if (dsn === null) return disabledReporter; // looked up again next time (a runtime var)
  reporter = createServerReporter({
    dsn,
    service: 'web',
    release: webRelease(),
    environment: env['SENTRY_ENVIRONMENT']?.trim() || telemetryConfig.sentryEnvironment,
    runtime: { name: serverRuntime() },
  });
  return reporter;
}

/** The request's `waitUntil` on Workers (OpenNext keeps the context on a global symbol). */
function waitUntil(): ((p: Promise<unknown>) => void) | null {
  const ctx = (
    globalThis as Record<symbol, { ctx?: { waitUntil?: (p: Promise<unknown>) => void } }>
  )[Symbol.for('__cloudflare-context__')]?.ctx;
  return ctx?.waitUntil ? ctx.waitUntil.bind(ctx) : null;
}

export interface RequestInfo {
  path: string;
  method: string;
}

export interface RequestErrorContext {
  routePath: string;
  routeType: string;
  renderSource?: string | undefined;
}

/** True when the error is Next's control flow, not a failure. */
export function isControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && CONTROL_FLOW_DIGEST.test(digest);
}

/** Reports one request error (see the file comment). Never throws. */
export function reportRequestError(
  error: unknown,
  request: RequestInfo,
  context: RequestErrorContext,
  env: Record<string, string | undefined> = process.env,
): void {
  try {
    if (isControlFlow(error)) return;
    const r = getReporter(env);
    if (!r.enabled) return;
    const path = request.path.split(/[?#]/, 1)[0] ?? '';
    const battle = /^\/battles\/([^/]+)/.exec(path)?.[1];
    const digest = (error as { digest?: unknown } | null)?.digest;
    r.captureException(error, {
      url: path,
      method: request.method,
      tags: {
        route: context.routePath,
        route_type: context.routeType,
        render_source: context.renderSource,
        runtime: serverRuntime(),
        digest: typeof digest === 'string' ? digest : undefined,
        battle_id: battle && isUuid(battle) ? battle : undefined,
      },
    });
    const sent = r.flush(5_000);
    const wait = waitUntil();
    if (wait) wait(sent);
  } catch {
    // Reporting must never turn one error into two.
  }
}

/** Tests only. */
export function resetServerReporter(): void {
  reporter = null;
}
