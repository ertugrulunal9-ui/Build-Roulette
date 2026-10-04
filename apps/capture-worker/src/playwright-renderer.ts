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

  async render(req: RenderRequest): Promise<RenderResult> {
    const started = Date.now();
    const deadline = started + req.timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
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
      context.on('page', (p) => {
        if (p === page) return;
        blocked.popups++;
        void p.close().catch(() => undefined);
      });
      page.on('dialog', (d) => {
        void d.dismiss().catch(() => undefined);
      });

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
        note(redactUrls(hint));
      });
      page.on('pageerror', (e) => {
        note(`pageerror: ${redactUrls(e.message)}`);
      });
      page.on('response', (r) => {
        const request = r.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          nav.status ??= r.status();
        }
      });

      const response = await page.goto(req.url, { waitUntil: 'load', timeout: remaining() });
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
        if (stop.reason) throw new RenderError(stop.reason, 'stopped while waiting');
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
        sleep(Math.min(this.settleMs, remaining())),
      ]);

      if (page.url() !== req.url) {
        throw new RenderError('navigation', 'the page is no longer at the capture URL');
      }
      const png = await page.screenshot({
        type: 'png',
        timeout: remaining(),
        animations: 'allow',
        caret: 'initial',
      });
      if (page.url() !== req.url) {
        throw new RenderError('navigation', 'the page left the capture URL during the screenshot');
      }
      return {
        png: new Uint8Array(png),
        ready: { reason: decision.reason, afterMs: decision.afterMs },
        durationMs: Date.now() - started,
        blocked,
        notes,
      };
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
}
