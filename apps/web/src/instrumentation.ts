/**
 * Next.js instrumentation (T-030): server errors go to Sentry when a DSN is configured
 * (src/lib/telemetry/server.ts). Next calls `onRequestError` for errors in pages, route
 * handlers and server actions, on `next start` and on Workers (OpenNext loads this file).
 */
import type { Instrumentation } from 'next';
import { reportRequestError } from './lib/telemetry/server';

export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  reportRequestError(error, request, context);
};
