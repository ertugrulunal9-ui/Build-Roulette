import { expect, test } from '@playwright/test';
import { CDN_ORIGIN, buildFrame, openPlayground, replaceEditorText, setCdnOutage } from './helpers';

/**
 * T-032: the package CDN goes down after the template's first preview (docs/03 "Package
 * cache and CDN outages"). /playground with the react-ts template; scripts/sandbox-servers.ts
 * takes the outage on request.
 */

test.afterEach(async ({ page }) => {
  await setCdnOutage(page, 'off');
});

test('the template keeps working through a CDN outage: edits, a restart after a crash, a reload', async ({
  page,
}) => {
  // The shell warms the template's whole import map once a build ran.
  const warmed = page.waitForEvent('requestfinished', {
    predicate: (r) => r.url().startsWith(`${CDN_ORIGIN}/react@19.3.0/jsx-dev-runtime`),
    timeout: 30_000,
  });
  const { pageErrors } = await openPlayground(page);
  const frame = buildFrame(page);
  await expect(frame.locator('h1')).toHaveText('Hello, Build Roulette!');
  await warmed;

  await setCdnOutage(page, 'refuse');
  // A request that went to the network now fails (connection refused); cache hits do not.
  const failed: string[] = [];
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(CDN_ORIGIN)) failed.push(r.url());
  });

  // Edit the template app: React keeps rendering and updating.
  await replaceEditorText(
    page,
    `import { useState } from 'react';

export function App() {
  const [n, setN] = useState(0);
  return (
    <main>
      <h1 className="outage">Built during the outage</h1>
      <button type="button" onClick={() => setN(n + 1)}>Clicked {n}</button>
    </main>
  );
}
`,
  );
  await expect(frame.locator('h1.outage')).toHaveText('Built during the outage');
  await frame.getByRole('button').click();
  await expect(frame.getByRole('button')).toHaveText('Clicked 1');
  await expect(page.getByTestId('error-overlay')).toHaveCount(0);

  // A crash, a fix and "Restart preview": a new preview iframe and shell, still offline.
  await replaceEditorText(page, 'export function App() {\n  while (true) {}\n  return null;\n}\n');
  const crashed = page.getByTestId('preview-crashed');
  await expect(crashed).toBeVisible({ timeout: 20_000 });
  await replaceEditorText(
    page,
    'export function App() {\n  return <h1 className="restarted">Restarted offline</h1>;\n}\n',
  );
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in/);
  await crashed.getByRole('button', { name: 'Restart preview' }).click();
  await expect(frame.locator('h1.restarted')).toHaveText('Restarted offline');

  // A reload: a new app document, bundler worker and preview, the files from IndexedDB.
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  await page.reload();
  await expect(page.getByTestId('build-status')).toHaveText(/^Built in/, { timeout: 20_000 });
  await expect(buildFrame(page).locator('h1.restarted')).toHaveText('Restarted offline');
  await expect(page.getByTestId('error-overlay')).toHaveCount(0);

  // Nothing needed the (dead) CDN.
  expect(failed).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('an import that is not cached shows "Package server unreachable" fast, and nothing crashes', async ({
  page,
}) => {
  await openPlayground(page);
  await expect(buildFrame(page).locator('h1')).toHaveText('Hello, Build Roulette!');
  await setCdnOutage(page, 'refuse');

  // react-dom/server is a package module this browser never loaded (only React's own entry
  // points are in the import map).
  const started = Date.now();
  await replaceEditorText(
    page,
    `import { renderToStaticMarkup } from 'react-dom/server';

export function App() {
  return <h1>{renderToStaticMarkup(<b>hi</b>)}</h1>;
}
`,
  );
  await expect(page.getByTestId('error-overlay')).toContainText('The build failed to load');
  await expect(page.getByTestId('error-message')).toContainText(
    'Package server unreachable: react-dom@19.3.0/server',
  );
  const ms = Date.now() - started;
  console.log(`[metrics] edit → "Package server unreachable" ${String(ms)} ms`);
  expect(ms).toBeLessThan(5000);

  // Waiting longer than the watchdog's limit: no crash, and the next edit runs.
  await page.waitForTimeout(6000);
  await expect(page.getByTestId('preview-crashed')).toHaveCount(0);
  await replaceEditorText(page, 'export function App() {\n  return <h1>Back to React</h1>;\n}\n');
  await expect(buildFrame(page).locator('h1')).toHaveText('Back to React');
  await expect(page.getByTestId('error-overlay')).toHaveCount(0);
});
