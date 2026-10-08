/**
 * Error reporting (T-030): only the CDN's own 500/502 failures go to Sentry, scrubbed, and
 * only with SENTRY_DSN; package problems (4xx), load shedding and timeouts never do.
 */
import { startFakeIngest, type FakeIngest } from '@br/telemetry/testing';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PackageCdn } from '../src/cdn';
import { CdnError } from '../src/errors';
import { cdnReporter, reportServerErrors } from '../src/reporting';
import { createCdnHandler, type HandlerOptions } from '../src/server';

let ingest: FakeIngest;
let failure: unknown;
let server: Server;
let base: string;

/** A CDN whose resolve step fails with `failure`. */
const stubCdn = {
  config: { requestTimeoutMs: 10_000 },
  resolve: () => Promise.reject(failure instanceof Error ? failure : new Error('x')),
  metrics: () => ({}),
} as unknown as PackageCdn;

async function serve(onServerError: NonNullable<HandlerOptions['onServerError']>) {
  const handle = createCdnHandler(stubCdn, { log: () => undefined, onServerError });
  server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${String(typeof addr === 'object' && addr ? addr.port : 0)}`;
}

async function stop() {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

beforeAll(async () => {
  ingest = await startFakeIngest();
});
afterAll(async () => {
  await ingest.close();
});
beforeEach(() => {
  ingest.reset();
});

describe('pkg-cdn error reporting', () => {
  it('is off without SENTRY_DSN', async () => {
    const reporter = cdnReporter({});
    expect(reporter.enabled).toBe(false);
    await serve(reportServerErrors(reporter));
    failure = new TypeError('boom');
    expect((await fetch(`${base}/react@19.3.0`)).status).toBe(500);
    await reporter.flush(1_000);
    await stop();
    expect(ingest.requests).toHaveLength(0);
  });

  it('reports 500 and 502, not 4xx/503/504, with the path but no query string', async () => {
    const reporter = cdnReporter({ SENTRY_DSN: ingest.dsn(4), SENTRY_RELEASE: 'r1' });
    await serve(reportServerErrors(reporter));

    failure = new TypeError("Cannot read properties of undefined (reading 'version')");
    expect(
      (await fetch(`${base}/react@19.3.0/jsx-runtime?deps=react@19.3.0&token=s3cret`)).status,
    ).toBe(500);
    failure = new CdnError(502, 'registry-error', 'registry returned invalid JSON for react');
    expect((await fetch(`${base}/react@19.3.0`)).status).toBe(502);
    for (const [status, code] of [
      [404, 'unknown-package'],
      [403, 'denied'],
      [503, 'overloaded'],
      [504, 'timeout'],
    ] as const) {
      failure = new CdnError(status, code, code);
      expect((await fetch(`${base}/left-pad@1.0.0`)).status).toBe(status);
    }
    await reporter.flush(5_000);
    await stop();

    expect(ingest.sentryEvents).toHaveLength(2);
    const [internal, registry] = ingest.sentryEvents as {
      release: string;
      tags: Record<string, unknown>;
      request: { url: string; method: string };
      exception: { values: { type: string; value: string }[] };
    }[];
    expect(internal?.release).toBe('pkg-cdn@r1');
    expect(internal?.tags).toEqual({ service: 'pkg-cdn', status: 500, code: 'internal' });
    expect(internal?.request).toEqual({ url: '/react@19.3.0/jsx-runtime', method: 'GET' });
    expect(internal?.exception.values[0]?.type).toBe('TypeError');
    expect(registry?.tags).toEqual({ service: 'pkg-cdn', status: 502, code: 'registry-error' });
    expect(ingest.requests.map((r) => r.body).join('')).not.toContain('s3cret');
  });
});
