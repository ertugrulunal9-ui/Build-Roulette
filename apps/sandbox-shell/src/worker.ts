/**
 * The sandbox shell's Worker (T-043; Cloudflare Workers with static assets, `wrangler.jsonc`):
 * the capture gate in front of the static shell. scripts/build.ts bundles it into
 * `dist/worker.js` (kept out of the uploaded assets by `dist/.assetsignore`). The config's
 * `run_worker_first: ["/v2/capture"]` sends only the capture path here; every other path is a
 * static asset with the `_headers` rules and invokes no Worker.
 *
 * The HMAC secret is the Worker secret `CAPTURE_HMAC_SECRET` (`wrangler deploy
 * --secrets-file`, scripts/deploy), the same value the capture side signs with. It exists only
 * in this Worker's environment and in the capture side: never in a static file, never in the
 * page's JS.
 *
 * The gate itself is unit tested with Fetch API Requests in Node (test/capture-gate.test.ts).
 */
import { CAPTURE_PATH, handleCaptureRequest } from './capture-gate';

/** `captureHeaders(...)` for the production origins, baked in at build time. */
declare const __BR_CAPTURE_HEADERS__: Record<string, string>;

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  CAPTURE_HMAC_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === CAPTURE_PATH) {
      return handleCaptureRequest(request, {
        secret: env.CAPTURE_HMAC_SECRET,
        headers: __BR_CAPTURE_HEADERS__,
      });
    }
    // Only reached if the routing ever sends another path here: the static answer.
    return env.ASSETS.fetch(request);
  },
};
