// @vitest-environment happy-dom
import type { ErrorEvent as SentryErrorEvent } from '@sentry/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EARLY_ERROR_LIMIT,
  resetClientErrorReporting,
  startClientErrorReporting,
  type ClientErrorDeps,
} from './client-errors';
import type { TelemetryConfig } from './config';
import { resetTelemetryContext, setTelemetryContext } from './context';
import { browserSentryOptions, prepareBrowserEvent } from './sentry-browser';
import type * as SentryBrowser from './sentry-browser';

const ROOM = '3f2a8c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f';
const BATTLE = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';

const CONFIG: TelemetryConfig = {
  sentryDsn: 'https://public@sentry.example/1',
  sentryEnvironment: 'staging',
  posthogKey: null,
  posthogHost: 'https://ph.example',
  release: 'abc123',
};

function fakeModule() {
  return {
    initBrowserSentry: vi.fn(),
    reportEarlyError: vi.fn(),
    reportError: vi.fn(),
  };
}

beforeEach(() => {
  resetClientErrorReporting();
  resetTelemetryContext();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('startClientErrorReporting', () => {
  it('does nothing at all without a DSN: no listener, no chunk', () => {
    const load = vi.fn();
    const add = vi.spyOn(window, 'addEventListener');
    const started = startClientErrorReporting({
      config: { ...CONFIG, sentryDsn: null },
      load,
      whenIdle: (fn) => {
        fn();
      },
    });
    expect(started).toBe(false);
    expect(load).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it('with a DSN: keeps early errors, loads the chunk when idle, then hands them over', async () => {
    const mod = fakeModule();
    let runIdle: () => void = () => undefined;
    const deps: ClientErrorDeps = {
      config: CONFIG,
      load: () => Promise.resolve(mod as unknown as typeof SentryBrowser),
      whenIdle: (fn) => {
        runIdle = fn;
      },
    };
    expect(startClientErrorReporting(deps)).toBe(true);
    // Once per page.
    expect(startClientErrorReporting(deps)).toBe(false);

    const early = new Error('during hydration');
    window.dispatchEvent(new ErrorEvent('error', { error: early, message: early.message }));
    // A cross-origin "Script error." has no error object: nothing to report.
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    expect(mod.initBrowserSentry).not.toHaveBeenCalled();

    runIdle();
    await vi.waitFor(() => {
      expect(mod.initBrowserSentry).toHaveBeenCalledWith(CONFIG.sentryDsn, CONFIG, window);
    });
    expect(mod.reportEarlyError).toHaveBeenCalledTimes(1);
    expect(mod.reportEarlyError).toHaveBeenCalledWith(early, 'onerror');

    // The buffer's listeners are gone (the SDK's own handlers took over).
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('later') }));
    expect(mod.reportEarlyError).toHaveBeenCalledTimes(1);
  });

  it('keeps at most EARLY_ERROR_LIMIT early errors', async () => {
    const mod = fakeModule();
    let runIdle: () => void = () => undefined;
    startClientErrorReporting({
      config: CONFIG,
      load: () => Promise.resolve(mod as unknown as typeof SentryBrowser),
      whenIdle: (fn) => {
        runIdle = fn;
      },
    });
    for (let i = 0; i < EARLY_ERROR_LIMIT + 5; i++) {
      window.dispatchEvent(new ErrorEvent('error', { error: new Error(`e${String(i)}`) }));
    }
    runIdle();
    await vi.waitFor(() => {
      expect(mod.reportEarlyError).toHaveBeenCalledTimes(EARLY_ERROR_LIMIT);
    });
  });
});

describe('the Sentry browser setup', () => {
  const opts = browserSentryOptions(
    CONFIG.sentryDsn ?? '',
    CONFIG,
    'https://app.example',
    () => '/r/K7QXM',
  );

  it('uses only the integrations that cannot see build code, inputs or messages', () => {
    expect(opts.defaultIntegrations).toBe(false);
    const names = (Array.isArray(opts.integrations) ? opts.integrations : []).map((i) => i.name);
    expect(names.sort()).toEqual(
      ['Dedupe', 'EventFilters', 'GlobalHandlers', 'HttpContext', 'LinkedErrors'].sort(),
    );
    for (const banned of ['Breadcrumbs', 'BrowserApiErrors', 'BrowserSession', 'CultureContext']) {
      expect(names).not.toContain(banned);
    }
    expect(opts.allowUrls).toEqual(['https://app.example']);
    expect(opts.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
    });
    expect(opts.maxBreadcrumbs).toBe(0);
    expect(opts.release).toBe('build-roulette-web@abc123');
    expect(opts.environment).toBe('staging');
  });

  it('tags events with the room, battle and phase, and scrubs them', () => {
    setTelemetryContext({ roomId: ROOM, battleId: BATTLE, phase: 'building', mode: 'multiplayer' });
    const event: SentryErrorEvent = {
      type: undefined,
      exception: { values: [{ type: 'Error', value: 'boom at https://app.example/r/K7QXM?x=1' }] },
      request: { url: 'https://app.example/r/K7QXM?invite=1', headers: { Referer: 'x' } },
      breadcrumbs: [{ message: 'console: secret build output' }],
    };
    const out = prepareBrowserEvent(event, '/r/K7QXM', false);
    expect(out?.tags).toEqual({
      route: '/r/[code]',
      runtime: 'browser',
      phase: 'building',
      mode: 'multiplayer',
      room_id: ROOM,
      battle_id: BATTLE,
    });
    expect(out?.request).toEqual({ url: 'https://app.example/r/[code]' });
    expect(JSON.stringify(out)).not.toContain('K7QXM');
    expect(out?.breadcrumbs).toBeUndefined();
    // No user known yet: no user.
    expect(out?.user).toBeUndefined();
  });

  it('a room code is never a room_id tag', () => {
    setTelemetryContext({ roomId: 'K7QXM' });
    expect(prepareBrowserEvent({ type: undefined }, '/', false)?.tags?.['room_id']).toBeUndefined();
  });
});
