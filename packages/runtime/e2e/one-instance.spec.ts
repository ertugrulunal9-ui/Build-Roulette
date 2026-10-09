import { expect, test, type Page, type Response } from '@playwright/test';
import type { FileMap, Manifest } from '../src/types';
import { buildFrame, openPlayground } from './helpers';

/**
 * T-040: one instance per manifest package and a fully pinned template, on both CDN shapes.
 *
 * CI run 60 (the compatibility suite against the public esm.sh) showed esm.sh importing a
 * package's own dependencies by range (`/chart.js@^4.1.1?target=es2022`, cached 10 minutes):
 * a second chart.js under react-chartjs-2, a second three under @react-three/fiber, and React
 * DOM's `scheduler` outside the template's immutable set. The mock CDN's `esm.sh` layout does
 * the same with fixture packages (`test-support/fixture-packages`, a newer version than the
 * manifest pins is available), so these checks fail without the runtime's externals and
 * import map entries. They run in both configs: `playwright.config.ts` (the mock in the
 * @br/pkg-cdn shape) and `playwright.esm-sh.config.ts`.
 */

const CDN_ORIGIN = `http://localhost:${process.env['CDN_PORT'] ?? '4312'}`;
const REACT = { react: '19.3.0', 'react-dom': '19.3.0' };
/** Long enough to outlast a CDN outage (apps/pkg-cdn/compat/contract.ts). */
const MIN_MAX_AGE = 30 * 24 * 3600;

const MAIN = `import { createRoot } from 'react-dom/client';
import { App } from './App';
createRoot(document.getElementById('root')!).render(<App />);
`;

/** Every response from the CDN origin while the page is open. */
function recordCdn(page: Page): { url: string; status: number; cacheControl: string }[] {
  const seen: { url: string; status: number; cacheControl: string }[] = [];
  page.on('response', (r: Response) => {
    if (!r.url().startsWith(`${CDN_ORIGIN}/`)) return;
    seen.push({
      // Decoded: Chromium sends a range's `^` as %5E.
      url: decodeURIComponent(r.url().slice(CDN_ORIGIN.length)),
      status: r.status(),
      cacheControl: r.headers()['cache-control'] ?? '',
    });
  });
  return seen;
}

function maxAge(cacheControl: string): number {
  return Number(/(?:^|[,\s])max-age=(\d+)/.exec(cacheControl)?.[1] ?? 0);
}

/** A version in the path that is not exact (`/pkg@^1.0.0`): a module the CDN resolves itself. */
function isRangeUrl(url: string): boolean {
  return /^\/(?:@[^/]+\/)?[^/@]+@[~^<>=*x|]/.test(url);
}

async function run(page: Page, files: FileMap, manifest: Manifest): Promise<void> {
  const r = await page.evaluate(
    async ({ files, manifest }) => {
      const pg = window.__playground;
      const from = pg.events.length;
      await pg.setProject(files, manifest);
      const built = await pg.buildAndLoad();
      return {
        ok: built.ok,
        diagnostics: built.diagnostics,
        problems: pg.events
          .slice(from)
          .filter((e) => e.type === 'error' || e.type === 'crash')
          .map((e) => e.data),
      };
    },
    { files, manifest },
  );
  expect(r).toEqual({ ok: true, diagnostics: [], problems: [] });
}

