import { expect, test, type Page } from '@playwright/test';
import type { FileMap, Manifest } from '../src/types';
import { buildFrame, openPlayground } from './helpers';

/**
 * T-032: the package CDN goes down after the template's first preview (docs/03 "Package
 * cache and CDN outages"). The dev server's mock CDN takes the outage on request:
 * `refuse` (connection refused), `error` (502 without CORS headers, like an edge error
 * page) or `hang` (no answer until the outage ends).
 */

const CDN_ORIGIN = `http://localhost:${process.env['CDN_PORT'] ?? '4312'}/`;

const TEMPLATE: Manifest = {
  entry: 'src/main.tsx',
  dependencies: { react: '19.3.0', 'react-dom': '19.3.0' },
};

function app(title: string, extra = { imports: '', body: '' }): FileMap {
  return {
    'src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
`,
    'src/App.tsx': `import { useState } from 'react';
${extra.imports}
export function App() {
  const [n, setN] = useState(0);
  ${extra.body}
  return (
    <main>
      <h1 data-testid="title">${title}</h1>
      <button data-testid="inc" onClick={() => setN(n + 1)}>count {n}</button>
    </main>
  );
}
`,
  };
}

/** zustand at an `external=` list the playground's boot never used: a URL that is not cached. */
const UNCACHED: { files: FileMap; manifest: Manifest } = {
  files: app('with zustand', {
    imports: `import { create } from 'zustand';\nconst useStore = create(() => ({ v: 1 }));`,
    body: 'const v = useStore((s) => s.v);',
  }),
  manifest: { ...TEMPLATE, dependencies: { ...TEMPLATE.dependencies, zustand: '5.0.15' } },
};

async function setOutage(page: Page, mode: 'refuse' | 'error' | 'hang' | 'off'): Promise<void> {
  const res = await page.request.post(`/__test/cdn-outage?mode=${mode}`);
  expect(res.status()).toBe(200);
}

/** Loads a project and waits for its `ready`. Returns the error/crash events it caused. */
async function load(page: Page, files: FileMap, manifest = TEMPLATE) {
  return page.evaluate(
    async ({ files, manifest }) => {
      const pg = window.__playground;
      const from = pg.events.length;
      await pg.setProject(files, manifest);
      const r = await pg.buildAndLoad();
      return {
        ok: r.ok,
        problems: pg.events
          .slice(from)
          .filter((e) => e.type === 'error' || e.type === 'crash')
          .map((e) => e.data),
      };
    },
    { files, manifest },
  );
}

async function expectTitle(page: Page, title: string): Promise<void> {
  await expect(buildFrame(page).getByTestId('title')).toHaveText(title);
  // React really runs: state updates re-render.
  await buildFrame(page).getByTestId('inc').click();
  await expect(buildFrame(page).getByTestId('inc')).toHaveText('count 1');
}

test.afterEach(async ({ page }) => {
  await setOutage(page, 'off');
});

test('template packages keep working through a CDN outage: edit, restart, reveal mode, reset, reload', async ({
  page,
}) => {
  // The shell warms the whole import map after a build ran, including the entry point the
  // template does not import (react/jsx-dev-runtime).
  const warmed = page.waitForEvent('requestfinished', {
    predicate: (r) => r.url().includes('/react@19.3.0/jsx-dev-runtime'),
    timeout: 20_000,
  });
  await openPlayground(page);
  expect(await load(page, app('before the outage'))).toEqual({ ok: true, problems: [] });
  await expectTitle(page, 'before the outage');
  await warmed;

  await setOutage(page, 'refuse');
  // A request that went to the network now fails (connection refused); cache hits do not.
  const failed: string[] = [];
  page.on('requestfailed', (r) => {
    if (r.url().startsWith(CDN_ORIGIN)) failed.push(r.url());
  });

  // An edit: a new build document in the same shell.
  expect(await load(page, app('edited during the outage'))).toEqual({ ok: true, problems: [] });
  await expectTitle(page, 'edited during the outage');
  // The warmed entry point the template never imported.
  expect(
    await load(
      page,
      app('jsx-dev-runtime', {
        imports: `import { jsxDEV } from 'react/jsx-dev-runtime';`,
        body: 'void jsxDEV;',
      }),
    ),
  ).toEqual({ ok: true, problems: [] });
  await expectTitle(page, 'jsx-dev-runtime');

  // A preview restart: a new preview iframe and shell realm.
  await page.evaluate(() => window.__playground.restartPreview());
  expect(await load(page, app('after a restart'))).toEqual({ ok: true, problems: [] });
  await expectTitle(page, 'after a restart');

  // Reveal mode (new iframe with the reveal flags), as another player's build would run.
  await page.evaluate(() => {
    window.__playground.setMode('reveal');
  });
  expect(await load(page, app('in reveal mode'))).toEqual({ ok: true, problems: [] });
  await expectTitle(page, 'in reveal mode');
  await page.evaluate(() => {
    window.__playground.setMode('live');
  });

  // The storage wipe (Clear-Site-Data "cache" for the shell origin) keeps the CDN's entries.
  const reset = await page.evaluate(() => window.__playground.resetStorage());
  expect(reset.ok).toBe(true);
  expect(await load(page, app('after a storage reset'))).toEqual({ ok: true, problems: [] });
  await expectTitle(page, 'after a storage reset');

  // A page reload: a new app document, bundler worker and preview. The playground's sample
  // (zustand and animate.css as well) builds and runs from the HTTP cache.
  await page.reload();
  await page.evaluate(() => window.__playground.boot);
  await expect(buildFrame(page).getByTestId('title')).toHaveText('Hello Build Roulette');
  expect(await load(page, app('after a reload'))).toEqual({ ok: true, problems: [] });
  await expectTitle(page, 'after a reload');

  // Everything came from the browser's cache: no request to the (dead) CDN failed.
  expect(failed).toEqual([]);
});

for (const mode of ['refuse', 'error'] as const) {
  test(`an uncached package fails fast with its name, and the watchdog stays quiet (${mode})`, async ({
    page,
  }) => {
    await openPlayground(page);
    expect(await load(page, app('before the outage'))).toEqual({ ok: true, problems: [] });
    await setOutage(page, mode);

    const r = await page.evaluate(async ({ files, manifest }) => {
      const pg = window.__playground;
      await pg.setProject(files, manifest);
      const from = pg.events.length;
      const t0 = performance.now();
      const built = await pg.buildAndLoad();
      const error = pg.events.slice(from).find((e) => e.type === 'error');
      return {
        ok: built.ok,
        ms: error ? error.t - t0 : null,
        error: error?.data as { kind?: string; message?: string } | undefined,
      };
    }, UNCACHED);
    console.log(`[metrics] outage=${mode}: build → package error ${String(r.ms?.toFixed(0))} ms`);
    expect(r.ok).toBe(true); // the shell still reports `ready`: the load is over
    expect(r.error?.kind).toBe('module-load');
    expect(r.error?.message?.split('\n')[0]).toBe('Package server unreachable: zustand@5.0.15');
    expect(r.ms).not.toBeNull();
    expect(r.ms ?? Infinity).toBeLessThan(3000);

    // No watchdog crash, and the preview keeps working for packages it has.
    await page.waitForTimeout(6000);
    expect(await load(page, app('still fine'))).toEqual({ ok: true, problems: [] });
    await expectTitle(page, 'still fine');
    expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');
    expect(
      await page.evaluate(() => window.__playground.events.filter((e) => e.type === 'crash')),
    ).toEqual([]);
  });
}

test('a CDN that does not answer: a "still waiting" note, no crash, and the build starts once it answers', async ({
  page,
}) => {
  await openPlayground(page);
  expect(await load(page, app('before the outage'))).toEqual({ ok: true, problems: [] });
  await setOutage(page, 'hang');

  const started = await page.evaluate(async ({ files, manifest }) => {
    const pg = window.__playground;
    await pg.setProject(files, manifest);
    const from = pg.events.length;
    // Rebuild through an edit (debounced), without waiting for `ready`: it will not come.
    pg.writeFile('src/App.tsx', files['src/App.tsx'] ?? '');
    return { from, t0: performance.now() };
  }, UNCACHED);
  const findNote = () =>
    page.evaluate((from) => {
      const e = window.__playground.events.slice(from).find((x) => x.type === 'error');
      return e ? { t: e.t, data: e.data as { kind?: string; message?: string } } : null;
    }, started.from);
  await expect.poll(findNote, { timeout: 20_000 }).not.toBeNull();
  const note = await findNote();
  console.log(
    `[metrics] outage=hang: load → "still waiting" ${((note?.t ?? 0) - started.t0).toFixed(0)} ms`,
  );
  expect(note?.data.kind).toBe('module-load');
  expect(note?.data.message?.split('\n')[0]).toBe(
    'Still waiting for the package server after 8 s: zustand@5.0.15',
  );
  // Waiting for the network is not a freeze: the watchdog stays quiet.
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');

  // The CDN answers at last: the build starts.
  await setOutage(page, 'off');
  await expect(buildFrame(page).getByTestId('title')).toHaveText('with zustand');
  expect(
    await page.evaluate(() => window.__playground.events.filter((e) => e.type === 'crash')),
  ).toEqual([]);
});
