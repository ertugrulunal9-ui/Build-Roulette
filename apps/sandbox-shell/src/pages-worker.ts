/**
 * Cloudflare Pages advanced-mode worker (`dist/_worker.js`): the capture gate in front of the
 * static shell. Built by scripts/build.ts together with `dist/_routes.json`, which limits the
 * worker to `/v{N}/capture`; every other path is a plain static asset with the `_headers`
 * rules.
 *
 * The HMAC secret is a Pages secret (`wrangler pages secret put CAPTURE_HMAC_SECRET`), the
 * same value the capture worker signs with. It exists only in this worker's environment and
 * in the capture worker: never in a static file, never in the page's JS.
 *
 * Not deployed or run in workerd yet (no Cloudflare account); the gate itself is unit tested
 * with Fetch API Requests in Node (test/capture-gate.test.ts).
 */
import { CAPTURE_PATH, handleCaptureRequest } from './capture-gate';

/** `captureHeaders(...)` for the production origins, baked in at build time. */
declare const __BR_CAPTURE_HEADERS__: Record<string, string>;

interface PagesEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CAPTURE_HMAC_SECRET?: string;
}

export default {
  async fetch(request: Request, env: PagesEnv): Promise<Response> {
    if (new URL(request.url).pathname === CAPTURE_PATH) {
      return handleCaptureRequest(request, {
        secret: env.CAPTURE_HMAC_SECRET,
        headers: __BR_CAPTURE_HEADERS__,
      });
    }
    return env.ASSETS.fetch(request);
  },
};
