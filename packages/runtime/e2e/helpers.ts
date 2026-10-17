import { expect, type Browser, type Frame, type FrameLocator, type Page } from '@playwright/test';
import type { RunMode } from '@br/protocol';
import type { BootReport, LoadReport, PlaygroundApi, SiteSpec } from '../playground/main';

declare global {
  interface Window {
    __playground: PlaygroundApi;
  }
}

export const SHELL_ORIGIN = `http://127.0.0.1:${process.env['SHELL_PORT'] ?? '4311'}`;
export const SHELL_URL = `${SHELL_ORIGIN}/v2/`;
export const OTHER_ORIGIN = `http://localhost:${process.env['OTHER_PORT'] ?? '4312'}`;

/** The site lives in the shell's child iframe: preview iframe -> site iframe. */
export function buildFrame(page: Page): FrameLocator {
  return page.frameLocator('#preview').frameLocator('iframe');
}

/** The shell's frame (the preview iframe's document). */
export function shellFrame(page: Page): Frame {
  const frame = page.frames().find((f) => f.url() === SHELL_URL);
  if (!frame) throw new Error('shell frame not found');
  return frame;
}

/** The site's frame (the shell's child frame), as a Playwright Frame. */
export function siteFrame(page: Page): Frame {
  const shell = shellFrame(page);
  const frame = shell.childFrames()[0];
  if (!frame) throw new Error('site frame not found');
  return frame;
}

export async function openPlayground(page: Page): Promise<BootReport> {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto('/');
  const report = await page.evaluate(() => window.__playground.boot);
  expect(pageErrors).toEqual([]);
  return report;
}

/** Loads a site (text files) into the preview and waits for its `ready`. */
export async function loadSite(page: Page, files: SiteSpec, mode?: RunMode): Promise<LoadReport> {
  return page.evaluate(
    ({ files, mode }) => {
      if (mode) window.__playground.setMode(mode);
      return window.__playground.loadSite(files);
    },
    { files, mode },
  );
}

/** Event payloads of one type the playground recorded. */
export async function eventsOf(page: Page, type: string): Promise<unknown[]> {
  return page.evaluate(
    (type) => window.__playground.events.filter((e) => e.type === type).map((e) => e.data),
    type,
  );
}

/** Console lines the app received from the site (`level: args…`). */
export async function consoleLines(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    window.__playground.events
      .filter((e) => e.type === 'console')
      .map((e) => {
        const d = e.data as { level: string; args: string[] };
        return `${d.level}: ${d.args.join(' ')}`;
      }),
  );
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
