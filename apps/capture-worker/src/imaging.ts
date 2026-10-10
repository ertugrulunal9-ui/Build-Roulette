/**
 * How a capture turns a render (or the client thumbnail) into the stored screenshot. Two
 * implementations, behind the same capture job:
 *
 * - `sharpImaging` (image.ts, Node only): the self-hosted worker. Decodes the PNG, checks
 *   the pixels for a blank render, encodes WebP at quality 70 (stepping down to fit the
 *   bucket's 2 MB); thumbnails are decoded, scaled to fit and re-encoded.
 * - `webpImaging` (here, pure TS): the `jobs` Edge Function (T-034). Browser Rendering
 *   already returns WebP at quality 70, so nothing is encoded. A blank render is what the
 *   capture page reported (`paint: 'empty'`: nothing rendered in the build's frame); the
 *   WebP's size must be the viewport's. Thumbnails are rebuilt by `sanitizeWebp` (webp.ts).
 */
import type { RenderResult } from './renderer';
import { WebpError, parseWebp, sanitizeWebp } from './webp';

/** The `screenshots` bucket's file size limit. */
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
/**
 * Quality of the stored WebP (the worker's sharp encoding and the REST screenshot). 70 since
 * T-036 (82 before): screenshots are permanent, and Supabase Free has 1 GB of storage and
 * 5 GB of egress a month. On 18 sample apps at 1280×800 (`pnpm measure:screenshots`,
 * docs/08 §6.3) it stores 21 % less (mean 77.0 → 60.9 KiB, median 25.5 → 19.8 KiB) with no
 * difference visible at 2× zoom; SSIM against a lossless shot 0.9926 → 0.9897 (mean).
 */
export const SCREENSHOT_WEBP_QUALITY = 70;

export type ScreenshotCheck = { ok: true; webp: Uint8Array } | { ok: false; reason: string };

export interface CaptureImaging {
  /** The WebP to store for a render, or why the render is not usable (blank, …). */
  screenshot(
    render: RenderResult,
    viewport: { width: number; height: number },
  ): Promise<ScreenshotCheck>;
  /** The WebP to store for a client thumbnail. Throws when the thumbnail is not usable. */
  thumbnail(bytes: Uint8Array, fit: { width: number; height: number }): Promise<Uint8Array>;
}

export const webpImaging: CaptureImaging = {
  screenshot(render, viewport) {
    if (render.format !== 'webp') {
      return Promise.resolve({ ok: false, reason: `expected a WebP render, got ${render.format}` });
    }
    if (render.paint === 'empty') {
      return Promise.resolve({
        ok: false,
        reason: 'blank render (the capture page found nothing rendered in the build frame)',
      });
    }
    try {
      const info = parseWebp(render.image);
      if (info.width !== viewport.width || info.height !== viewport.height) {
        return Promise.resolve({
          ok: false,
          reason: `render is ${String(info.width)}×${String(info.height)}, not the viewport`,
        });
      }
      return Promise.resolve({
        ok: true,
        webp: sanitizeWebp(render.image, {
          maxWidth: viewport.width,
          maxHeight: viewport.height,
          maxBytes: MAX_SCREENSHOT_BYTES,
        }),
      });
    } catch (e) {
      if (e instanceof WebpError) return Promise.resolve({ ok: false, reason: e.message });
      throw e;
    }
  },

  thumbnail(bytes, fit) {
    return Promise.resolve(
      sanitizeWebp(bytes, {
        maxWidth: fit.width,
        maxHeight: fit.height,
        maxBytes: MAX_SCREENSHOT_BYTES,
      }),
    );
  },
};
