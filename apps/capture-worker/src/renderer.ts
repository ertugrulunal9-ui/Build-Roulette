/**
 * The headless browser behind a capture. Two implementations:
 * - `PlaywrightRenderer` (local Chromium): the self-hosted worker (apps/capture-worker).
 * - `BrowserRenderingRenderer` (Cloudflare Browser Rendering's REST API): the `jobs` Edge
 *   Function on the free plan (T-034, supabase/functions/jobs).
 *
 * A renderer gets a signed capture URL and must:
 * - open it top-level at the fixed viewport (1280×800, DPR 1) in a fresh browser session;
 * - wait for readiness: the build's ready signal, capped at 6 s (readiness.ts; the
 *   Playwright renderer also takes network idle + 2 s);
 * - stop at `timeoutMs` no matter what the page does (infinite loops included);
 * - return a screenshot of the viewport (PNG from Playwright, WebP from Browser Rendering).
 */
import type { ReadyReason } from './readiness';

export interface RenderRequest {
  /** The signed capture page URL. */
  url: string;
  viewport: { width: number; height: number };
  /** Hard limit for the whole capture, navigation to screenshot. */
  timeoutMs: number;
  /** Aborts the capture (worker shutdown, end of a function run). */
  signal?: AbortSignal;
}

/** What the capture page reported about the build's frame when the shot was taken. */
export type PaintReport = 'content' | 'empty';

export interface RenderResult {
  /** The screenshot of the viewport. */
  image: Uint8Array;
  format: 'png' | 'webp';
  ready: { reason: ReadyReason; afterMs: number };
  durationMs: number;
  /**
   * The capture page's own check of the build's frame (REST renderer only, which cannot
   * look at pixels without a WebP decoder): `empty` when nothing was rendered. Untrusted, but
   * a build can only affect its own screenshot with it. Absent: check the pixels.
   */
  paint?: PaintReport;
  /** Browser time this render was billed for (REST renderer: the budget counts it). */
  browserMs?: number;
  /** Navigations and popups that were blocked (for logs). */
  blocked: { navigations: number; popups: number };
  /** `[br-capture]` hints and page errors (untrusted, for logs only), capped. */
  notes: string[];
}

export type RenderErrorCode =
  | 'shell-refused' // the capture gate did not serve the page (bad signature, expired, …)
  | 'navigation' // the page could not be loaded
  | 'timeout' // the hard per-capture timeout fired
  | 'aborted' // the caller aborted (shutdown)
  | 'screenshot' // the screenshot itself failed
  | 'not-implemented'
  | 'browser' // the browser could not be started or crashed
  // Service-side (T-034, Browser Rendering): not the build's fault, so the capture is
  // retried before it falls back to the client thumbnail (capture-policy.ts).
  | 'rate-limited' // HTTP 429 (rate limit, or the account's browser time is used up)
  | 'unavailable'; // 5xx, network error, no answer in time, or a rejected API token

export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
    readonly extra: {
      /** Browser time used before the failure (REST renderer). */
      browserMs?: number;
      /** `Retry-After` of a 429, in ms. */
      retryAfterMs?: number;
    } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = 'RenderError';
  }
}

export interface Renderer {
  render(req: RenderRequest): Promise<RenderResult>;
  close(): Promise<void>;
}
