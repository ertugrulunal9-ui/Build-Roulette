/**
 * The Browser Rendering stand-in refuses what it does not implement (T-034), so the function
 * cannot quietly start relying on an option the tests never exercise. Its rendering runs in
 * integration/function.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { snapshotRequestBody } from '../src/browser-rendering';
import { parseSnapshotRequest } from '../src/stand-in';

const URL_ = 'http://127.0.0.1:4321/v1/capture?src=x&exp=1&sig=y';

describe('stand-in request validation', () => {
  it("accepts exactly the function's request and reads it like Puppeteer would", () => {
    const parsed = parseSnapshotRequest(
      snapshotRequestBody({ url: URL_, viewport: { width: 1280, height: 800 } }),
    );
    expect(parsed).toEqual({
      url: URL_,
      viewport: { width: 1280, height: 800 },
      goto: { waitUntil: 'load', timeout: 10_000 },
      selector: { selector: 'html[data-br-capture]', timeout: 6000, state: 'attached' },
      waitForTimeout: 0,
      bestAttempt: true,
      actionTimeout: 10_000,
      shot: { format: 'webp', quality: 82 },
    });
  });

  it('refuses fields and values it does not implement', () => {
    const base = { url: URL_ };
    const refused: [string, unknown][] = [
      ['not an object', 'x'],
      ['no url', {}],
      ['non-http url', { url: 'file:///etc/passwd' }],
      ['unknown field', { ...base, addScriptTag: [{ content: 'x' }] }],
      ['rejectRequestPattern', { ...base, rejectRequestPattern: ['x'] }],
      ['DPR 2', { ...base, viewport: { width: 10, height: 10, deviceScaleFactor: 2 } }],
      ['waitUntil', { ...base, gotoOptions: { waitUntil: 'commit' } }],
      ['screenshot type', { ...base, screenshotOptions: { type: 'gif' } }],
      ['fullPage', { ...base, screenshotOptions: { fullPage: true } }],
      ['clip', { ...base, screenshotOptions: { clip: { x: 0, y: 0, width: 1, height: 1 } } }],
      ['formats', { ...base, formats: ['markdown'] }],
      ['negative timeout', { ...base, actionTimeout: -1 }],
    ];
    for (const [what, body] of refused) {
      expect(() => parseSnapshotRequest(body), what).toThrow();
    }
  });
});
