/**
 * Browser error reporting (T-030), started by `src/instrumentation-client.ts` on every page.
 *
 * Without `NEXT_PUBLIC_SENTRY_DSN` this does nothing at all: no listener, no chunk, no
 * request. With it:
 * - two listeners (`error`, `unhandledrejection` on `window`) keep the first errors of the
 *   page in memory;
 * - when the browser is idle (at most 3 s later) the Sentry chunk (sentry-browser.ts, loaded
 *   only now) starts, takes over those two handlers and reports what was kept.
 *
 * The sandbox iframe is another origin: its errors never reach this window's handlers, and
 * the Sentry setup only reports errors whose code is on this origin (`allowUrls`) and drops
 * any stack through a blob:/data: URL. No handler listens to `message` events, and no console
 * output is captured.
 */
import { telemetryConfig, type TelemetryConfig } from './config';
import type * as SentryBrowser from './sentry-browser';

type Loaded = typeof SentryBrowser;

export interface ClientErrorDeps {
  config?: TelemetryConfig;
  /** Loads the Sentry chunk (tests pass a fake). */
  load?: () => Promise<Loaded>;
  win?: Window;
  /** When to load: default `requestIdleCallback` (3 s at most). */
  whenIdle?: (fn: () => void) => void;
}

/** Errors kept until the SDK is loaded. */
export const EARLY_ERROR_LIMIT = 10;

let started = false;
let api: Loaded | null = null;

function idle(win: Window): (fn: () => void) => void {
  return (fn) => {
    if (typeof win.requestIdleCallback === 'function') {
      win.requestIdleCallback(fn, { timeout: 3_000 });
    } else {
      win.setTimeout(fn, 1_000);
    }
  };
}

/** Starts error reporting once per page; false when it is off (no DSN). */
export function startClientErrorReporting(deps: ClientErrorDeps = {}): boolean {
  const config = deps.config ?? telemetryConfig;
  const dsn = config.sentryDsn;
  if (dsn === null || started) return false;
  const win = deps.win ?? window;
  started = true;

  const early: { error: unknown; kind: 'onerror' | 'onunhandledrejection' }[] = [];
  const onError = (e: ErrorEvent) => {
    if (early.length < EARLY_ERROR_LIMIT && e.error !== undefined && e.error !== null) {
      early.push({ error: e.error, kind: 'onerror' });
    }
  };
  const onRejection = (e: PromiseRejectionEvent) => {
    if (early.length < EARLY_ERROR_LIMIT)
      early.push({ error: e.reason, kind: 'onunhandledrejection' });
  };
  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);

  const load = deps.load ?? (() => import('./sentry-browser'));
  (deps.whenIdle ?? idle(win))(() => {
    void load()
      .then((mod) => {
        mod.initBrowserSentry(dsn, config, win);
        api = mod;
        win.removeEventListener('error', onError);
        win.removeEventListener('unhandledrejection', onRejection);
        for (const { error, kind } of early.splice(0)) mod.reportEarlyError(error, kind);
      })
      .catch(() => {
        // Blocked by an extension or offline: no error reporting for this page.
        win.removeEventListener('error', onError);
        win.removeEventListener('unhandledrejection', onRejection);
      });
  });
  return true;
}

/**
 * Reports an error the app caught itself (an error boundary). A no-op while reporting is
 * off or not loaded yet.
 */
export function reportClientError(error: unknown): void {
  api?.reportError(error);
}

/** Tests only. */
export function resetClientErrorReporting(): void {
  started = false;
  api = null;
}
