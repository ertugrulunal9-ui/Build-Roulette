import { expect, test } from '@playwright/test';
import { tenFileProject } from './fixtures';
import { buildFrame, fmt, openPlayground, percentile } from './helpers';

test('b. editing a file in the playground rebuilds and refreshes the preview', async ({ page }) => {
  await openPlayground(page);
  const frame = buildFrame(page);
  await expect(frame.getByTestId('title')).toHaveText('Hello Build Roulette');

  // Real UI path: type into the textarea -> debounced (150 ms) rebuild -> load -> ready.
  const textarea = page.locator('textarea[data-path="src/App.tsx"]');
  const source = await textarea.inputValue();
  await textarea.fill(source.replace('Hello Build Roulette', 'Edited through the textarea'));
  await expect(frame.getByTestId('title')).toHaveText('Edited through the textarea');
  await expect(frame.getByTestId('title')).toHaveCSS('color', 'rgb(255, 0, 128)');

  // CSS edits rebuild too.
  const css = page.locator('textarea[data-path="src/styles.css"]');
  await css.fill((await css.inputValue()).replace('rgb(255, 0, 128)', 'rgb(0, 128, 0)'));
  await expect(frame.getByTestId('title')).toHaveCSS('color', 'rgb(0, 128, 0)');
});

test('b. rebuild timings over 20 edits of a 10-file project', async ({ page }) => {
  await openPlayground(page);
  const project = tenFileProject('Rebuild 0');
  await page.evaluate(async (p) => {
    await window.__playground.setProject(p.files, p.manifest);
    await window.__playground.buildAndLoad();
  }, project);
  const frame = buildFrame(page);
  await expect(frame.getByTestId('title')).toHaveText('Rebuild 0');

  const buildMs: number[] = [];
  const totalMs: number[] = [];
  const app = project.files['src/App.tsx'] ?? '';
  for (let i = 1; i <= 20; i++) {
    const r = await page.evaluate(
      async ({ src }) => {
        window.__playground.writeFile('src/App.tsx', src);
        return window.__playground.buildAndLoad();
      },
      { src: app.replace('Rebuild 0', `Rebuild ${String(i)}`) },
    );
    expect(r.ok, JSON.stringify(r.diagnostics)).toBe(true);
    await expect(frame.getByTestId('title')).toHaveText(`Rebuild ${String(i)}`);
    buildMs.push(r.buildMs);
    totalMs.push(r.totalMs);
  }
  console.log(
    `[metrics] rebuild (bundler only, 10 files, n=20): p50 ${fmt(percentile(buildMs, 50))}, p95 ${fmt(percentile(buildMs, 95))}`,
  );
  console.log(
    `[metrics] rebuild + preview refresh (build -> ready, 10 files, n=20): p50 ${fmt(percentile(totalMs, 50))}, p95 ${fmt(percentile(totalMs, 95))}`,
  );
  console.log(`[metrics] raw build ms: ${buildMs.map((n) => n.toFixed(0)).join(', ')}`);
  console.log(`[metrics] raw total ms: ${totalMs.map((n) => n.toFixed(0)).join(', ')}`);
  // Budget from docs/03 §3.8 is p50 < 300 ms / p95 < 800 ms on a mid-range laptop; this
  // container is not that, so only a loose sanity bound is asserted here.
  expect(percentile(totalMs, 50)).toBeLessThan(2000);
});

test('worker cold start across 5 fresh browser contexts', async ({ browser }) => {
  const cold: number[] = [];
  const firstPreview: number[] = [];
  for (let i = 0; i < 5; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const r = await openPlayground(page);
    cold.push(r.coldStartMs);
    firstPreview.push(r.firstPreviewMs);
    await context.close();
  }
  console.log(
    `[metrics] worker cold start (n=5, fresh contexts, wasm from localhost): p50 ${fmt(percentile(cold, 50))}, max ${fmt(Math.max(...cold))}`,
  );
  console.log(
    `[metrics] first preview after boot (n=5): p50 ${fmt(percentile(firstPreview, 50))}, max ${fmt(Math.max(...firstPreview))}`,
  );
  console.log(`[metrics] raw cold start ms: ${cold.map((n) => n.toFixed(0)).join(', ')}`);
});
