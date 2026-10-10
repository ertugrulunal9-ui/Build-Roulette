/**
 * T-031: a starved machine is not a crash, while a loop in the build is still caught.
 *
 * In the chaos suite (6 browsers on 4 CPUs), a preview whose build did not loop was reported
 * as `heartbeat-timeout silentMs=5309 phase=running` right at the start of BUILD. That
 * player's own app page had not run for about 5 s (the DevTools events of her page stopped;
 * the other five pages got the same broadcast on time). The watchdog measured silence on the
 * wall clock, but while the app page itself gets no CPU it can neither send pings nor
 * receive pongs, so the silence measured the app's starvation, not the build. Since T-031 it
 * counts app-awake time: a watchdog tick advances its clock by at most one interval.
 *
 * Both tests starve the app page AND the preview frame together, then check that a loop is
 * still caught:
 * 1. every renderer process of the browser is stopped (SIGSTOP) for 7 s, under CDP CPU
 *    throttling of both pages: nothing runs, as on a machine that gives the tab no CPU;
 * 2. both pages are CPU-throttled and both run long tasks at once, calibrated so that the
 *    app page's main thread is blocked for about 6.5 s and the frame's for about 3 s.
 * The old watchdog crashes in both (checked: `heartbeat-timeout`, silence 7.4 s / 6.6 s).
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { REACT_MANIFEST, reactApp } from './fixtures';
import { buildFrame, fmt, freezeRenderers, openPlayground } from './helpers';

const THROTTLE_RATE = 6;

interface CrashEvent {
  t: number;
  data: {
    reason: string;
    phase: string;
    silentForMs: number;
    wallSilentForMs: number;
    stalledMs: number;
    longestStallMs: number;
  };
}

function shellFrame(page: Page): Frame {
  const frame = page.frames().find((f) => /^http:\/\/127\.0\.0\.1:\d+\/v1\/$/.test(f.url()));
  if (!frame) throw new Error('shell frame not found');
  return frame;
}

/** CDP CPU throttling of the app page and of the (out-of-process) preview frame. */
async function throttleBoth(page: Page, rate: number): Promise<void> {
  for (const target of [page, shellFrame(page)]) {
    const cdp = await page.context().newCDPSession(target);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  }
}

/** A calm React build with a button that starts an infinite loop 300 ms after a click. */
async function loadCalmBuild(page: Page): Promise<void> {
  const loaded = await page.evaluate(
    async ({ files, manifest }) => {
      await window.__playground.setProject(files, manifest);
      return window.__playground.buildAndLoad();
    },
    {
      files: reactApp(
        `<main>
          <h1 data-testid="title">calm build</h1>
          <button className="freeze" onClick={() => { setTimeout(() => { console.log('loop-start'); for (;;) {} }, 300); }}>Freeze</button>
        </main>`,
      ),
      manifest: REACT_MANIFEST,
    },
  );
  expect(loaded.ok).toBe(true);
  await expect(buildFrame(page).getByTestId('title')).toHaveText('calm build');
  await page.waitForTimeout(1500); // a few normal pongs
}

async function crashes(page: Page): Promise<CrashEvent[]> {
  return page.evaluate(
    () => window.__playground.events.filter((e) => e.type === 'crash') as unknown as CrashEvent[],
  );
}

/** No crash so far: the build never looped (the pre-T-031 watchdog fails here). */
async function expectNoCrash(page: Page): Promise<void> {
  const found = await crashes(page);
  expect(found, `false crash under starvation: ${JSON.stringify(found[0]?.data)}`).toEqual([]);
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');
}

/** Clicks the build's Freeze button; resolves with the time the loop started (app clock). */
async function startLoop(page: Page): Promise<number> {
  await buildFrame(page).locator('button.freeze').click();
  const marker = await page.waitForFunction(() =>
    window.__playground.events.find(
      (e) => e.type === 'console' && JSON.stringify(e.data).includes('loop-start'),
    ),
  );
  return ((await marker.jsonValue()) as { t: number }).t;
}

async function waitForCrash(page: Page, timeout: number): Promise<CrashEvent> {
  const crash = await page.waitForFunction(
    () => window.__playground.events.find((e) => e.type === 'crash'),
    null,
    { timeout },
  );
  return (await crash.jsonValue()) as CrashEvent;
}

