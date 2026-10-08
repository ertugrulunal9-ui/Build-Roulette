/**
 * T-031 reproduction (draft): starve the whole browser (app page + preview frame) and see
 * whether the watchdog reports a crash for a build that does not loop.
 */
import { expect, test, type Browser, type Frame, type Page } from '@playwright/test';
import { REACT_MANIFEST, reactApp } from './fixtures';
import { fmt, openPlayground } from './helpers';

function shellFrame(page: Page): Frame {
  const frame = page.frames().find((f) => /^http:\/\/127\.0\.0\.1:\d+\/v1\/$/.test(f.url()));
  if (!frame) throw new Error('shell frame not found');
  return frame;
}

async function rendererPids(browser: Browser): Promise<number[]> {
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: { type: string; id: number }[];
  };
  await cdp.detach();
  return processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
}

test('repro: whole-browser starvation (SIGSTOP all renderers 7 s)', async ({ page, browser }) => {
  test.setTimeout(60_000);
  await openPlayground(page);
  const loaded = await page.evaluate(
    async ({ files, manifest }) => {
      await window.__playground.setProject(files, manifest);
      return window.__playground.buildAndLoad();
    },
    { files: reactApp(`<h1 data-testid="title">calm</h1>`), manifest: REACT_MANIFEST },
  );
  expect(loaded.ok).toBe(true);
  const shell = shellFrame(page);
  for (const target of [page, shell]) {
    const cdp = await page.context().newCDPSession(target);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await page.waitForTimeout(2000);
  const pids = await rendererPids(browser);
  console.log(`[repro] renderer pids ${pids.join(',')}`);
  const t0 = Date.now();
  for (const pid of pids) process.kill(pid, 'SIGSTOP');
  await new Promise((r) => setTimeout(r, 7000));
  for (const pid of pids) process.kill(pid, 'SIGCONT');
  console.log(`[repro] froze for ${fmt(Date.now() - t0)}`);
  await page.waitForTimeout(3000);
  const crash = await page.evaluate(
    () => window.__playground.events.find((e) => e.type === 'crash')?.data ?? null,
  );
  console.log(`[repro] crash: ${JSON.stringify(crash)}`);
  console.log(`[repro] stats: ${JSON.stringify(await page.evaluate(() => window.__playground.previewStats()))}`);
});
