/**
 * Cloudflare Browser Rendering adapter: SHAPE ONLY, not implemented and never run (no
 * Cloudflare account yet, and the service cannot be emulated locally). `render()` throws
 * `RenderError('not-implemented')`, so selecting it by mistake fails every capture loudly
 * instead of storing wrong screenshots.
 *
 * Two ways to use Browser Rendering, and why the first one is the plan:
 *
 * 1. **Workers binding + `@cloudflare/playwright`** (recommended). The capture worker runs
 *    as a Cloudflare Worker (or Durable Object) with a `browser` binding and launches the
 *    browser through it. That API is Playwright's, so `PlaywrightRenderer`'s logic (context
 *    per capture, `context.route` navigation guard, `request`/`requestfinished` events for
 *    network idle, console hints for `ready`, the 6 s cap, the hard timeout) carries over
 *    nearly unchanged; only `chromium.launch()` changes. Needs: the job loop to run in
 *    workerd (fetch-based `SupabaseBackend` already does; `sharp` does not, so WebP encoding
 *    moves to Cloudflare Images or the screenshot is stored as PNG, which the `screenshots`
 *    bucket accepts).
 *
 * 2. **REST API** (`POST /accounts/{account_id}/browser-rendering/screenshot`). Callable from
 *    this Node process, but it only offers coarse controls: a goto `waitUntil`, a
 *    `waitForSelector`, and request allow/reject patterns. It cannot express "ready signal OR
 *    network idle + 2 s, capped at 6 s" or "abort every navigation except this one" exactly.
 *    `screenshotRequestBody` below shows the closest mapping (the capture page sets
 *    `html[data-br-capture=ready]` on `buildRoulette.ready()`). It has no navigation guard:
 *    only the capture page's CSP `sandbox` would stop a build from navigating the page, so
 *    this route is weaker than option 1. Field names follow the public docs as of 2026-10
 *    and are UNVERIFIED against the live API.
 */
import { RenderError, type RenderRequest, type RenderResult, type Renderer } from './renderer';

export interface BrowserRenderingOptions {
  accountId: string;
  /** API token with the Browser Rendering permission. Never logged. */
  apiToken: string;
}

/** Closest REST mapping of a capture (see the module comment; unverified). */
export function screenshotRequestBody(req: RenderRequest, capMs = 6000): Record<string, unknown> {
  return {
    url: req.url,
    viewport: { ...req.viewport, deviceScaleFactor: 1 },
    gotoOptions: { waitUntil: 'networkidle0', timeout: req.timeoutMs },
    // The ready hint, bounded by the cap. Without the signal the call waits the full cap.
    waitForSelector: { selector: 'html[data-br-capture="ready"]', timeout: capMs },
    screenshotOptions: { type: 'png', fullPage: false },
  };
}

export class BrowserRenderingRenderer implements Renderer {
  constructor(readonly opts: BrowserRenderingOptions) {}

  render(): Promise<RenderResult> {
    return Promise.reject(
      new RenderError(
        'not-implemented',
        'BrowserRenderingRenderer is a sketch; use PlaywrightRenderer (see the module comment)',
      ),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
