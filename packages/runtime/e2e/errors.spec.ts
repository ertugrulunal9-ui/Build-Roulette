import { expect, test } from '@playwright/test';
import { REACT_MANIFEST, reactApp } from './fixtures';
import { buildFrame, openPlayground } from './helpers';

test('f. runtime errors, unhandled rejections and console calls are forwarded', async ({
  page,
}) => {
  await openPlayground(page);
  const files = reactApp(
    `<button data-testid="throw" onClick={() => { throw new Error('boom from a click handler'); }}>throw</button>`,
    `console.log('hello from the build', { answer: 42 }, [1, 2]);
console.warn('careful');
setTimeout(() => { throw new Error('boom from a timer'); }, 0);
Promise.reject(new TypeError('async boom'));`,
  );
  const r = await page.evaluate(
    async ({ files, manifest }) => {
      await window.__playground.setProject(files, manifest);
      return window.__playground.buildAndLoad();
    },
    { files, manifest: REACT_MANIFEST },
  );
  expect(r.ok).toBe(true);
  await buildFrame(page).getByTestId('throw').click();

  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__playground.events.filter((e) => e.type === 'error').map((e) => e.data),
      ),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'runtime-error',
          kind: 'error',
          message: 'Error: boom from a timer',
          stack: expect.stringContaining('boom from a timer'),
        }),
        expect.objectContaining({
          type: 'runtime-error',
          kind: 'unhandledrejection',
          message: 'TypeError: async boom',
        }),
        expect.objectContaining({
          type: 'runtime-error',
          kind: 'error',
          message: 'Error: boom from a click handler',
        }),
      ]),
    );
  const consoleEvents = await page.evaluate(() =>
    window.__playground.events.filter((e) => e.type === 'console').map((e) => e.data),
  );
  expect(consoleEvents).toEqual(
    expect.arrayContaining([
      { level: 'log', args: ['hello from the build', '{answer: 42}', '[1, 2]'] },
      { level: 'warn', args: ['careful'] },
    ]),
  );
  // Errors are display-only: the preview is still alive.
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');
});

test('f. a package that fails to load from the CDN is reported as a module-load error', async ({
  page,
}) => {
  await openPlayground(page);
  const files = reactApp(
    `<p>uses zustand</p>`,
    `import { create } from 'zustand';\nconsole.log(typeof create);`,
  );
  const r = await page.evaluate(
    async ({ files }) => {
      // 4.0.0 is not installed in the mock CDN -> HTTP 404 for the module.
      await window.__playground.setProject(files, {
        entry: 'src/main.tsx',
        dependencies: { react: '19.3.0', 'react-dom': '19.3.0', zustand: '4.0.0' },
      });
      return window.__playground.buildAndLoad();
    },
    { files },
  );
  expect(r.ok).toBe(true); // the bundle builds; the failure is at load time
  const errors = await page.evaluate(() =>
    window.__playground.events.filter((e) => e.type === 'error').map((e) => e.data),
  );
  expect(errors).toEqual([expect.objectContaining({ kind: 'module-load' })]);
});

test('g. importing an undeclared package or a Node built-in gives diagnostics, not a crash', async ({
  page,
}) => {
  await openPlayground(page);
  const frame = buildFrame(page);
  await expect(frame.getByTestId('title')).toHaveText('Hello Build Roulette');
  const loadIdBefore = await page.evaluate(() => window.__playground.lastLoadId());

  const r = await page.evaluate(async () => {
    window.__playground.writeFile(
      'src/App.tsx',
      `import _ from 'lodash';\nimport { readFileSync } from 'node:fs';\nexport function App() { return <p>{String(_)}{String(readFileSync)}</p>; }\n`,
    );
    return window.__playground.buildAndLoad();
  });
  expect(r.ok).toBe(false);
  expect(r.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        severity: 'error',
        file: 'src/App.tsx',
        line: 1,
        text: expect.stringContaining('Package "lodash" is not in dependencies'),
      }),
      expect.objectContaining({
        severity: 'error',
        file: 'src/App.tsx',
        line: 2,
        text: expect.stringContaining('Node.js built-in'),
      }),
    ]),
  );
  await expect(page.locator('#diagnostics')).toContainText('lodash');
  // No load was sent, the last good build keeps running, nothing crashed.
  expect(await page.evaluate(() => window.__playground.lastLoadId())).toBe(loadIdBefore);
  await expect(frame.getByTestId('title')).toHaveText('Hello Build Roulette');
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');
  expect(
    await page.evaluate(() => window.__playground.events.some((e) => e.type === 'crash')),
  ).toBe(false);
});
