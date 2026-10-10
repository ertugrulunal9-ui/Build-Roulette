import { expect, type Browser, type FrameLocator, type Page } from '@playwright/test';
import type { BootReport, PlaygroundApi } from '../playground/main';

declare global {
  interface Window {
    __playground: PlaygroundApi;
  }
}

/** The user's document lives in the shell's child iframe: preview iframe -> build iframe. */
export function buildFrame(page: Page): FrameLocator {
  return page.frameLocator('#preview').frameLocator('iframe');
}

export async function openPlayground(page: Page): Promise<BootReport> {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  const report = await page.evaluate(() => window.__playground.boot);
  expect(pageErrors).toEqual([]);
  return report;
}

export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? NaN;
}

export function fmt(n: number): string {
  return `${n.toFixed(1)} ms`;
}

/** The OS process ids of every renderer of this browser (app page, preview frame, spares). */
export async function rendererPids(browser: Browser): Promise<number[]> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo: { type: string; id: number }[];
    };
    return processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
  } finally {
    await cdp.detach();
  }
}

/**
 * No renderer of the browser gets any CPU for `ms` (SIGSTOP), as on a machine that gives the
 * tabs no CPU: app pages, their workers and the preview frames alike (T-031, T-041).
 */
export async function freezeRenderers(browser: Browser, ms: number): Promise<void> {
  const pids = await rendererPids(browser);
  expect(pids.length).toBeGreaterThanOrEqual(2); // the app page and the preview frame
  try {
    for (const pid of pids) process.kill(pid, 'SIGSTOP');
    await new Promise((resolve) => setTimeout(resolve, ms));
  } finally {
    for (const pid of pids) process.kill(pid, 'SIGCONT');
  }
}
