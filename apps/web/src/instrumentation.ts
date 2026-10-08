/**
 * Next.js instrumentation (T-030): server errors go to Sentry when a DSN is configured
 * (src/lib/telemetry/server.ts). Next calls `onRequestError` for errors in pages, route
 * handlers and server actions, on `next start` and on Workers (OpenNext loads this file).
 *
 * Next also compiles this file for the edge runtime, which the app does not use (no
 * middleware, no edge routes). `NEXT_RUNTIME` is inlined per compilation, so the edge copy
 * drops the reporter instead of carrying a second Sentry client into the Worker.
 */
import type { Instrumentation } from 'next';

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { reportRequestError } = await import('./lib/telemetry/server');
  reportRequestError(error, request, context);
};
