import { startFakeIngest, type FakeIngest } from '@br/telemetry/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeConfig, loadConfig } from '../src/config';
import { createLogger } from '../src/log';
import { REPORT_INTERVAL_MS, logTags, reportLogErrors, workerReporter } from '../src/reporting';

const BUILD = '3f2a8c1e-7b4d-4e2a-9c1f-0a1b2c3d4e5f';
const BATTLE = '1b2c3d4e-5f60-4718-9a0b-1c2d3e4f5a6b';
const USER = '9d8e7f6a-5b4c-4d3e-8f2a-1b0c9d8e7f6a';

const ENV = {
  SUPABASE_URL: 'http://127.0.0.1:54321/',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJ.service.key',
  CAPTURE_SHELL_URL: 'https://{build}.usercontent.example/v1/capture',
  CAPTURE_HMAC_SECRET: 'config-secret-0123456789abcdef0123456789abcdef',
  PKG_CDN_URL: 'https://pkg.example.net/',
};

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

describe('configuration', () => {
  it('is off without SENTRY_DSN, and says so (without the DSN) at startup', () => {
    const off = loadConfig(ENV);
    expect(off.telemetry).toEqual({ sentryDsn: null, environment: 'production', release: undefined });
    expect(describeConfig(off)['errorReporting']).toBe('off');
    const on = loadConfig({ ...ENV, SENTRY_DSN: ingest.dsn(), SENTRY_RELEASE: 'abc' });
    expect(describeConfig(on)['errorReporting']).toBe('sentry');
    expect(JSON.stringify(describeConfig(on))).not.toContain('public@');
  });

  it('a malformed DSN is a configuration error', () => {
    expect(() => loadConfig({ ...ENV, SENTRY_DSN: 'not-a-dsn' })).toThrow(/SENTRY_DSN/);
  });
});

describe('error log lines → Sentry', () => {
  it('sends nothing without a DSN', async () => {
    const reporter = workerReporter({ sentryDsn: null, environment: 'test', release: undefined });
    const log = createLogger({ write: () => undefined, onError: reportLogErrors(reporter) });
    log.error('claim.failed', { error: 'connect ECONNREFUSED' });
    await reporter.flush(1_000);
    expect(ingest.requests).toHaveLength(0);
  });

  it('reports error lines (scrubbed, tagged, grouped by message), not warnings, at most once a minute', async () => {
    const reporter = workerReporter({
      sentryDsn: ingest.dsn(5),
      environment: 'test',
      release: 'abc123',
    });
    let now = 1_000_000;
    const log = createLogger({
      write: () => undefined,
      onError: reportLogErrors(reporter, () => now),
    });
    const jobLog = log.child({ job: 42, kind: 'capture', ref: BUILD }).child({ attempt: 2 });
    jobLog.warn('capture.render_unusable', { reason: 'pageerror: user code threw' });
    jobLog.error('capture.error', {
      reason: `unexpected: upload failed: http://127.0.0.1:54321/storage/v1/object/sign/ephemeral-builds/${BATTLE}/${USER}/bundle.js?token=eyJabc.def.ghi`,
    });
    jobLog.error('capture.error', { reason: 'again, within the minute' });
    now += REPORT_INTERVAL_MS;
    jobLog.error('capture.error', { reason: 'a minute later' });
    expect(await reporter.flush(5_000)).toBe(true);

    expect(ingest.sentryEvents).toHaveLength(2);
    const ev = ingest.sentryEvents[0] as {
      message: string;
      level: string;
      release: string;
      fingerprint: string[];
      tags: Record<string, unknown>;
    };
    expect(ev.level).toBe('error');
    expect(ev.release).toBe('capture-worker@abc123');
    expect(ev.fingerprint).toEqual(['capture-worker', 'capture.error']);
    expect(ev.tags).toEqual({
      service: 'capture-worker',
      job_kind: 'capture',
      job_id: 42,
      attempt: 2,
      build_id: BUILD,
    });
    expect(ev.message).toBe(
      'capture.error: unexpected: upload failed: http://127.0.0.1:54321/storage/v1/object/sign/ephemeral-builds/[id]/[id]/bundle.js',
    );
    const raw = ingest.requests.map((r) => r.body).join('\n');
    for (const secret of [USER, 'token', 'eyJabc', 'user code threw']) {
      expect(raw, secret).not.toContain(secret);
    }
    expect((ingest.sentryEvents[1] as { message: string }).message).toBe(
      'capture.error: a minute later',
    );
  });

  it('a reporting failure never breaks logging', () => {
    const write = vi.fn();
    const log = createLogger({
      write,
      onError: () => {
        throw new Error('sentry down');
      },
    });
    expect(() => {
      log.error('claim.failed', {});
    }).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('logTags', () => {
  it('maps the job fields to tags: a destroy job refers to a battle', () => {
    expect(logTags({ job: 7, kind: 'destroy', ref: BATTLE })).toEqual({
      job_kind: 'destroy',
      job_id: 7,
      battle_id: BATTLE,
    });
    expect(logTags({ kind: 'takedown', build: BUILD })).toEqual({
      job_kind: 'takedown',
      build_id: BUILD,
    });
    expect(logTags({ loop: 'capture#0', ref: 'not-a-uuid' })).toEqual({});
  });
});
