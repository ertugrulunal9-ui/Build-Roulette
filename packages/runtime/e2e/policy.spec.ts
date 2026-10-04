/**
 * Policy conformance: what an ordinary app running in the preview may and may not do,
 * checked against the shell's CSP and the iframe's per-mode sandbox/allow attributes.
 */
import { expect, test, type Page } from '@playwright/test';
import type { RunMode } from '@br/protocol';
import type { FileMap } from '../src/types';
import { REACT_MANIFEST, reactApp } from './fixtures';
import { buildFrame, openPlayground } from './helpers';

const SHELL_ORIGIN = `http://127.0.0.1:${process.env['SHELL_PORT'] ?? '4311'}`;

async function runApp(page: Page, files: FileMap, mode: RunMode = 'live'): Promise<void> {
  const r = await page.evaluate(
    async ({ files, manifest, mode }) => {
      window.__playground.setMode(mode);
      await window.__playground.setProject(files, manifest);
      return window.__playground.buildAndLoad();
    },
    { files, manifest: REACT_MANIFEST, mode },
  );
  expect(r.ok).toBe(true);
}

/** Marks the current preview iframe element so a later check can tell whether it was replaced. */
async function markPreviewElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    (document.getElementById('preview') as HTMLIFrameElement & { __old?: boolean }).__old = true;
  });
}

async function previewElementIsNew(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      (document.getElementById('preview') as HTMLIFrameElement & { __old?: boolean }).__old !==
      true,
  );
}

test('service worker registration is rejected (blob: URL and same-origin script)', async ({
  page,
  request,
}) => {
  // The same-origin script exists, so a rejection is the policy, not a 404.
  expect((await request.get(`${SHELL_ORIGIN}/v1/sw-test.js`)).status()).toBe(200);
  await openPlayground(page);
  const prelude = `
const results: string[] = [];
const sw = navigator.serviceWorker as ServiceWorkerContainer | undefined;
const blobUrl = URL.createObjectURL(new Blob(['self.addEventListener("fetch", () => {});'], { type: 'text/javascript' }));
for (const url of [blobUrl, location.origin + '/v1/sw-test.js']) {
  try {
    if (!sw) throw new Error('navigator.serviceWorker is not available');
    await Promise.race([
      sw.register(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('register() did not settle')), 3000)),
    ]);
    results.push('registered');
  } catch (e) {
    results.push(e instanceof Error ? e.name + ': ' + e.message : String(e));
  }
}
`;
  await runApp(page, reactApp(`<pre data-testid="sw">{JSON.stringify(results)}</pre>`, prelude));
  const results = JSON.parse(
    (await buildFrame(page).getByTestId('sw').textContent()) ?? '[]',
  ) as string[];
  console.log(`[policy] service worker register() in the app frame: ${JSON.stringify(results)}`);
  expect(results).toHaveLength(2);
  for (const r of results) expect(r).not.toBe('registered');
  // blob: is not a registrable script scheme.
  expect(results[0]).toMatch(/^TypeError: .*URL protocol of the script .* is not supported/);
  // The build's document is the shell's about:blank child, from which Chromium does not
  // register service workers at all (InvalidStateError). The next test covers the CSP.
  expect(results[1]).toMatch(/^(InvalidStateError|SecurityError): /);
});

