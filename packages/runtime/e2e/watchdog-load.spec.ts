/**
 * T-027: a slow but finite load on a busy CPU is not a crash (the load grace), while a loop
 * after `ready` is still caught at about 5 s.
 *
 * The shell evaluates every new bundle on its own main thread: tearing down the previous
 * build, writing the new document, then compiling and evaluating the module graph (one long
 * task). Pongs can't be sent during that time. On a contended CPU (the chaos suite: load
 * average 13–24 on 4 CPUs) that took over 5 s, and the old watchdog reported a crash.
 *
 * Here the shell's renderer is slowed with CDP CPU throttling, and the build does a
 * calibrated amount of start-up work at module top level, so that its evaluation blocks the
 * shell for about 8 s (more than the 5 s limit, well within the 15 s grace) on any machine.
 */
import { expect, test, type Frame, type Page } from '@playwright/test';
import { REACT_MANIFEST, reactApp } from './fixtures';
import { buildFrame, fmt, openPlayground } from './helpers';

const THROTTLE_RATE = 6;
/**
 * Calibrated top-level work. The same loop runs about 1.25x slower at module top level than
 * in the calibration (measured), and React plus the bundle add a little, so the shell blocks
 * for about 8–9 s: well over the 5 s limit, well under the 15 s grace.
 */
const TARGET_BLOCK_MS = 6500;
/** The build's top-level start-up work (`timeWork` runs the same loop to calibrate it). */
const WORK = `let h = 0; for (let i = 0; i < n; i++) h = (h * 31 + i) | 0;`;

function shellFrame(page: Page): Frame {
  const frame = page.frames().find((f) => /^http:\/\/127\.0\.0\.1:\d+\/v1\/$/.test(f.url()));
  if (!frame) throw new Error('shell frame not found');
  return frame;
}

/** ms for `n` iterations of WORK in the shell's (throttled) realm. */
async function timeWork(frame: Frame, n: number): Promise<number> {
  return frame.evaluate((n) => {
    const t0 = performance.now();
    // The same loop as WORK (the shell's CSP has no 'unsafe-eval', so WORK can't be eval'd).
    let h = 0;
    for (let i = 0; i < n; i++) h = (h * 31 + i) | 0;
    (window as unknown as { __h: number }).__h = h;
    return performance.now() - t0;
  }, n);
}

/** A React app whose module top level does `iterations` of WORK, plus a bundle to compile. */
function heavyApp(iterations: number) {
  const fns = Array.from(
    { length: 3000 },
    (_, i) => `(a: number) => ({ k: a * ${String(i)}, s: 'v${String(i)}' }).k,`,
  ).join('\n');
  const prelude = `
const evalStart = Date.now();
const fns: ((a: number) => number)[] = [
${fns}
];
const n = ${String(iterations)};
${WORK}
const total = fns.reduce((acc, f) => acc + f(1), h);
console.log('heavy-eval ' + String(Date.now() - evalStart) + ' ' + String(total));
`;
  return reactApp(
    `<main>
      <h1 data-testid="title">heavy but finite</h1>
      <button className="freeze" onClick={() => { setTimeout(() => { console.log('loop-start'); for (;;) {} }, 300); }}>Freeze</button>
    </main>`,
    prelude,
  );
}

