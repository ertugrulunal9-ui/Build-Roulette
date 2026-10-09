/**
 * Local `Renderer` with Playwright + Chromium (`channel: 'chromium'`: full Chromium in new
 * headless mode, with site isolation, as the e2e suites use). The browser comes from
 * PLAYWRIGHT_BROWSERS_PATH (`/opt/pw-browsers` in the dev container) or the Playwright cache
 * in CI; this package never downloads one.
 *
 * One browser process, one fresh context per capture (no shared storage, cache or service
 * workers between builds), closed after the capture. Security measures, in addition to the
 * capture page's own CSP `sandbox` (no popups, no modals, no downloads):
 * - only ONE navigation is allowed: the main frame to the exact capture URL. Every other
 *   navigation request (the main frame again, any frame, any popup) is aborted, popups that
 *   still open are closed, and a capture whose page is no longer at the capture URL fails;
 * - dialogs are dismissed and downloads refused;
 * - a hard timer closes the context after `timeoutMs`, which also ends a page stuck in an
 *   infinite loop (its evaluate/screenshot calls reject).
 *
 * `session()` is that context on its own: `render()` runs the worker's capture in it, and the
 * Browser Rendering stand-in (stand-in.ts, T-034) runs the REST API's steps in it.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
  type Page,
} from 'playwright-core';
import { silentLogger, type Logger } from './log';
import { DEFAULT_READINESS, ReadinessTracker, type ReadinessOptions } from './readiness';
import { RenderError, type RenderRequest, type RenderResult, type Renderer } from './renderer';

/** Prefix of the capture page's console hints (apps/sandbox-shell/src/capture.ts). */
export const CAPTURE_HINT_PREFIX = '[br-capture] ';
const MAX_NOTES = 20;
const MAX_NOTE_CHARS = 300;
const POLL_MS = 50;

export interface PlaywrightRendererOptions {
  readiness?: ReadinessOptions;
  /** Upper bound for "fonts loaded + two animation frames" after readiness. */
  settleMs?: number;
  launch?: LaunchOptions;
  log?: Logger;
}

export interface SessionRequest {
  /** The URL the navigation guard lets through (the capture page). */
  url: string;
  viewport: { width: number; height: number };
  /** Hard limit: the context is closed at this point, whatever the page does. */
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Default true. The Browser Rendering stand-in turns it off, like the real REST API. */
  navigationGuard?: boolean;
}

export interface CaptureSession {
  page: Page;
  context: BrowserContext;
  /** `Date.now()` when the session started. */
  started: number;
  notes: string[];
  blocked: { navigations: number; popups: number };
  /** Ms left before the hard timeout (at least 1). */
  remaining(): number;
  /** Why the session was stopped (hard timeout, abort), or null while it runs. */
  stopped(): 'timeout' | 'aborted' | null;
  note(text: string): void;
}

/** Origin only: never log full URLs (signed URLs carry tokens). */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '(invalid url)';
  }
}

/**
 * Replaces every URL in a message with its origin and path: Playwright errors quote the
 * capture URL, whose query holds signed Storage URLs (tokens). Messages end up in logs and
 * in `jobs.last_error`.
 */
