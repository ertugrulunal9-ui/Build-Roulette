import { expect, type FrameLocator, type Page } from '@playwright/test';
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
