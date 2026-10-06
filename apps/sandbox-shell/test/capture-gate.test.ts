import { describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_HTML,
  CAPTURE_PATH,
  CAPTURE_VIEWPORT,
  handleCaptureRequest,
} from '../src/capture-gate';
import { signCaptureUrl } from '../src/capture-sig';
import { captureHeaders } from '../src/headers';
import pagesWorker from '../src/pages-worker';

const SECRET = 'gate-secret-0123456789abcdef0123456789abcdef';
const NOW_MS = 1_800_000_000_000;
const HEADERS = captureHeaders({
  appOrigins: ['https://buildroulette.app'],
  cdnOrigin: 'https://pkg.example.net',
});
const CAPTURE_URL = `https://b1.usercontent.example${CAPTURE_PATH}`;

async function signed(exp = NOW_MS / 1000 + 60): Promise<string> {
  return signCaptureUrl({
    captureUrl: CAPTURE_URL,
    src: 'https://db.example.co/bundle.js?token=t',
    exp,
    secret: SECRET,
  });
}

const gate = (
  url: string,
  init?: RequestInit,
  { secret }: { secret?: string } = { secret: SECRET },
) => {
  const onReject = vi.fn();
  return {
    onReject,
    response: handleCaptureRequest(new Request(url, init), {
      secret,
      headers: HEADERS,
      now: () => NOW_MS,
      onReject,
    }),
  };
};

describe('capture gate', () => {
  it('serves the capture page for a valid signature, with the capture headers', async () => {
    const { response } = gate(await signed());
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(HEADERS['Content-Security-Policy']);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toBe(CAPTURE_HTML);
    expect(html).toContain('<script src="./capture.js"></script>');
    expect(html).toContain(`width: ${String(CAPTURE_VIEWPORT.width)}px`);
    // The page embeds nothing from the request.
    expect(html).not.toContain('db.example.co');
  });

  it('HEAD gets the headers without a body', async () => {
    const res = await gate(await signed(), { method: 'HEAD' }).response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('renders nothing (empty 403, no-store) for a bad, expired or missing signature', async () => {
    const good = await signed();
    const cases: [string, string][] = [
      [good.replace('sig=', 'sig=A'), 'bad-signature'],
      [await signed(NOW_MS / 1000 - 1), 'expired'],
      [CAPTURE_URL, 'missing-param'],
      [
        `${CAPTURE_URL}?src=https://evil.example/x.js&exp=9999999999&sig=${'A'.repeat(43)}`,
        'bad-signature',
      ],
    ];
    for (const [url, reason] of cases) {
      const { response, onReject } = gate(url);
      const res = await response;
      expect(res.status, reason).toBe(403);
      expect(await res.text(), reason).toBe('');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(onReject).toHaveBeenCalledWith(reason);
    }
  });

  it('answers 503 when no secret is configured and 405 for other methods', async () => {
    const url = await signed();
    expect((await gate(url, undefined, {}).response).status).toBe(503);
    expect((await gate(url, undefined, { secret: '' }).response).status).toBe(503);
    expect((await gate(url, { method: 'POST', body: 'x' }).response).status).toBe(405);
  });
});

describe('Pages worker (_worker.js)', () => {
  // The define is replaced at build time; tests provide it as a global.
  (globalThis as Record<string, unknown>)['__BR_CAPTURE_HEADERS__'] = HEADERS;

  it('routes only the capture path to the gate, everything else to the static assets', async () => {
    vi.useFakeTimers({ now: NOW_MS, toFake: ['Date'] });
    try {
      const assets = { fetch: vi.fn(() => Promise.resolve(new Response('static'))) };
      const env = { ASSETS: assets, CAPTURE_HMAC_SECRET: SECRET };
      const page = await pagesWorker.fetch(new Request(await signed()), env);
      expect(page.status).toBe(200);
      expect(await page.text()).toBe(CAPTURE_HTML);
      const refused = await pagesWorker.fetch(new Request(CAPTURE_URL), env);
      expect(refused.status).toBe(403);
      expect(assets.fetch).not.toHaveBeenCalled();
      const other = await pagesWorker.fetch(
        new Request('https://b1.usercontent.example/v1/shell.js'),
        env,
      );
      expect(await other.text()).toBe('static');
      expect(assets.fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