test('the shell document itself cannot register a same-origin service worker (worker-src blob:)', async ({
  page,
}) => {
  // Top-level load of the shell (no app around it): a plain check of the shell's own CSP.
  await page.goto(`${SHELL_ORIGIN}/v1/`);
  const result = await page.evaluate(async () => {
    try {
      await navigator.serviceWorker.register('/v1/sw-test.js');
      return 'registered';
    } catch (e) {
      return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
  });
  console.log(`[policy] service worker register() in the shell document: ${result}`);
  expect(result).toMatch(/^SecurityError: .*Content Security Policy/i);
  const registrations = await page.evaluate(
    async () => (await navigator.serviceWorker.getRegistrations()).length,
  );
  expect(registrations).toBe(0);
});

test('a <script src> from an origin outside script-src does not run in the app frame', async ({
  page,
  request,
}) => {
  await openPlayground(page);
  const appOrigin = new URL(page.url()).origin;
  // The probe exists and is valid JS; only the CSP inherited by the build's frame stops it.
  const probe = await request.get(`${appOrigin}/csp-probe.js`);
  expect(probe.status()).toBe(200);
  expect(await probe.text()).toContain('__cspProbeRan');

  const prelude = `
const outcome = await new Promise<string>((resolve) => {
  document.addEventListener(
    'securitypolicyviolation',
    (e) => resolve('blocked by ' + e.effectiveDirective + ' (' + e.blockedURI + ')'),
    { once: true },
  );
  const s = document.createElement('script');
  s.src = ${JSON.stringify(`${appOrigin}/csp-probe.js`)};
  s.onload = () => resolve('loaded');
  document.head.appendChild(s);
  setTimeout(() => resolve('timeout'), 3000);
});
const ran = (window as unknown as { __cspProbeRan?: boolean }).__cspProbeRan === true;
`;
  await runApp(
    page,
    reactApp(`<pre data-testid="probe">{JSON.stringify({ outcome, ran })}</pre>`, prelude),
  );
  const text = await buildFrame(page).getByTestId('probe').textContent();
  const { outcome, ran } = JSON.parse(text ?? '{}') as { outcome: string; ran: boolean };
  expect(outcome).toBe(`blocked by script-src-elem (${appOrigin}/csp-probe.js)`);
  expect(ran).toBe(false);
});

// Clipboard first: an opened popup would take focus, and an unfocused document gets a
// different rejection ("Document is not focused") that hides the policy check.
const POPUP_AND_CLIPBOARD = `
let clipboard: string;
try {
  await navigator.clipboard.writeText('from the build');
  clipboard = 'written';
} catch (e) {
  clipboard = e instanceof Error ? e.name + ': ' + e.message : String(e);
}
const popup = window.open('about:blank', '_blank');
const popupResult = popup === null ? 'null' : 'window';
popup?.close();
`;
const POPUP_BODY = `<pre data-testid="caps">{JSON.stringify({ popupResult, clipboard })}</pre>`;

test('reveal mode: new iframe without popups, modals or clipboard-write; window.open returns null and clipboard writes reject', async ({
  page,
}) => {
  await openPlayground(page);
  const preview = page.locator('#preview');

  // live (default): popups allowed.
  await runApp(page, reactApp(POPUP_BODY, POPUP_AND_CLIPBOARD), 'live');
  expect(await preview.getAttribute('sandbox')).toBe(
    'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups',
  );
  expect(await preview.getAttribute('allow')).toBe(
    'autoplay; fullscreen; gamepad; clipboard-write',
  );
  const live = JSON.parse((await buildFrame(page).getByTestId('caps').textContent()) ?? '{}') as {
    popupResult: string;
    clipboard: string;
  };
  console.log(`[policy] live mode: ${JSON.stringify(live)}`);
  expect(live.popupResult).toBe('window');
  // Live mode delegates clipboard-write; headless Chromium still refuses the write itself
  // (no user activation), but not because of the permissions policy.
  expect(live.clipboard).not.toMatch(/permissions policy/i);

  // Switch to reveal: the same app can no longer open popups or write the clipboard ...
  await markPreviewElement(page);
  await runApp(page, reactApp(POPUP_BODY, POPUP_AND_CLIPBOARD), 'reveal');
  const reveal = JSON.parse((await buildFrame(page).getByTestId('caps').textContent()) ?? '{}') as {
    popupResult: string;
    clipboard: string;
  };
  console.log(`[policy] reveal mode: ${JSON.stringify(reveal)}`);
  expect(reveal.popupResult).toBe('null');
  expect(reveal.clipboard).toMatch(/^NotAllowedError: .*permissions policy/i);
  // ... because the iframe element was replaced by one with the reveal attributes.
  expect(await previewElementIsNew(page)).toBe(true);
  expect(await page.evaluate(() => window.__playground.previewMode())).toBe('reveal');
  expect(await preview.getAttribute('sandbox')).toBe(
    'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
  );
  expect(await preview.getAttribute('allow')).toBe('autoplay; fullscreen; gamepad');
  // The shell's child frame (the build's document) does not re-grant clipboard-write.
  expect(await page.frameLocator('#preview').locator('iframe').getAttribute('allow')).toBe(
    'autoplay; fullscreen; gamepad',
  );

  // A rebuild in the same mode keeps the iframe; going back to live replaces it again.
  await markPreviewElement(page);
  await runApp(page, reactApp(POPUP_BODY, POPUP_AND_CLIPBOARD), 'reveal');
  expect(await previewElementIsNew(page)).toBe(false);
  await runApp(page, reactApp(POPUP_BODY, POPUP_AND_CLIPBOARD), 'live');
  expect(await previewElementIsNew(page)).toBe(true);
  expect(await preview.getAttribute('sandbox')).toContain('allow-popups');
});

test('capture mode gets the reveal attributes too', async ({ page }) => {
  await openPlayground(page);
  await markPreviewElement(page);
  await runApp(page, reactApp(`<p data-testid="cap">captured</p>`), 'capture');
  expect(await previewElementIsNew(page)).toBe(true);
  const preview = page.locator('#preview');
  expect(await preview.getAttribute('sandbox')).toBe(
    'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
  );
  expect(await preview.getAttribute('allow')).toBe('autoplay; fullscreen; gamepad');
  await expect(buildFrame(page).getByTestId('cap')).toHaveText('captured');
});
