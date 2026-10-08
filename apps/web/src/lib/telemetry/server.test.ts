import { startFakeIngest, type FakeIngest } from '@br/telemetry/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isControlFlow, reportRequestError, resetServerReporter } from './server';

const BATTLE = '3f2a8c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f';

let ingest: FakeIngest;
beforeAll(async () => {
  ingest = await startFakeIngest();
});
afterAll(async () => {
  await ingest.close();
});
beforeEach(() => {
  ingest.reset();
  resetServerReporter();
});

const context = {
  routePath: '/battles/[id]',
  routeType: 'render',
  renderSource: 'server-rendering',
};

async function settle(): Promise<void> {
  // The reporter flushes in the background (waitUntil on Workers).
  await new Promise((r) => setTimeout(r, 300));
}

describe('reportRequestError', () => {
  it('sends nothing without a DSN', async () => {
    reportRequestError(new Error('x'), { path: '/play', method: 'GET' }, context, {});
    await settle();
    expect(ingest.requests).toHaveLength(0);
  });

  it('reports a server error with the route, the battle id and the digest, without the query', async () => {
    const err = Object.assign(new Error(`fetch failed for battle ${BATTLE}`), { digest: '12345' });
    reportRequestError(
      err,
      { path: `/battles/${BATTLE}?utm_source=x&name=Ana`, method: 'GET' },
      context,
      { SENTRY_DSN: ingest.dsn(3), SENTRY_ENVIRONMENT: 'staging' },
    );
    await settle();
    expect(ingest.sentryEvents).toHaveLength(1);
    const ev = ingest.sentryEvents[0] as {
      environment: string;
      release: string;
      tags: Record<string, string>;
      request: { url: string; method: string };
      exception: { values: { value: string }[] };
    };
    expect(ev.environment).toBe('staging');
    expect(ev.release).toMatch(/^build-roulette-web@/);
    expect(ev.tags).toEqual({
      service: 'web',
      route: '/battles/[id]',
      route_type: 'render',
      render_source: 'server-rendering',
      runtime: 'node',
      digest: '12345',
      battle_id: BATTLE,
    });
    expect(ev.request).toEqual({ url: '/battles/[id]', method: 'GET' });
    expect(ev.exception.values[0]?.value).toBe('fetch failed for battle <id>');
    expect(ingest.requests[0]?.body).not.toContain('utm_source');
    expect(ingest.requests[0]?.body).not.toContain('Ana');
  });

  it("skips Next's control flow (notFound, redirect)", async () => {
    for (const digest of [
      'NEXT_NOT_FOUND',
      'NEXT_REDIRECT;replace;/admin;307;',
      'NEXT_HTTP_ERROR_FALLBACK;404',
    ]) {
      const err = Object.assign(new Error(digest), { digest });
      expect(isControlFlow(err)).toBe(true);
      reportRequestError(err, { path: '/admin', method: 'GET' }, context, {
        SENTRY_DSN: ingest.dsn(),
      });
    }
    await settle();
    expect(ingest.requests).toHaveLength(0);
  });
});
