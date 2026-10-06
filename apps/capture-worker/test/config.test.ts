import { describe, expect, it } from 'vitest';
import { PREVIEW_SANDBOX_BY_MODE } from '@br/runtime';
import { CAPTURE_SANDBOX_FLAGS } from '@br/sandbox-shell/headers';
import { BrowserRenderingRenderer, screenshotRequestBody } from '../src/browser-rendering-renderer';
import { ConfigError, describeConfig, loadConfig } from '../src/config';
import { RenderError } from '../src/renderer';

const ENV = {
  SUPABASE_URL: 'http://127.0.0.1:54321/',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJ.service.key',
  CAPTURE_SHELL_URL: 'https://{build}.usercontent.example/v1/capture',
  CAPTURE_HMAC_SECRET: 'config-secret-0123456789abcdef0123456789abcdef',
  PKG_CDN_URL: 'https://pkg.example.net/',
};

describe('loadConfig', () => {
  it('reads the environment with defaults (concurrency 1, 20 s capture, 90 s job)', () => {
    const c = loadConfig(ENV);
    expect(c.capture).toEqual({
      shellCaptureUrl: ENV.CAPTURE_SHELL_URL,
      hmacSecret: ENV.CAPTURE_HMAC_SECRET,
      pkgCdnUrl: 'https://pkg.example.net',
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

  it('lists every problem at once', () => {
    try {
      loadConfig({
        CAPTURE_SHELL_URL: 'https://shell.example/v1/',
        CAPTURE_HMAC_SECRET: 'short',
        PKG_CDN_URL: 'ftp://x',
        CAPTURE_CONCURRENCY: '0',
        LOG_LEVEL: 'loud',
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toEqual([
        'SUPABASE_URL is required',
        'SUPABASE_SERVICE_ROLE_KEY is required',
        'CAPTURE_SHELL_URL must be the capture page URL (…/v1/capture, no query)',
        'CAPTURE_HMAC_SECRET must be at least 32 characters',
        'PKG_CDN_URL must be an http(s) URL',
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

describe('BrowserRenderingRenderer (sketch)', () => {
  it('fails loudly instead of pretending to capture', async () => {
    const r = new BrowserRenderingRenderer({ accountId: 'a', apiToken: 't' });
    await expect(r.render()).rejects.toBeInstanceOf(RenderError);
    await expect(r.render()).rejects.toThrow('not-implemented');
  });

  it('maps a capture to the REST screenshot body (shape only)', () => {
    const body = screenshotRequestBody({
      url: 'https://b.usercontent.example/v1/capture?sig=x',
      viewport: { width: 1280, height: 800 },
      timeoutMs: 20_000,
    });
    expect(body).toMatchObject({
      viewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      waitForSelector: { selector: 'html[data-br-capture="ready"]', timeout: 6000 },
      screenshotOptions: { type: 'png', fullPage: false },
    });
  });
});
