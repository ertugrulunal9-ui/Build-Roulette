/**
 * The capture gate: the only thing that serves the capture page (docs/03 §3.7).
 *
 * `GET /v{N}/capture?src=…&css=…&map=…&exp=…&sig=…` is answered with the capture page only
 * when the HMAC over the exact parameters is valid and unexpired (`capture-sig.ts`).
 * Anything else gets an empty 403, so the page renders nothing. The gate runs server-side
 * (Cloudflare Pages `_worker.js` in production, `server.ts` locally) because it needs the
 * shared secret; the page and `capture.js` are public and hold no secret.
 *
 * Fetch API only (Request/Response, WebCrypto), so the same code runs in Workers and Node.
 */
import { PROTOCOL_VERSION } from '@br/protocol';
import { verifyCaptureUrl, type CaptureRejectReason } from './capture-sig';

/** Path of the capture page, next to the shell (`/v1/capture`). */
export const CAPTURE_PATH = `/v${String(PROTOCOL_VERSION)}/capture`;

/** Fixed viewport of a capture (docs/03 §3.7). The renderer uses the same size at DPR 1. */
export const CAPTURE_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * The capture page. Static: it embeds no parameter. `capture.js` reads them from
 * `location.search`, which the gate verified before serving this document.
 * `data-br-capture-page` tells a renderer that reads the HTML (Browser Rendering's REST
 * `/snapshot`, T-034) that the gate served this page, rather than an empty 403.
 */
export const CAPTURE_HTML = `<!doctype html>
<html lang="en" data-br-capture-page="1">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=${String(CAPTURE_VIEWPORT.width)}" />
    <meta name="referrer" content="no-referrer" />
    <title>Build Roulette capture</title>
    <style>
      html,
      body {
        margin: 0;
        padding: 0;
        width: ${String(CAPTURE_VIEWPORT.width)}px;
        height: ${String(CAPTURE_VIEWPORT.height)}px;
        overflow: hidden;
        background: #fff;
      }
    </style>
    <script src="./capture.js"></script>
  </head>
  <body></body>
</html>
`;

export interface CaptureGateOptions {
  /** Shared HMAC secret. Missing: the gate answers 503 (capture not configured). */
  secret: string | undefined;
  /** Response headers of the capture page (`captureHeaders(...)` from headers.ts). */
  headers: Readonly<Record<string, string>>;
  /** Clock in ms (tests). */
  now?: () => number;
  /** Called with the reason when a request is refused (logging; never sent to the client). */
  onReject?: (reason: CaptureRejectReason | 'method' | 'not-configured') => void;
}

/** Answers a request for `CAPTURE_PATH`. The caller routes only that path here. */
export async function handleCaptureRequest(
  request: Request,
  opts: CaptureGateOptions,
): Promise<Response> {
  const refuse = (status: number): Response =>
    new Response(null, { status, headers: { ...opts.headers, 'Cache-Control': 'no-store' } });

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    opts.onReject?.('method');
    return refuse(405);
  }
  if (!opts.secret) {
    opts.onReject?.('not-configured');
    return refuse(503);
  }
  const nowSeconds = Math.floor((opts.now ?? Date.now)() / 1000);
  const result = await verifyCaptureUrl(request.url, opts.secret, nowSeconds);
  if (!result.ok) {
    opts.onReject?.(result.reason);
    return refuse(403);
  }
  return new Response(request.method === 'HEAD' ? null : CAPTURE_HTML, {
    status: 200,
    headers: { ...opts.headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
}