export function redactUrls(message: string): string {
  return message.replace(/\bhttps?:\/\/[^\s"'<>]+/g, (url) => {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
    } catch {
      return '(url)';
    }
  });
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class PlaywrightRenderer implements Renderer {
  private browser: Promise<Browser> | null = null;
  private readonly readiness: ReadinessOptions;
  private readonly settleMs: number;
  private readonly log: Logger;

  constructor(private readonly opts: PlaywrightRendererOptions = {}) {
    this.readiness = opts.readiness ?? DEFAULT_READINESS;
    this.settleMs = opts.settleMs ?? 1000;
    this.log = opts.log ?? silentLogger;
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browser) {
      const launching = chromium.launch({
        channel: 'chromium',
        headless: true,
        ...this.opts.launch,
      });
      this.browser = launching;
      launching.then(
        (b) => {
          b.on('disconnected', () => {
            // An unexpected exit (crash, OOM kill): the next capture launches a new browser.
            if (this.browser !== launching) return;
            this.browser = null;
            this.log.warn('renderer.browser_disconnected');
          });
        },
        () => {
          if (this.browser === launching) this.browser = null;
        },
      );
    }
    return this.browser;
  }

  async close(): Promise<void> {
    const b = this.browser;
    this.browser = null;
    if (b) await (await b.catch(() => null))?.close();
  }

  /**
   * Runs `fn` in a fresh browser context with the protections above, then tears it down.
   * Errors become `RenderError`s: `timeout` / `aborted` when the hard timer or the signal
   * ended the session, `shell-refused` when the capture page answered non-200, otherwise
   * `timeout`, `screenshot` or `navigation` from Playwright's error.
   */
  async session<T>(req: SessionRequest, fn: (s: CaptureSession) => Promise<T>): Promise<T> {
    const started = Date.now();
    const deadline = started + req.timeoutMs;
    if (req.signal?.aborted) throw new RenderError('aborted', 'aborted before start');

    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (e) {
      throw new RenderError('browser', e instanceof Error ? e.message : String(e));
    }

    let context: BrowserContext;
    try {
      context = await browser.newContext({
        viewport: req.viewport,
        deviceScaleFactor: 1,
        serviceWorkers: 'block',
        acceptDownloads: false,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'light',
      });
    } catch (e) {
      throw new RenderError('browser', e instanceof Error ? e.message : String(e));
    }

    const stop = { reason: null as null | 'timeout' | 'aborted' };
    let closed = false;
    const closeContext = () => {
      if (closed) return;
      closed = true;
      void context.close().catch(() => undefined);
    };
    const timer = setTimeout(() => {
      stop.reason ??= 'timeout';
      closeContext();
    }, req.timeoutMs);
    const onAbort = () => {
      stop.reason ??= 'aborted';
      closeContext();
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    const notes: string[] = [];
    const note = (s: string) => {
      if (notes.length < MAX_NOTES) notes.push(s.slice(0, MAX_NOTE_CHARS));
    };
    const blocked = { navigations: 0, popups: 0 };
    const nav = { status: null as number | null };

    try {
      const page: Page = await context.newPage();
      if (req.navigationGuard !== false) {
        let navigated = false;
        await context.route('**/*', async (route, request) => {
          if (!request.isNavigationRequest()) {
            await route.continue();
            return;
          }
          let isMain = false;
          try {
            isMain = request.frame() === page.mainFrame();
          } catch {
            // a request without a frame (e.g. from a popup that is already gone)
          }
          if (isMain && !navigated && request.url() === req.url) {
            navigated = true;
            await route.continue();
            return;
          }
          blocked.navigations++;
          note(`blocked navigation to ${originOf(request.url())}`);
          // A 204 answer cancels a navigation and leaves the current document in place
          // (HTML spec), so the capture page stays; aborting would commit an error page.
          await route.fulfill({ status: 204, body: '' });
        });
      }
      context.on('page', (p) => {
        if (p === page) return;
        blocked.popups++;
        void p.close().catch(() => undefined);
      });
      page.on('dialog', (d) => {
        void d.dismiss().catch(() => undefined);
      });
      page.on('response', (r) => {
        const request = r.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          nav.status ??= r.status();
        }
      });

      return await fn({
        page,
        context,
        started,
        notes,
        blocked,
        remaining: () => Math.max(1, deadline - Date.now()),
        stopped: () => stop.reason,
        note,
      });
    } catch (e) {
      if (stop.reason) {
        throw new RenderError(
          stop.reason,
          `capture stopped after ${String(Date.now() - started)} ms`,
        );
      }
      if (e instanceof RenderError) throw e;
      // Chromium turns an empty 4xx page into net::ERR_HTTP_RESPONSE_CODE_FAILURE.
      if (nav.status !== null && nav.status !== 200) {
        throw new RenderError('shell-refused', `the capture page answered HTTP ${nav.status}`);
      }
      const message = redactUrls(
        e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e),
      );
      if (e instanceof Error && e.name === 'TimeoutError')
        throw new RenderError('timeout', message);
      throw new RenderError(/screenshot/i.test(message) ? 'screenshot' : 'navigation', message);
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
      closeContext();
    }
  }

  async render(req: RenderRequest): Promise<RenderResult> {
    return this.session(req, async (s) => {
      const { page } = s;
      const tracker = new ReadinessTracker(this.readiness);
      const pageState = { failed: null as string | null };
      page.on('request', (r) => {
        tracker.requestStarted(r, Date.now());
      });
      page.on('requestfinished', (r) => {
        tracker.requestEnded(r, Date.now());
      });
      page.on('requestfailed', (r) => {
        tracker.requestEnded(r, Date.now());
      });
      page.on('console', (m) => {
        const text = m.text();
        if (!text.startsWith(CAPTURE_HINT_PREFIX)) return;
        const hint = text.slice(CAPTURE_HINT_PREFIX.length);
        if (hint === 'ready') tracker.readySignal();
        else if (hint.startsWith('failed')) pageState.failed = hint;
        s.note(redactUrls(hint));
      });
      page.on('pageerror', (e) => {
        s.note(`pageerror: ${redactUrls(e.message)}`);
      });

      const response = await page.goto(req.url, { waitUntil: 'load', timeout: s.remaining() });
      if (!response) throw new RenderError('navigation', 'no response for the capture page');
      if (response.status() !== 200) {
        throw new RenderError(
          'shell-refused',
          `the capture page answered HTTP ${response.status()}`,
        );
      }
      tracker.start(Date.now());

      let decision = tracker.decide(Date.now());
      while (!decision) {
        if (pageState.failed !== null)
          throw new RenderError('navigation', `capture page: ${pageState.failed}`);
        const stopped = s.stopped();
        if (stopped) throw new RenderError(stopped, 'stopped while waiting');
        await sleep(POLL_MS);
        decision = tracker.decide(Date.now());
      }
      if (pageState.failed !== null)
        throw new RenderError('navigation', `capture page: ${pageState.failed}`);

      // Fonts and two frames, in every frame, bounded: a frozen page never answers.
      await Promise.race([
        Promise.all(
          page.frames().map((f) =>
            f
              .evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    void document.fonts.ready.then(() => {
                      requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                          resolve();
                        });
                      });
                    });
                  }),
              )
              .catch(() => undefined),
          ),
        ),
        sleep(Math.min(this.settleMs, s.remaining())),
      ]);

      if (page.url() !== req.url) {
        throw new RenderError('navigation', 'the page is no longer at the capture URL');
      }
      const png = await page.screenshot({
        type: 'png',
        timeout: s.remaining(),
        animations: 'allow',
        caret: 'initial',
      });
      if (page.url() !== req.url) {
        throw new RenderError('navigation', 'the page left the capture URL during the screenshot');
      }
      return {
        image: new Uint8Array(png),
        format: 'png',
        ready: { reason: decision.reason, afterMs: decision.afterMs },
        durationMs: Date.now() - s.started,
        blocked: s.blocked,
        notes: s.notes,
      };
    });
  }
}
