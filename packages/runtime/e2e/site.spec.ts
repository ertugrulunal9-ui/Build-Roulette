/**
 * Imported sites served by the site worker (docs/09 §9.3): what a built static site needs
 * from a static host, in-site navigation, isolation between loads, and a worker restart.
 */
import { expect, test, type Page } from '@playwright/test';
import { html, moduleSite, viteLikeSite, type SiteSpec } from './fixtures';
import {
  buildFrame,
  consoleLines,
  eventsOf,
  loadSite,
  openPlayground,
  shellFrame,
  siteFrame,
} from './helpers';

async function outOf(page: Page): Promise<Record<string, string>> {
  const text = await buildFrame(page).getByTestId('out').textContent();
  return JSON.parse(text ?? '{}') as Record<string, string>;
}

test('a. a Vite-like build: entry module, stylesheet, lazy chunk, image, fetch and a module worker', async ({
  page,
}) => {
  await openPlayground(page);
  await loadSite(page, viteLikeSite('Vite-like'));
  const frame = buildFrame(page);
  await expect(frame.getByTestId('title')).toHaveCSS('color', 'rgb(255, 0, 128)');
  await expect
    .poll(() => outOf(page))
    .toEqual({
      lazy: 'chunk ok',
      data: 'Vite-like data',
      worker: 'worker Vite-like data',
      image: '40x20',
    });
  // The bootstrap forwarded the module's console call.
  await expect.poll(() => consoleLines(page)).toContain('log: vite-like site started /');
  expect(await eventsOf(page, 'error')).toEqual([]);
});

/** A client-side router: renders by `location.pathname`, says where it started. */
const ROUTER_SITE: SiteSpec = {
  'index.html': html({ head: '<script type="module" src="/assets/router-1a2b.js"></script>' }),
  'assets/router-1a2b.js': `const root = document.getElementById('root');
const routes = { '/': 'Home', '/about': 'About' };
root.innerHTML = '<p data-testid="started"></p><h1 data-testid="route"></h1>';
root.querySelector('[data-testid="started"]').textContent = JSON.stringify({
  path: location.pathname, search: location.search, hash: location.hash,
});
const render = () => {
  root.querySelector('[data-testid="route"]').textContent = routes[location.pathname] ?? 'Not found (router)';
};
render();
window.addEventListener('popstate', render);
console.log('router start ' + location.pathname);
`,
};

test('b. a router SPA starts at / without the site id; a reload of a pushed route gets index.html again', async ({
  page,
}) => {
  await openPlayground(page);
  const { loadId } = await loadSite(page, ROUTER_SITE);
  const frame = buildFrame(page);
  await expect(frame.getByTestId('started')).toHaveText('{"path":"/","search":"","hash":""}');
  await expect(frame.getByTestId('route')).toHaveText('Home');

  // The router navigates in history, then the page reloads (F5 inside the frame).
  await siteFrame(page).evaluate(() => {
    history.pushState({}, '', '/about?tab=2#team');
    location.reload();
  });
  await expect(frame.getByTestId('started')).toHaveText(
    '{"path":"/about","search":"?tab=2","hash":"#team"}',
  );
  await expect(frame.getByTestId('route')).toHaveText('About');
  // The reloaded document is instrumented too, and the load reported `ready` only once.
  await expect.poll(() => consoleLines(page)).toContain('log: router start /about');
  const readies = (await eventsOf(page, 'ready')) as { loadId: number }[];
  expect(readies.filter((r) => r.loadId === loadId)).toHaveLength(1);

  // The site's first URL, as the shell navigated its frame: `/?__br_site=<id>`.
  const first = await shellFrame(page).evaluate(() => document.querySelector('iframe')?.src ?? '');
  expect(first).toMatch(/\/\?__br_site=[0-9a-f]{32}$/);
  const id = new URL(first).searchParams.get('__br_site') ?? '';
  // Other query parameters and the hash survive the bootstrap; only the site id goes.
  await siteFrame(page).evaluate((id) => {
    location.href = `/?keep=1&__br_site=${id}&x=y#h`;
  }, id);
  await expect(frame.getByTestId('started')).toHaveText(
    '{"path":"/","search":"?keep=1&x=y","hash":"#h"}',
  );
  // A site id the worker does not hold is not another site: a 404 from the worker.
  await siteFrame(page).evaluate(() => {
    location.href = `/?__br_site=${'0'.repeat(32)}`;
  });
  await expect(frame.locator('body')).toContainText('not loaded in the sandbox any more');
});

const MULTI_PAGE_SITE: SiteSpec = {
  'index.html': html({
    body: '<h1 data-testid="page">Home page</h1><a id="about" href="/about.html">About</a> <a id="docs" href="/docs">Docs</a>',
  }),
  'about.html': html({
    head: `<script>console.log('about page ' + location.pathname);</script>`,
    body: '<h1 data-testid="page">About page</h1>',
  }),
  'docs/index.html': html({
    head: '<link rel="stylesheet" href="./docs.css" />',
    body: '<h1 data-testid="page" class="docs">Docs index</h1>',
  }),
  'docs/docs.css': '.docs { color: rgb(0, 128, 255); }\n',
};

test('c. a multi-page site: in-site links are served and instrumented; a folder gets its trailing slash', async ({
  page,
}) => {
  await openPlayground(page);
  await loadSite(page, MULTI_PAGE_SITE);
  const frame = buildFrame(page);
  await expect(frame.getByTestId('page')).toHaveText('Home page');
  await frame.locator('#about').click();
  await expect(frame.getByTestId('page')).toHaveText('About page');
  await expect.poll(() => consoleLines(page)).toContain('log: about page /about.html');

  await siteFrame(page).evaluate(() => {
    location.href = '/';
  });
  await expect(frame.getByTestId('page')).toHaveText('Home page');
  await frame.locator('#docs').click();
  // `/docs` -> 301 `/docs/` -> docs/index.html, whose relative stylesheet resolves in docs/.
  await expect(frame.getByTestId('page')).toHaveText('Docs index');
  await expect(frame.getByTestId('page')).toHaveCSS('color', 'rgb(0, 128, 255)');
  expect(await siteFrame(page).evaluate(() => location.pathname)).toBe('/docs/');
});