test('a slow load under CPU throttling is not a crash; a loop after ready is still caught at ~5 s', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await openPlayground(page);
  const shell = shellFrame(page);

  // Slow down the sandbox renderer (the preview is out of process: its own CDP target).
  const before = await timeWork(shell, 2e6);
  const cdp = await page.context().newCDPSession(shell);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE_RATE });
  // Calibrate under the throttle: iterations for a TARGET_BLOCK_MS top-level evaluation.
  const probeN = 3e7; // about 1 s under the throttle: short samples are noisy
  const probeMs = await timeWork(shell, probeN);
  const iterations = Math.round((probeN * TARGET_BLOCK_MS) / probeMs);
  console.log(
    `[metrics] CPU throttle x${String(THROTTLE_RATE)}: 2e6 iterations ${fmt(before)} -> ${fmt((probeMs * 2e6) / probeN)}; build does ${iterations.toExponential(2)} iterations`,
  );

  // App side: the gaps between accepted pongs, as the watchdog sees them.
  await page.evaluate(() => {
    const w = window as unknown as { __pongGaps: number[] };
    w.__pongGaps = [];
    let lastPong = window.__playground.previewStats().lastPongAt;
    setInterval(() => {
      const at = window.__playground.previewStats().lastPongAt;
      if (at !== lastPong) {
        w.__pongGaps.push(at - lastPong);
        lastPong = at;
      }
    }, 25);
  });
  // Shell side: its main-thread long tasks.
  await shell.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] };
    w.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longTasks.push(e.duration);
    }).observe({ type: 'longtask' });
  });

  // Build and load; stop early if the watchdog fires (the old 5 s watchdog did, here).
  const outcome = await page.evaluate(
    async ({ files, manifest }) => {
      await window.__playground.setProject(files, manifest);
      const crashed = new Promise<{ crash: unknown }>((resolve) => {
        const poll = setInterval(() => {
          const c = window.__playground.events.find((e) => e.type === 'crash');
          if (c) {
            clearInterval(poll);
            resolve({ crash: c.data });
          }
        }, 50);
      });
      return Promise.race([
        window.__playground.buildAndLoad().then((loaded) => ({ loaded })),
        crashed,
      ]);
    },
    { files: heavyApp(iterations), manifest: REACT_MANIFEST },
  );
  if ('crash' in outcome) {
    throw new Error(`the watchdog fired during the slow load: ${JSON.stringify(outcome.crash)}`);
  }
  const loaded = outcome.loaded;
  expect(loaded.ok).toBe(true);
  await expect(buildFrame(page).getByTestId('title')).toHaveText('heavy but finite');
  await page.waitForTimeout(1500); // a few normal pongs after the load

  const evalLog = await page.evaluate(
    () =>
      window.__playground.events.find(
        (e) => e.type === 'console' && JSON.stringify(e.data).includes('heavy-eval'),
      )?.data as { args: string[] } | undefined,
  );
  const evalMs = Number(evalLog?.args[0]?.split(' ')[1]);
  const maxPongGap = await page.evaluate(() =>
    Math.max(...(window as unknown as { __pongGaps: number[] }).__pongGaps),
  );
  const longestTask = await shell.evaluate(() =>
    Math.max(0, ...(window as unknown as { __longTasks: number[] }).__longTasks),
  );
  console.log(
    `[metrics] slow load: build -> ready ${fmt(loaded.totalMs)}, top-level evaluation ${fmt(evalMs)}, longest shell task ${fmt(longestTask)}, longest pong gap ${fmt(maxPongGap)}`,
  );
  // The shell really was silent for longer than the 5 s limit (the old watchdog crashed here)…
  expect(maxPongGap).toBeGreaterThan(5500);
  expect(longestTask).toBeGreaterThan(5000);
  // …but within the grace, and the preview is fine.
  expect(maxPongGap).toBeLessThan(15_000);
  expect(
    await page.evaluate(() => window.__playground.events.some((e) => e.type === 'crash')),
  ).toBe(false);
  expect(await page.evaluate(() => window.__playground.previewState())).toBe('connected');

  // After ready the limit is back to 5 s: a loop is caught as before (still throttled).
  await buildFrame(page).locator('button.freeze').click();
  const marker = await page.waitForFunction(() =>
    window.__playground.events.find(
      (e) => e.type === 'console' && JSON.stringify(e.data).includes('loop-start'),
    ),
  );
  const loopStartAt = ((await marker.jsonValue()) as { t: number }).t;
  const crash = await page.waitForFunction(
    () => window.__playground.events.find((e) => e.type === 'crash'),
    null,
    { timeout: 10_000 },
  );
  const crashEvent = (await crash.jsonValue()) as {
    t: number;
    data: { reason: string; silentForMs: number; phase: string };
  };
  const detectionMs = crashEvent.t - loopStartAt;
  console.log(
    `[metrics] loop after a slow load: detection ${fmt(detectionMs)}, silence ${fmt(crashEvent.data.silentForMs)}, phase ${crashEvent.data.phase}`,
  );
  expect(crashEvent.data).toMatchObject({ reason: 'heartbeat-timeout', phase: 'running' });
  expect(detectionMs).toBeGreaterThanOrEqual(3900);
  expect(detectionMs).toBeLessThanOrEqual(6000);
});
