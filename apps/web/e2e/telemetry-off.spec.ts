import { startFakeIngest } from '@br/telemetry/testing';
import { expect, test } from '@playwright/test';
import { openPlayground } from './helpers';
import { INGEST_PORT, createRoomAs, throwInPage } from './telemetry';

/**
 * Error reporting and analytics OFF (T-030): a build without `NEXT_PUBLIC_SENTRY_DSN` and
 * `NEXT_PUBLIC_POSTHOG_KEY` (the plain `pnpm build`). Through a landing page, a room, an error
 * and the playground, nothing is requested from any host but the app, Supabase and the
 * sandbox servers, the Sentry SDK is never loaded, and the fake ingest hears nothing.
 */
test('without a DSN or a key, nothing is loaded and nothing is sent', async ({ page }) => {
  const ingest = await startFakeIngest(INGEST_PORT);
  const hosts = new Set<string>();
  const scripts: Promise<string>[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('data:') && !r.url().startsWith('blob:'))
      hosts.add(new URL(r.url()).host);
  });
  page.on('response', (r) => {
    if (r.request().resourceType() === 'script') scripts.push(r.text().catch(() => ''));
  });

  await createRoomAs(page, 'Quiet Quinn');
  await throwInPage(page, 'nobody should hear this');
  await page.waitForTimeout(3_000);
  await openPlayground(page);
  await page.waitForTimeout(1_000);

  expect(await page.evaluate(() => '__SENTRY__' in window)).toBe(false);
  const bodies = await Promise.all(scripts);
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.filter((b) => b.includes('__SENTRY__'))).toEqual([]);
  const app = new URL(page.url()).host;
  // The app, the local Supabase stack, the sandbox shell and the mock package CDN.
  const allowed = new Set([app, '127.0.0.1:54321', '127.0.0.1:4321', 'localhost:4322']);
  expect([...hosts].filter((h) => !allowed.has(h))).toEqual([]);
  expect(ingest.requests).toEqual([]);
  await ingest.close();
});
