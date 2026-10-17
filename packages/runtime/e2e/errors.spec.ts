import { expect, test } from '@playwright/test';
import { html, moduleSite } from './fixtures';
import { buildFrame, eventsOf, loadSite, openPlayground } from './helpers';

test('f. runtime errors, unhandled rejections and console calls are forwarded', async ({
  page,
}) => {
  await openPlayground(page);
  await loadSite(
    page,
    moduleSite(`console.log('hello from the build', { answer: 42 }, [1, 2]);
console.warn('careful');
setTimeout(() => { throw new Error('boom from a timer'); }, 0);
Promise.reject(new TypeError('async boom'));
root.innerHTML = '<button data-testid="throw">throw</button>';
root.querySelector('button').addEventListener('click', () => { throw new Error('boom from a click handler'); });`),
  );
  await buildFrame(page).getByTestId('throw').click();

  await expect
    .poll(() => eventsOf(page, 'error'))
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
  expect(await eventsOf(page, 'console')).toEqual(
    expect.arrayContaining([
      { level: 'log', args: ['hello from the build', '{answer: 42}', '[1, 2]'] },
      { level: 'warn', args: ['careful'] },
    ]),
  );
  // Errors are display-only: the preview is still alive.
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');
});

test('f. a console flood is rate-limited by the shell and the drop is reported', async ({
  page,
}) => {
  await openPlayground(page);
  await loadSite(
    page,
    moduleSite(`for (let i = 0; i < 500; i++) console.log('flood ' + i);
setTimeout(() => console.log('after the flood'), 1100);`),
  );
  await expect
    .poll(async () =>
      ((await eventsOf(page, 'console')) as { args: string[] }[]).some(
        (c) => c.args[0] === 'after the flood',
      ),
    )
    .toBe(true);
  const lines = ((await eventsOf(page, 'console')) as { level: string; args: string[] }[]).map(
    (c) => `${c.level}: ${c.args.join(' ')}`,
  );
  const flood = lines.filter((l) => l.startsWith('log: flood '));
  // The shell forwards at most LIMITS.consoleMaxPerSecond (100) per second...
  expect(flood.length).toBe(100);
  // ...and says how many it dropped, with the next message after the second.
  expect(lines).toContain('warn: [sandbox] 400 console messages dropped (rate limit)');
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');
});

test('f. a script or stylesheet the site lacks is a module-load error; ready still comes', async ({
  page,
}) => {
  await openPlayground(page);
  await loadSite(page, {
    'index.html': html({
      head: `<script type="module" src="/assets/index-missing.js"></script>
    <link rel="stylesheet" href="/assets/index-missing.css" />`,
      body: '<p data-testid="static">static content still shows</p>',
    }),
  });
  await expect(buildFrame(page).getByTestId('static')).toHaveText('static content still shows');
  await expect
    .poll(() => eventsOf(page, 'error'))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'module-load',
          message: 'Failed to load /assets/index-missing.js',
        }),
        expect.objectContaining({
          kind: 'module-load',
          message: 'Failed to load /assets/index-missing.css',
        }),
      ]),
    );
});

test('f. a pack that is not a site pack is reported as a module-load error with a ready', async ({
  page,
}) => {
  await openPlayground(page);
  const loadId = await page.evaluate(() =>
    window.__playground.sendPack(Array.from(new TextEncoder().encode('PK\u0003\u0004 a zip'))),
  );
  await page.evaluate((id) => window.__playground.waitForReady(id), loadId);
  expect(await eventsOf(page, 'error')).toEqual([
    expect.objectContaining({
      kind: 'module-load',
      message: 'The imported site could not be read: not a site pack. Import it again.',
    }),
  ]);
  // No frame for it; the preview is fine and takes the next load.
  await loadSite(page, moduleSite(`root.innerHTML = '<p data-testid="ok">next load</p>';`));
  await expect(buildFrame(page).getByTestId('ok')).toHaveText('next load');
});
