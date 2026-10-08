/**
 * The Sentry browser SDK, set up for errors only (T-030). This module is its own chunk,
 * loaded by client-errors.ts only when `NEXT_PUBLIC_SENTRY_DSN` is set.
 *
 * Integrations are chosen one by one (`defaultIntegrations: false`):
 * - kept: `GlobalHandlers` (window `error` / `unhandledrejection`), `LinkedErrors` (causes),
 *   `Dedupe`, `HttpContext` (page URL and user agent; the URL is scrubbed), `EventFilters`
 *   (the `allowUrls` rule below, and Sentry's default ignore list such as "Script error.");
 * - left out: `Breadcrumbs` (console output, clicks, fetch URLs), `BrowserApiErrors` (it wraps
 *   every `addEventListener`, `message` handlers included), `BrowserSession` (session
 *   pings), `CultureContext` (locale, time zone), tracing and replay.
 *
 * `allowUrls` is this page's origin, so only errors thrown by our own scripts are reported:
 * never the sandbox's (another origin, and its errors do not reach this window anyway), a
 * browser extension's or a third-party script's. Every event goes through `beforeSend`: the
 * room, battle and phase tags and the hashed user id are added (no user id under Do Not
 * Track / GPC), then `scrubSentryEvent` keeps only what may leave (@br/telemetry).
 */
import {
  captureException,
  dedupeIntegration,
  eventFiltersIntegration,
  globalHandlersIntegration,
  httpContextIntegration,
  init,
  linkedErrorsIntegration,
  type BrowserOptions,
  type ErrorEvent,
} from '@sentry/browser';
import { NO_DATA_COLLECTION, routeTemplate, scrubSentryEvent } from '@br/telemetry/scrub';
import { webRelease, type TelemetryConfig } from './config';
import { currentUserHash, telemetryContext } from './context';
import { privacySignal } from './privacy';

/** Adds the app's tags and user, then scrubs. Exported for the unit tests. */
export function prepareBrowserEvent(
  event: ErrorEvent,
  pathname: string,
  privacy: boolean = privacySignal(),
): ErrorEvent | null {
  const ctx = telemetryContext();
  const tags: Record<string, string> = { route: routeTemplate(pathname), runtime: 'browser' };
  if (ctx.phase) tags['phase'] = ctx.phase;
  if (ctx.mode) tags['mode'] = ctx.mode;
  if (ctx.roomId) tags['room_id'] = ctx.roomId;
  if (ctx.battleId) tags['battle_id'] = ctx.battleId;
  const user = privacy ? null : currentUserHash();
  const withContext: ErrorEvent = {
    ...event,
    tags: { ...event.tags, ...tags },
    ...(user ? { user: { id: user } } : { user: {} }),
  };
  return scrubSentryEvent(withContext);
}

export function browserSentryOptions(
  dsn: string,
  config: TelemetryConfig,
  origin: string,
  pathname: () => string,
): BrowserOptions {
  return {
    dsn,
    release: webRelease(config),
    environment: config.sentryEnvironment,
    defaultIntegrations: false,
    integrations: [
      eventFiltersIntegration(),
      globalHandlersIntegration({ onerror: true, onunhandledrejection: true }),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      httpContextIntegration(),
    ],
    allowUrls: [origin],
    dataCollection: NO_DATA_COLLECTION,
    sendClientReports: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: (event) => prepareBrowserEvent(event, pathname()),
  };
}

export function initBrowserSentry(dsn: string, config: TelemetryConfig, win: Window): void {
  init(browserSentryOptions(dsn, config, win.location.origin, () => win.location.pathname));
}

/** An error that happened before the SDK was loaded. */
export function reportEarlyError(error: unknown, kind: 'onerror' | 'onunhandledrejection'): void {
  captureException(error, { mechanism: { type: kind, handled: false } });
}

/** An error the app caught (an error boundary). */
export function reportError(error: unknown): void {
  captureException(error, { mechanism: { type: 'react.errorboundary', handled: true } });
}