test('whole-browser starvation (every renderer stopped for 7 s, both pages throttled) is not a crash; a loop is still caught', async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  await openPlayground(page);
  await loadCalmBuild(page);
  await throttleBoth(page, THROTTLE_RATE);
  await page.waitForTimeout(1000);

  const frozeAt = Date.now();
  await freezeRenderers(browser, 7000);
  const frozeMs = Date.now() - frozeAt;
  await page.waitForTimeout(3000); // pings and pongs resume
  await expectNoCrash(page);
  const stats = await page.evaluate(() => window.__playground.previewStats());
  console.log(
    `[metrics] all renderers stopped for ${fmt(frozeMs)} (throttle x${String(THROTTLE_RATE)}): no crash; app stalls ${String(stats.stalls)}, longest ${fmt(stats.longestStallMs)}, silences the wall-clock rule would have crashed on ${String(stats.sparedSilences)}`,
  );
  // The app saw its own stall, and the old wall-clock watchdog would have crashed here.
  expect(stats.longestStallMs).toBeGreaterThan(6000);
  expect(stats.sparedSilences).toBeGreaterThanOrEqual(1);

  // A real loop, still on the throttled CPU, with a whole-browser stop in the middle of its
  // silence: caught after about 5 s of app-awake time.
  const loopStartAt = await startLoop(page);
  await page.waitForTimeout(1500);
  await freezeRenderers(browser, 3000);
  const crash = await waitForCrash(page, 10_000);
  const detectionMs = crash.t - loopStartAt;
  console.log(
    `[metrics] loop with a 3 s stop in its silence: detection ${fmt(detectionMs)} (wall), silence ${fmt(crash.data.silentForMs)} awake / ${fmt(crash.data.wallSilentForMs)} wall, stalled ${fmt(crash.data.stalledMs)}, longest stall ${fmt(crash.data.longestStallMs)}`,
  );
  expect(crash.data).toMatchObject({ reason: 'heartbeat-timeout', phase: 'running' });
  expect(crash.data.silentForMs).toBeGreaterThan(5000);
  expect(crash.data.silentForMs).toBeLessThanOrEqual(5600);
  expect(crash.data.stalledMs).toBeGreaterThan(2500);
  // Wall clock: 4.0–5.25 s of awake time after the loop started, plus the 3 s stop, less
  // the up to 300 ms (one tick + jitter) of awake time the first tick after the stop
  // credits: at least 4000 + 3000 - 300 = 6700 ms (6899 ms was seen once against an older,
  // too tight 6900 ms bound).
  expect(detectionMs).toBeGreaterThanOrEqual(6700);
  expect(detectionMs).toBeLessThanOrEqual(9500);
  await expect(page.locator('#preview')).toHaveCount(0);
});

/** ms for `n` iterations of a busy loop in `target`'s (throttled) realm. */
async function timeWork(target: Page | Frame, n: number): Promise<number> {
  return target.evaluate((n) => {
    const t0 = performance.now();
    let h = 0;
    for (let i = 0; i < n; i++) h = (h * 31 + i) | 0;
    (window as unknown as { __h: number }).__h = h;
    return performance.now() - t0;
  }, n);
}

/** Iterations for a `targetMs` busy loop in `target` (calibrated under its throttle). */
async function calibrate(target: Page | Frame, targetMs: number): Promise<number> {
  const probeN = 2e7;
  const probeMs = await timeWork(target, probeN);
  return Math.round((probeN * targetMs) / probeMs);
}

test('throttled app page and frame both blocked by long tasks (6.5 s / 7.5 s) is not a crash; a loop is still caught', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openPlayground(page);
  await loadCalmBuild(page);
  await throttleBoth(page, THROTTLE_RATE);
  const shell = shellFrame(page);
  const appN = await calibrate(page, 6500);
  const frameN = await calibrate(shell, 7500);
  await page.waitForTimeout(1500);

  // The build's work and the app's own, both stretched by the slow CPU, overlapping: neither
  // main thread runs a timer meanwhile. The frame starts first (so no pong can be waiting
  // for the app when it resumes) and ends about a second after the app.
  // (A crash takes the frame out of the page, which ends its evaluation.)
  const frameWork = timeWork(shell, frameN).catch(() => NaN);
  await page.waitForTimeout(200);
  const [appMs, frameMs] = await Promise.all([timeWork(page, appN), frameWork]);
  await page.waitForTimeout(3000);
  await expectNoCrash(page);
  const stats = await page.evaluate(() => window.__playground.previewStats());
  console.log(
    `[metrics] long tasks under throttle x${String(THROTTLE_RATE)}: app ${fmt(appMs)}, frame ${fmt(frameMs)}; no crash; app stalls ${String(stats.stalls)}, longest ${fmt(stats.longestStallMs)}, spared ${String(stats.sparedSilences)}`,
  );
  expect(appMs).toBeGreaterThan(5500);
  expect(frameMs).toBeGreaterThan(appMs);
  expect(stats.longestStallMs).toBeGreaterThan(5000);
  expect(stats.sparedSilences).toBeGreaterThanOrEqual(1);

  // A real loop on the same throttled CPU, the app's timers on time: caught as before.
  const loopStartAt = await startLoop(page);
  const crash = await waitForCrash(page, 10_000);
  const detectionMs = crash.t - loopStartAt;
  console.log(
    `[metrics] loop after the long tasks: detection ${fmt(detectionMs)}, silence ${fmt(crash.data.silentForMs)} awake / ${fmt(crash.data.wallSilentForMs)} wall`,
  );
  expect(crash.data).toMatchObject({ reason: 'heartbeat-timeout', phase: 'running' });
  expect(detectionMs).toBeGreaterThanOrEqual(3900);
  expect(detectionMs).toBeLessThanOrEqual(6000);
});
