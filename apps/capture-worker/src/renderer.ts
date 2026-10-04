/**
 * The headless browser behind a capture. `PlaywrightRenderer` (local Chromium) implements
 * it today; `BrowserRenderingRenderer` sketches Cloudflare Browser Rendering for production.
 *
 * A renderer gets a signed capture URL and must:
 * - open it top-level at the fixed viewport (1280×800, DPR 1) in a fresh browser context;
 * - allow only that one top-level navigation (abort every other top-level or frame
 *   navigation and close popups);
 * - decide readiness itself (readiness.ts: ready signal, network idle + 2 s, 6 s cap);
 * - stop at `timeoutMs` no matter what the page does (infinite loops included);
 * - return a PNG of the viewport.
 */
import type { ReadyReason } from './readiness';

export interface RenderRequest {
  /** The signed capture page URL. */
  url: string;
  viewport: { width: number; height: number };
  /** Hard limit for the whole capture, navigation to screenshot. */
  timeoutMs: number;
  /** Aborts the capture (worker shutdown). */
  signal?: AbortSignal;
}

export interface RenderResult {
  png: Uint8Array;
  ready: { reason: ReadyReason; afterMs: number };
  durationMs: number;
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
  | 'browser'; // the browser could not be started or crashed

export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RenderError';
  }
}

export interface Renderer {
  render(req: RenderRequest): Promise<RenderResult>;
  close(): Promise<void>;
}
