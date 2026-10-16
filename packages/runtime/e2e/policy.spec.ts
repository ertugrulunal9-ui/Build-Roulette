/**
 * Policy conformance: what an ordinary site running in the preview may and may not do,
 * checked against the site CSP (set by the site worker) and the iframe's per-mode
 * sandbox/allow attributes.
 */
import { expect, test, type Page } from '@playwright/test';
import type { RunMode } from '@br/protocol';
import { markupSite, moduleSite, type SiteSpec } from './fixtures';
import { SHELL_ORIGIN, buildFrame, loadSite, openPlayground } from './helpers';

async function runSite(page: Page, files: SiteSpec, mode: RunMode = 'live'): Promise<void> {
  await loadSite(page, files, mode);
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

/** A site whose module writes `JSON.stringify(<expr>)` into `#out` after `prelude`. */
function reportSite(prelude: string, expr: string): SiteSpec {
  return moduleSite(
    `${prelude}\nroot.innerHTML = '<pre data-testid="out"></pre>';\nroot.firstChild.textContent = JSON.stringify(${expr});`,
  );
}

async function outOf<T>(page: Page): Promise<T> {
  await expect(buildFrame(page).getByTestId('out')).not.toBeEmpty();
  return JSON.parse((await buildFrame(page).getByTestId('out').textContent()) ?? 'null') as T;
}

test('service worker registration from a site fails: blob: URLs, and the shell scripts are no workers', async ({
  page,
  request,
}) => {
  // The same-origin scripts exist, so a rejection is not a 404.
  expect((await request.get(`${SHELL_ORIGIN}/v2/shell.js`)).status()).toBe(200);
  await openPlayground(page);
  await runSite(
    page,
    reportSite(
      `const results = [];
const blobUrl = URL.createObjectURL(new Blob(['self.addEventListener("fetch", () => {});'], { type: 'text/javascript' }));
for (const [url, scope] of [[blobUrl, '/'], ['/v2/shell.js', '/v2/'], ['/v2/capture.js', '/v2/']]) {
  try {
    await Promise.race([
      navigator.serviceWorker.register(url, { scope }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('register() did not settle')), 3000)),
    ]);
    results.push('registered');
  } catch (e) {
    results.push(e.name + ': ' + e.message);
  }
}
const registrations = (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope.replace(location.origin, ''));`,
      '{ results, registrations }',
    ),
  );
  const { results, registrations } = await outOf<{ results: string[]; registrations: string[] }>(
    page,
  );
  console.log(`[policy] service worker register() in the site frame: ${JSON.stringify(results)}`);
  expect(results).toHaveLength(3);
  // blob: is not a registrable script scheme.
  expect(results[0]).toMatch(/^TypeError: .*URL protocol of the script .* is not supported/);
  // The shell's own scripts throw at the top level in a worker global: no registration.
  expect(results[1]).toMatch(/^TypeError: .*ServiceWorker script evaluation failed/);
  expect(results[2]).toMatch(/^TypeError: .*ServiceWorker script evaluation failed/);
  // Only the site worker is registered.
  expect(registrations).toEqual(['/']);
});

test('a <script src> from an origin outside script-src does not run in the site frame', async ({
  page,
  request,
}) => {
  await openPlayground(page);
  const appOrigin = new URL(page.url()).origin;
  // The probe exists and is valid JS; only the site CSP (http: is not in script-src) stops it.
  const probe = await request.get(`${appOrigin}/csp-probe.js`);
  expect(probe.status()).toBe(200);
  expect(await probe.text()).toContain('__cspProbeRan');

  await runSite(
    page,
    reportSite(
      `const outcome = await new Promise((resolve) => {
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
const ran = window.__cspProbeRan === true;`,
      '{ outcome, ran }',
    ),
  );
  const { outcome, ran } = await outOf<{ outcome: string; ran: boolean }>(page);
  expect(outcome).toBe(`blocked by script-src-elem (${appOrigin}/csp-probe.js)`);
  expect(ran).toBe(false);
});

test('a form submission does not navigate the site frame (form-action none)', async ({ page }) => {
  await openPlayground(page);
  await runSite(
    page,
    markupSite(
      '<form action="/elsewhere" method="get"><input name="q" value="x" /><button data-testid="submit">go</button></form><p data-testid="still">still here</p>',
    ),
  );
  await buildFrame(page).getByTestId('submit').click();
  await page.waitForTimeout(300);
  await expect(buildFrame(page).getByTestId('still')).toHaveText('still here');
});

// Clipboard first: an opened popup would take focus, and an unfocused document gets a
// different rejection ("Document is not focused") that hides the policy check.
const POPUP_AND_CLIPBOARD = `
let clipboard;
try {
  await navigator.clipboard.writeText('from the build');
  clipboard = 'written';
} catch (e) {
  clipboard = e.name + ': ' + e.message;
}
const popup = window.open('about:blank', '_blank');
const popupResult = popup === null ? 'null' : 'window';
popup?.close();
`;
const CAPS_SITE = reportSite(POPUP_AND_CLIPBOARD, '{ popupResult, clipboard }');

test('reveal mode: new iframe without popups, modals or clipboard-write; window.open returns null and clipboard writes reject', async ({
  page,
}) => {
  await openPlayground(page);
  const preview = page.locator('#preview');

  // live (default): popups allowed.
  await runSite(page, CAPS_SITE, 'live');
  expect(await preview.getAttribute('sandbox')).toBe(
    'allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock allow-popups',
  );
  expect(await preview.getAttribute('allow')).toBe(
    'autoplay; fullscreen; gamepad; clipboard-write',
  );
  const live = await outOf<{ popupResult: string; clipboard: string }>(page);
  console.log(`[policy] live mode: ${JSON.stringify(live)}`);
  expect(live.popupResult).toBe('window');
  // Live mode delegates clipboard-write; headless Chromium still refuses the write itself
  // (no user activation), but not because of the permissions policy.
  expect(live.clipboard).not.toMatch(/permissions policy/i);

  // Switch to reveal: the same site can no longer open popups or write the clipboard ...
  await markPreviewElement(page);
  await runSite(page, CAPS_SITE, 'reveal');
  const reveal = await outOf<{ popupResult: string; clipboard: string }>(page);
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
  // The shell's child frame (the site's document) does not re-grant clipboard-write.
  expect(await page.frameLocator('#preview').locator('iframe').getAttribute('allow')).toBe(
    'autoplay; fullscreen; gamepad',
  );

  // A load in the same mode keeps the iframe; going back to live replaces it again.
  await markPreviewElement(page);
  await runSite(page, CAPS_SITE, 'reveal');
  expect(await previewElementIsNew(page)).toBe(false);
  await runSite(page, CAPS_SITE, 'live');
  expect(await previewElementIsNew(page)).toBe(true);
  expect(await preview.getAttribute('sandbox')).toContain('allow-popups');
});

test('capture mode gets the reveal attributes too, and the site gets the keyboard', async ({
  page,
}) => {
  await openPlayground(page);
  await markPreviewElement(page);
  await runSite(
    page,
    markupSite(
      '<p data-testid="cap">captured</p>',
      "addEventListener('keydown', (e) => { document.title = 'key ' + e.key; });",
    ),
    'capture',
  );
  expect(await previewElementIsNew(page)).toBe(true);
  const preview = page.locator('#preview');
  expect(await preview.getAttribute('sandbox')).toBe(
    'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
  );
  expect(await preview.getAttribute('allow')).toBe('autoplay; fullscreen; gamepad');
  await expect(buildFrame(page).getByTestId('cap')).toHaveText('captured');
  // Someone else's site (reveal, capture) is focused on load: keys reach it without a click.
  await page.keyboard.press('KeyK');
  await expect
    .poll(() =>
      page
        .frames()
        .find((f) => f.parentFrame()?.parentFrame() === page.mainFrame())
        ?.evaluate(() => document.title),
    )
    .toBe('key k');
});