test('one three: fiber-like package, its three subpath and the app share the pinned instance', async ({
  page,
}) => {
  const cdn = recordCdn(page);
  await openPlayground(page);
  await run(
    page,
    {
      'src/main.tsx': MAIN,
      'src/App.tsx': `import { Scene, VERSION } from 'br-fixture-three';
import { Controls } from 'br-fixture-three/examples/controls.js';
import { createControls, createScene, threeVersion, utilLabel } from '@br-fixture/fiber';
export function App() {
  const controls = createControls(new Scene());
  const checks = [
    createScene() instanceof Scene, // fiber's three is the app's three
    controls instanceof Controls, // the subpath fiber imports (import map prefix) is the app's
    controls.ok, // and that subpath's own three is the one three
    threeVersion === VERSION && VERSION === '1.0.0', // the manifest's pin, not ^1.0.0's newest
  ];
  return <div data-testid="marker">{checks.join(',')}|{utilLabel}</div>;
}
`,
    },
    {
      entry: 'src/main.tsx',
      dependencies: { ...REACT, 'br-fixture-three': '1.0.0', '@br-fixture/fiber': '1.0.0' },
    },
  );
  // fiber's own dependency, which the manifest does not list, is the newest match (1.0.1).
  await expect(buildFrame(page).getByTestId('marker')).toHaveText(
    'true,true,true,true|fiber+util@1.0.1',
  );
  // Manifest packages only load from exact, immutable URLs. The one short-lived URL allowed
  // is a dependency the manifest does not list (esm.sh layout: a range, 10 minutes).
  const short = cdn.filter((r) => maxAge(r.cacheControl) < MIN_MAX_AGE).map((r) => r.url);
  for (const url of short) expect(url).toMatch(/^\/@br-fixture\/util@\^1\.0\.0\?/);
  expect(cdn.map((r) => r.url).filter((u) => u.includes('br-fixture-three@1.1.0'))).toEqual([]);
});

test('one chart-like singleton: what the app registers is what the React wrapper reads', async ({
  page,
}) => {
  const cdn = recordCdn(page);
  await openPlayground(page);
  await run(
    page,
    {
      'src/main.tsx': MAIN,
      'src/App.tsx': `import { register } from '@br-fixture/chart';
import { Chart } from '@br-fixture/react-chart';
register('category', { kind: 'scale' });
export function App() {
  return <Chart scale="category" />;
}
`,
    },
    {
      entry: 'src/main.tsx',
      dependencies: { ...REACT, '@br-fixture/chart': '1.0.0', '@br-fixture/react-chart': '1.0.0' },
    },
  );
  // Two instances would read "\"category\" is not a registered scale" (CI run 60, chart.js).
  await expect(buildFrame(page).getByTestId('chart')).toHaveText('scale category from chart 1.0.0');
  for (const r of cdn) expect(maxAge(r.cacheControl), r.url).toBeGreaterThanOrEqual(MIN_MAX_AGE);
});

test('the template is fully pinned: every module behind it is an exact, immutable URL', async ({
  page,
}) => {
  const cdn = recordCdn(page);
  // The shell warms the whole import map 1 s after `ready`, scheduler included.
  const warmed = page.waitForEvent('requestfinished', {
    predicate: (r) => r.url().startsWith(`${CDN_ORIGIN}/scheduler@0.28.0`),
    timeout: 20_000,
  });
  await openPlayground(page);
  await run(
    page,
    {
      'src/main.tsx': MAIN,
      'src/App.tsx': `import { useState } from 'react';
export function App() {
  const [n, setN] = useState(0);
  return <button data-testid="inc" onClick={() => setN(n + 1)}>count {n}</button>;
}
`,
    },
    { entry: 'src/main.tsx', dependencies: REACT },
  );
  await buildFrame(page).getByTestId('inc').click();
  await expect(buildFrame(page).getByTestId('inc')).toHaveText('count 1');
  await warmed;
  await page.waitForTimeout(500);
  const react = cdn.filter((r) => /^\/(?:react|react-dom|scheduler)@/.test(r.url));
  expect(react.length).toBeGreaterThanOrEqual(6);
  for (const r of react) {
    expect(r.status, r.url).toBe(200);
    expect(isRangeUrl(r.url), r.url).toBe(false);
    expect(maxAge(r.cacheControl), `${r.url}: ${r.cacheControl}`).toBeGreaterThanOrEqual(
      MIN_MAX_AGE,
    );
  }
  // React DOM's scheduler came from its pinned URL (and, on the esm.sh layout, the internal
  // build path behind it), never from a range.
  expect(react.some((r) => r.url.startsWith('/scheduler@0.28.0'))).toBe(true);
  expect(cdn.filter((r) => isRangeUrl(r.url))).toEqual([]);
});