/** Fetches each path and reports its status, into `#out`. */
function probeSite(label: string, paths: readonly string[], extra: SiteSpec = {}): SiteSpec {
  return moduleSite(
    `root.innerHTML = '<h1 data-testid="title">${label}</h1><pre data-testid="out"></pre>';
const out = {};
for (const p of ${JSON.stringify(paths)}) out[p] = (await fetch(p)).status;
root.querySelector('[data-testid="out"]').textContent = JSON.stringify(out);`,
    extra,
  );
}

test('d. isolation: a later site never sees an earlier one; reset re-registers the worker; no worker of its own', async ({
  page,
}) => {
  await openPlayground(page);
  const frame = buildFrame(page);
  await loadSite(page, probeSite('Site A', ['/a-only.txt'], { 'a-only.txt': 'secret of A\n' }));
  await expect(frame.getByTestId('title')).toHaveText('Site A');
  await expect.poll(() => outOf(page)).toEqual({ '/a-only.txt': 200 });

  await loadSite(page, probeSite('Site B', ['/a-only.txt', '/b-only.txt'], { 'b-only.txt': 'B' }));
  await expect(frame.getByTestId('title')).toHaveText('Site B');
  await expect.poll(() => outOf(page)).toEqual({ '/a-only.txt': 404, '/b-only.txt': 200 });

  // reset-storage unregisters the site worker and empties Cache Storage; the next load works.
  const reset = await page.evaluate(() => window.__playground.resetStorage());
  expect(reset).toMatchObject({ type: 'storage-reset', ok: true });
  await loadSite(page, probeSite('Site B again', ['/b-only.txt'], { 'b-only.txt': 'B' }));
  await expect(frame.getByTestId('title')).toHaveText('Site B again');
  await expect.poll(() => outOf(page)).toEqual({ '/b-only.txt': 200 });

  // A site cannot register a service worker script of its own: worker scripts come from the
  // network, which only has the shell's files. Nor can it hand the site worker a site.
  await loadSite(
    page,
    moduleSite(
      `root.innerHTML = '<pre data-testid="out"></pre>';
const out = {};
try {
  await navigator.serviceWorker.register('/assets/evil-sw.js', { scope: '/' });
  out.register = 'registered';
} catch (e) {
  out.register = e.name + ': ' + e.message;
}
out.registrations = (await navigator.serviceWorker.getRegistrations()).map((r) => (r.active ?? r.installing ?? r.waiting)?.scriptURL.replace(location.origin, ''));
out.upload = await new Promise((resolve) => {
  const ch = new MessageChannel();
  ch.port1.onmessage = (e) => resolve(e.data.ok ? 'accepted' : 'refused: ' + e.data.error);
  const bytes = new TextEncoder().encode('<h1>evil</h1>').buffer;
  navigator.serviceWorker.controller.postMessage(
    { type: 'br-site', id: 'f'.repeat(32), files: [{ path: 'index.html', type: 'text/html; charset=utf-8', bytes }] },
    [ch.port2, bytes],
  );
});
root.querySelector('[data-testid="out"]').textContent = JSON.stringify(out);`,
      {
        'assets/evil-sw.js': `self.addEventListener('fetch', (e) => e.respondWith(new Response('evil')));\n`,
      },
    ),
  );
  await expect.poll(async () => Object.keys(await outOf(page)).length).toBe(3);
  const out = await outOf(page);
  console.log(`[policy] site registering its own service worker: ${out['register'] ?? ''}`);
  expect(out['register']).toMatch(/^TypeError: .*bad HTTP response code \(404\)/);
  expect(out['registrations']).toEqual(['/v2/sw.js']);
  expect(out['upload']).toBe('refused: a site cannot upload a site');
});

test('e. the site worker can be stopped mid-run: a later lazy request of the same site still works', async ({
  page,
}) => {
  await openPlayground(page);
  await loadSite(
    page,
    moduleSite(
      `root.innerHTML = '<button data-testid="late">load late chunk</button><p data-testid="out"></p>';
root.querySelector('[data-testid="late"]').addEventListener('click', async () => {
  const m = await import('./late-chunk.js');
  const data = await (await fetch('/data.json')).json();
  root.querySelector('[data-testid="out"]').textContent = m.word + ' + ' + data.word;
});`,
      {
        'assets/late-chunk.js': `export const word = 'late chunk';\n`,
        'data.json': '{ "word": "data" }\n',
      },
    ),
  );
  const cdp = await page.context().newCDPSession(page);
  const statuses: string[] = [];
  cdp.on('ServiceWorker.workerVersionUpdated', (e: { versions: { runningStatus: string }[] }) => {
    for (const v of e.versions) statuses.push(v.runningStatus);
  });
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => statuses.at(-1)).toBe('running');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await expect.poll(() => statuses.at(-1)).toBe('stopped');
  statuses.length = 0;

  // The worker starts again for the request, with empty memory: the client -> site map and
  // the site's files come back from Cache Storage.
  await buildFrame(page).getByTestId('late').click();
  await expect(buildFrame(page).getByTestId('out')).toHaveText('late chunk + data');
  expect(statuses).toContain('running');
  expect(await eventsOf(page, 'error')).toEqual([]);
});
