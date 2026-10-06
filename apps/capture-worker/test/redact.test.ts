import { describe, expect, it } from 'vitest';
import { redactUrls } from '../src/playwright-renderer';

describe('redactUrls', () => {
  it('keeps origin and path, drops queries (signed URLs carry tokens)', () => {
    const msg =
      'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at http://127.0.0.1:4331/v1/capture?exp=1&src=http%3A%2F%2Fdb%2Fsign%3Ftoken%3Dsecret&sig=abc';
    const out = redactUrls(msg);
    expect(out).toBe(
      'page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at http://127.0.0.1:4331/v1/capture?…',
    );
    expect(out).not.toContain('token');
    expect(out).not.toContain('sig=');
  });

  it('handles several URLs and leaves other text alone', () => {
    expect(redactUrls('a https://x.test/p?q=1 b "https://y.test/" c')).toBe(
      'a https://x.test/p?… b "https://y.test/" c',
    );
    expect(redactUrls('no urls here')).toBe('no urls here');
  });
});
