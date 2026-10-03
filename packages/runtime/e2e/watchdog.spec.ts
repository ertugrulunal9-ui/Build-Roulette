import { expect, test } from '@playwright/test';
import { REACT_MANIFEST, reactApp } from './fixtures';
import { buildFrame, fmt, openPlayground } from './helpers';

test('c. an infinite loop triggers the watchdog crash within 6 s and the parent stays responsive', async ({
  page,
}) => {
  await openPlayground(page);
  // Precondition: the preview runs in its own renderer process (site isolation). Without it
  // the loop blocks the app's own thread and no JS watchdog can run (see README).
  const cdp = await page.context().newCDPSession(page);
  const { targetInfos } = (await cdp.send('Target.getTargets')) as {
    targetInfos: { type: string; url: string }[];
  };
  expect(
    targetInfos.filter((t) => t.type === 'iframe').map((t) => t.url),
    'preview iframe must be out-of-process',
  ).toEqual([expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/v1\/$/)]);

  // Parent-side jank probe: records the worst gap between 50 ms ticks on the app page.
  await page.evaluate(() => {
    const w = window as unknown as { __maxGap: number; __probe: ReturnType<typeof setInterval> };
    let last = performance.now();
    w.__maxGap = 0;
    w.__probe = setInterval(() => {
      const now = performance.now();
      w.__maxGap = Math.max(w.__maxGap, now - last);
      last = now;
    }, 50);
  });

  const files = reactApp(
    `<h1 data-testid="title">about to freeze</h1>`,
    `setTimeout(() => { console.log('loop-start'); while (true) {} }, 300);`,
  );
  const loaded = await page.evaluate(
    async ({ files, manifest }) => {
      await window.__playground.setProject(files, manifest);
      return window.__playground.buildAndLoad();
    },
    { files, manifest: REACT_MANIFEST },
  );
  expect(loaded.ok).toBe(true);
  // The build logs right before it starts spinning; the port message still gets out.
  const marker = await page.waitForFunction(() =>
    window.__playground.events.find(
      (e) => e.type === 'console' && JSON.stringify(e.data).includes('loop-start'),
    ),
  );
  const loopStartAt = ((await marker.jsonValue()) as { t: number }).t;

  // While the sandbox spins: the app page answers quickly and its UI still works.
  await page.waitForTimeout(1500);
  const rtt: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await page.evaluate(() => 1 + 1);
    rtt.push(Date.now() - t0);
  }
  await page.locator('#status').click();
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');

  const crash = await page.waitForFunction(
    () => window.__playground.events.find((e) => e.type === 'crash'),
    null,
    { timeout: 10_000 },
  );
  const crashEvent = (await crash.jsonValue()) as {
    t: number;
    data: { reason: string; silentForMs: number };
  };
  const detectionMs = crashEvent.t - loopStartAt;
  const maxGap = await page.evaluate(() => (window as unknown as { __maxGap: number }).__maxGap);
  console.log(
    `[metrics] watchdog detection (loop start -> crash event): ${fmt(detectionMs)}; reported silence ${fmt(crashEvent.data.silentForMs)}`,
  );
  console.log(
    `[metrics] parent page during the loop: evaluate RTT max ${String(Math.max(...rtt))} ms, worst 50ms-timer gap ${fmt(maxGap)}`,
  );

  expect(crashEvent.data.reason).toBe('heartbeat-timeout');
  expect(detectionMs).toBeLessThanOrEqual(6000);
  expect(detectionMs).toBeGreaterThanOrEqual(3900); // 5 s after the last heartbeat (sent <= 1 s before the loop)
  expect(Math.max(...rtt)).toBeLessThan(500);
  expect(maxGap).toBeLessThan(500);
  // The frozen iframe is gone and the UI says so.
  await expect(page.locator('#preview')).toHaveCount(0);
  await expect(page.locator('#crashed')).toContainText('Build froze');
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('crashed');

  // Restart preview with a fixed build: works again.
  await page.evaluate(
    async ({ files, manifest }) => {
      await window.__playground.setProject(files, manifest);
      await window.__playground.restartPreview();
      await window.__playground.buildAndLoad();
    },
    { files: reactApp(`<h1 data-testid="title">recovered</h1>`), manifest: REACT_MANIFEST },
  );
  await expect(buildFrame(page).getByTestId('title')).toHaveText('recovered');
});

test('c. a loop that runs on load (before ready) is also caught', async ({ page }) => {
  await openPlayground(page);
  const t0 = await page.evaluate(
    async ({ files, manifest }) => {
      await window.__playground.setProject(files, manifest);
      const start = performance.now();
      void window.__playground.buildAndLoad().catch(() => undefined);
      return start;
    },
    { files: reactApp(`<p>never</p>`, `while (true) {}`), manifest: REACT_MANIFEST },
  );
  const crash = await page.waitForFunction(
    () => window.__playground.events.find((e) => e.type === 'crash'),
    null,
    { timeout: 10_000 },
  );
  const crashEvent = (await crash.jsonValue()) as { t: number };
  console.log(
    `[metrics] watchdog detection for a loop at module top level (build start -> crash): ${fmt(crashEvent.t - t0)}`,
  );
  expect(crashEvent.t - t0).toBeLessThan(7000);
  await expect(page.locator('#preview')).toHaveCount(0);
});
