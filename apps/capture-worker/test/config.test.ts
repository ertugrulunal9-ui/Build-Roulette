import { describe, expect, it } from 'vitest';
import { PREVIEW_SANDBOX_BY_MODE } from '@br/runtime';
import { CAPTURE_SANDBOX_FLAGS } from '@br/sandbox-shell/headers';
import { ConfigError, describeConfig, loadConfig } from '../src/config';

const ENV = {
  SUPABASE_URL: 'http://127.0.0.1:54321/',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJ.service.key',
  CAPTURE_SHELL_URL: 'https://{build}.usercontent.example/v2/capture',
  CAPTURE_HMAC_SECRET: 'config-secret-0123456789abcdef0123456789abcdef',
};

describe('loadConfig', () => {
  it('reads the environment with defaults (concurrency 1, 20 s capture, 90 s job)', () => {
    const c = loadConfig(ENV);
    expect(c.capture).toEqual({
      shellCaptureUrl: ENV.CAPTURE_SHELL_URL,
      hmacSecret: ENV.CAPTURE_HMAC_SECRET,
      signedUrlTtlSeconds: 120,
      captureTimeoutMs: 20_000,
      viewport: { width: 1280, height: 800 },
    });
    expect(c.runner).toEqual({
      captureConcurrency: 1,
      idleMinMs: 1000,
      idleMaxMs: 15_000,
      jobTimeoutMs: 90_000,
      shutdownGraceMs: 30_000,
    });
    expect(c.logLevel).toBe('info');
  });

  it('ignores a PKG_CDN_URL left from before import mode (T-046: no import map any more)', () => {
    const c = loadConfig({ ...ENV, PKG_CDN_URL: 'ftp://not even a url' });
    expect(c.capture).not.toHaveProperty('pkgCdnUrl');
    expect(JSON.stringify(describeConfig(c))).not.toContain('PKG_CDN');
  });

  it('lists every problem at once', () => {
    try {
      loadConfig({
        CAPTURE_SHELL_URL: 'https://shell.example/v2/',
        CAPTURE_HMAC_SECRET: 'short',
        CAPTURE_CONCURRENCY: '0',
        LOG_LEVEL: 'loud',
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toEqual([
        'SUPABASE_URL is required',
        'SUPABASE_SERVICE_ROLE_KEY is required',
        'CAPTURE_SHELL_URL must be the capture page URL (…/v2/capture, no query)',
        'CAPTURE_HMAC_SECRET must be at least 32 characters',
        'LOG_LEVEL must be debug, info, warn or error',
        'CAPTURE_CONCURRENCY must be an integer between 1 and 8',
      ]);
    }
  });

  it('keeps the job timeout inside the 2-minute lease and above two captures', () => {
    expect(() => loadConfig({ ...ENV, WORKER_JOB_TIMEOUT_MS: '120000' })).toThrow(
      'WORKER_JOB_TIMEOUT_MS must be an integer between 10000 and 105000',
    );
    expect(() =>
      loadConfig({ ...ENV, WORKER_JOB_TIMEOUT_MS: '30000', CAPTURE_TIMEOUT_MS: '20000' }),
    ).toThrow('at least twice CAPTURE_TIMEOUT_MS');
  });

  it('describeConfig never contains the secrets', () => {
    const text = JSON.stringify(describeConfig(loadConfig(ENV)));
    expect(text).not.toContain(ENV.CAPTURE_HMAC_SECRET);
    expect(text).not.toContain(ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect(text).toContain('usercontent.example');
  });
});

describe('capture sandbox flags', () => {
  it('the capture page CSP sandbox matches the runtime capture iframe flags', () => {
    expect([...CAPTURE_SANDBOX_FLAGS].sort()).toEqual(
      PREVIEW_SANDBOX_BY_MODE.capture.split(/\s+/).filter(Boolean).sort(),
    );
  });
});
