/**
 * Server-side error reporting (T-030) for Next.js on Node (`next start`) and on Cloudflare
 * Workers (OpenNext, workerd), the capture worker and the package CDN: one small Sentry
 * client on `@sentry/core` with a `fetch` transport.
 *
 * Why not `@sentry/node` / `@sentry/nextjs`: they bring OpenTelemetry and module
 * instrumentation (which does not run in workerd and would grow the Worker by megabytes),
 * and auto-capture request data. `@sentry/core` is the runtime-neutral part both are built
 * on (the Cloudflare and Vercel Edge SDKs use the same `ServerRuntimeClient`), so the same
 * code runs in Node and in workerd, and every event goes through `scrubSentryEvent`.
 *
 * **Off without a DSN:** `createServerReporter({ dsn: undefined })` returns a reporter that
 * does nothing and never touches the network; the client is only constructed with a DSN.
 * The client is not bound to Sentry's global scope (no `init()`), so nothing else in the
 * process can report through it, and nothing is instrumented: only what is passed to
 * `captureException` / `captureMessage` is sent.
 */
import {
  Scope,
  ServerRuntimeClient,
  createStackParser,
  createTransport,
  dedupeIntegration,
  linkedErrorsIntegration,
  nodeStackLineParser,
  type BaseTransportOptions,
  type SeverityLevel,
  type Transport,
} from '@sentry/core';
import { usableDsn } from './dsn';
import { NO_DATA_COLLECTION, scrubSentryEvent, scrubUrl, type ScrubEventOptions } from './scrub';

export type TagValue = string | number | boolean | null | undefined;

export interface ReportContext {
  /** Only the keys in ALLOWED_TAGS (scrub.ts) are sent; `*_id` tags must be UUIDs. */
  tags?: Record<string, TagValue>;
  level?: SeverityLevel;
  /** The request path or URL (sent without its query string, as a route template). */
  url?: string;
  method?: string;
  /** The hashed user id (hash.ts), if known. */
  userHash?: string | null;
  fingerprint?: string[];
}

export interface ErrorReporter {
  /** False when no DSN is configured: every call is a no-op. */
  readonly enabled: boolean;
  /** Returns the event id (undefined when disabled). */
  captureException(error: unknown, ctx?: ReportContext): string | undefined;
  captureMessage(message: string, ctx?: ReportContext): string | undefined;
  /** Waits for queued events to be sent (at most `timeoutMs`). */
  flush(timeoutMs?: number): Promise<boolean>;
}

export const disabledReporter: ErrorReporter = {
  enabled: false,
  captureException: () => undefined,
  captureMessage: () => undefined,
  flush: () => Promise.resolve(true),
};

export interface ServerReporterOptions {
  /** The Sentry DSN; empty or missing turns reporting off. */
  dsn: string | null | undefined;
  /** Tag `service` on every event (web, capture-worker, pkg-cdn). */
  service: string;
  release?: string | undefined;
  environment?: string | undefined;
  /** The runtime context (`node`, `workerd`). */
  runtime?: { name: string; version?: string };
  /** Default: the global fetch. */
  fetch?: typeof fetch;
  /** Per request (default 5 s). */
  timeoutMs?: number;
  scrub?: ScrubEventOptions;
}

/** Sentry's transport over plain fetch (Node 22, workerd and browsers all have it). */
export function makeFetchTransport(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): (options: BaseTransportOptions) => Transport {
  return (options) =>
    createTransport(options, async (request) => {
      const res = await fetchImpl(options.url, {
        method: 'POST',
        body: request.body as BodyInit,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        statusCode: res.status,
        headers: {
          'x-sentry-rate-limits': res.headers.get('X-Sentry-Rate-Limits'),
          'retry-after': res.headers.get('Retry-After'),
        },
      };
    });
}

export function createServerReporter(opts: ServerReporterOptions): ErrorReporter {
  const dsn = usableDsn(opts.dsn);
  if (!dsn) return disabledReporter;
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const scrubOptions = opts.scrub ?? {};
  const client = new ServerRuntimeClient({
    dsn,
    release: opts.release,
    environment: opts.environment ?? 'production',
    platform: 'node',
    ...(opts.runtime ? { runtime: opts.runtime } : {}),
    dataCollection: NO_DATA_COLLECTION,
    stackParser: createStackParser(nodeStackLineParser()),
    integrations: [dedupeIntegration(), linkedErrorsIntegration()],
    transport: makeFetchTransport(fetchImpl, opts.timeoutMs ?? 5_000),
    // Errors only: no traces, no logs, no sessions.
    tracesSampleRate: 0,
    beforeSend: (event) => scrubSentryEvent(event, scrubOptions),
    beforeSendTransaction: () => null,
  });
  client.init();

  const scopeFor = (ctx: ReportContext | undefined): Scope => {
    const scope = new Scope();
    scope.setClient(client);
    scope.setTag('service', opts.service);
    for (const [k, v] of Object.entries(ctx?.tags ?? {})) {
      if (v !== null && v !== undefined) scope.setTag(k, v);
    }
    if (ctx?.level) scope.setLevel(ctx.level);
    if (ctx?.userHash) scope.setUser({ id: ctx.userHash });
    if (ctx?.fingerprint) scope.setFingerprint(ctx.fingerprint);
    if (ctx?.url !== undefined) {
      const url = scrubUrl(ctx.url);
      scope.addEventProcessor((event) => {
        event.request = { url, ...(ctx.method ? { method: ctx.method } : {}) };
        return event;
      });
    }
    return scope;
  };

  return {
    enabled: true,
    captureException(error, ctx) {
      return client.captureException(
        error,
        { originalException: error, mechanism: { type: 'generic', handled: true } },
        scopeFor(ctx),
      );
    },
    captureMessage(message, ctx) {
      return client.captureMessage(message, ctx?.level ?? 'error', undefined, scopeFor(ctx));
    },
    flush(timeoutMs = 2_000) {
      return Promise.resolve(client.flush(timeoutMs));
    },
  };
}
