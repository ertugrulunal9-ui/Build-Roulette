/**
 * Runs in the browser before the page hydrates (Next.js `instrumentation-client`). Error
 * reporting starts here when `NEXT_PUBLIC_SENTRY_DSN` is set (src/lib/telemetry/
 * client-errors.ts). The check is on the inlined variable itself, so a build without it
 * drops the reporting code from the page entirely.
 */
import { startClientErrorReporting } from './lib/telemetry/client-errors';

if (process.env.NEXT_PUBLIC_SENTRY_DSN) startClientErrorReporting();
