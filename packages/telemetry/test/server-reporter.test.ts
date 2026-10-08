import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServerReporter, disabledReporter, usableDsn } from '../src/server-reporter';
import { startFakeIngest, type FakeIngest } from '../src/testing/fake-ingest';

const BATTLE = '3f2a8c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f';
const USER = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';

let ingest: FakeIngest;
beforeAll(async () => {
  ingest = await startFakeIngest();
});
afterAll(async () => {
  await ingest.close();
});
beforeEach(() => {
  ingest.reset();
});

describe('env gating', () => {
  it('is off without a DSN, with an empty one and with a malformed one', () => {
    for (const dsn of [undefined, null, '', '   ', 'not a dsn']) {
      expect(createServerReporter({ dsn, service: 'test' })).toBe(disabledReporter);
    }
    expect(usableDsn(ingest.dsn())).toBe(ingest.dsn());
  });

  it('sends nothing when off', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const r = createServerReporter({ dsn: '', service: 'test', fetch: fetchSpy });
    expect(r.enabled).toBe(false);
    expect(r.captureException(new Error('x'))).toBeUndefined();
    expect(r.captureMessage('x')).toBeUndefined();
    await r.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('with a DSN (a local fake ingest)', () => {
  it('sends an exception, scrubbed, with the service, release and tags', async () => {
    const r = createServerReporter({
      dsn: ingest.dsn(7),
      service: 'web',
      release: 'build-roulette-web@abc123',
      environment: 'test',
      runtime: { name: 'node' },
    });
    expect(r.enabled).toBe(true);
    const err = new Error(
      `upload failed for ephemeral-builds/${BATTLE}/${USER}/bundle.js?token=s3cr3t-signature-value`,
    );
    const id = r.captureException(err, {
      tags: { battle_id: BATTLE, phase: 'results', display_name: 'Ana', room_id: 'K7QXM' },
      url: `/battles/${BATTLE}?utm=x`,
      method: 'GET',
      userHash: '0123456789abcdef0123456789abcdef',
    });
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await r.flush(5_000)).toBe(true);

    expect(ingest.requests).toHaveLength(1);
    expect(ingest.requests[0]?.url).toMatch(/^\/api\/7\/envelope\/\?/);
    expect(ingest.sentryEvents).toHaveLength(1);
    const ev = ingest.sentryEvents[0] as {
      release: string;
      environment: string;
      tags: Record<string, string>;
      request: { url: string; method: string };
      user: { id: string };
      exception: { values: { type: string; value: string; stacktrace: { frames: unknown[] } }[] };
      contexts: { runtime: { name: string } };
      server_name?: string;
    };
    expect(ev.release).toBe('build-roulette-web@abc123');
    expect(ev.environment).toBe('test');
    expect(ev.tags).toEqual({ service: 'web', battle_id: BATTLE, phase: 'results' });
    expect(ev.request).toEqual({ url: '/battles/[id]', method: 'GET' });
    expect(ev.user).toEqual({ id: '0123456789abcdef0123456789abcdef' });
    expect(ev.contexts.runtime.name).toBe('node');
    expect(ev.server_name).toBeUndefined();
    const ex = ev.exception.values[0];
    expect(ex?.type).toBe('Error');
    expect(ex?.value).toBe('upload failed for ephemeral-builds/<id>/<id>/bundle.js?token=<value>');
    expect(ex?.stacktrace.frames.length).toBeGreaterThan(0);
    const raw = ingest.requests[0]?.body ?? '';
    for (const secret of [USER, 'Ana', 'K7QXM', 'utm=x', 's3cr3t']) {
      expect(raw, secret).not.toContain(secret);
    }
  });

  it('sends a message at the given level', async () => {
    const r = createServerReporter({ dsn: ingest.dsn(), service: 'capture-worker' });
    r.captureMessage('claim.failed', { level: 'warning', tags: { job_kind: 'capture' } });
    await r.flush(5_000);
    const ev = ingest.sentryEvents[0] as { message: string; level: string; tags: object };
    expect(ev.message).toBe('claim.failed');
    expect(ev.level).toBe('warning');
    expect(ev.tags).toEqual({ service: 'capture-worker', job_kind: 'capture' });
  });

  it('a slow or failing ingest never throws into the caller', async () => {
    const failing: typeof fetch = () => Promise.reject(new Error('network down'));
    const r = createServerReporter({ dsn: ingest.dsn(), service: 'web', fetch: failing });
    expect(() => r.captureException(new Error('x'))).not.toThrow();
    await expect(r.flush(2_000)).resolves.toBeTypeOf('boolean');
  });
});
